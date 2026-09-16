/**
 * WI03 response diff: upstream-scripted vs client-received.
 *
 * Header verdicts: PRESERVED_UNCHANGED | CHANGED_BY_GOROUTER |
 * REMOVED_BY_GOROUTER | ADDED_BY_GOROUTER | TRANSPORT_DERIVED | REDACTED |
 * ABSENT_BOTH.
 * JSON verdicts: BYTE_IDENTICAL | SEMANTICALLY_IDENTICAL | CHANGED.
 * SSE verdicts: LOGICAL_BYTES_IDENTICAL | LOGICAL_BYTES_CHANGED |
 * SSE_EVENT_SEQUENCE_IDENTICAL | SSE_EVENT_SEQUENCE_CHANGED, plus
 * TRANSPORT_CHUNKING_IDENTICAL | TRANSPORT_CHUNKING_DIFFERENT (informational;
 * never a content failure).
 */
import { isSensitiveHeaderName, redactHeaderValue } from "./redaction.ts";
import { canonicalJson, flattenPaths, sha256Hex } from "./normalize.ts";
import { parseSSE, eventsEqual, canonicalEvent } from "./sse.ts";

/** Runtime-managed framing: never an application rewrite without evidence. */
const RESPONSE_TRANSPORT = new Set([
  "date",
  "server",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "content-encoding",
]);

export type ResponseHeaderVerdict =
  | "PRESERVED_UNCHANGED"
  | "CHANGED_BY_GOROUTER"
  | "REMOVED_BY_GOROUTER"
  | "ADDED_BY_GOROUTER"
  | "TRANSPORT_DERIVED"
  | "REDACTED"
  | "ABSENT_BOTH";

export interface ResponseHeaderDiff {
  header: string;
  upstream: string | null;
  client: string | null;
  verdict: ResponseHeaderVerdict;
  detail: string;
}

function lowerMap(rec: Record<string, string>): Map<string, string> {
  const m = new Map<string, string>();
  for (const [k, v] of Object.entries(rec)) {
    if (!m.has(k.toLowerCase())) m.set(k.toLowerCase(), v);
  }
  return m;
}

export function classifyResponseHeader(
  lower: string,
  upstream: string | undefined,
  client: string | undefined,
): { verdict: ResponseHeaderVerdict; detail: string } {
  if (isSensitiveHeaderName(lower)) {
    if (upstream === undefined && client === undefined) return { verdict: "ABSENT_BOTH", detail: "absent both sides" };
    if (upstream === undefined) return { verdict: "REDACTED", detail: "present client only (redacted)" };
    if (client === undefined) return { verdict: "REDACTED", detail: "present upstream only (redacted)" };
    return { verdict: "REDACTED", detail: "present both sides (values redacted; presence/scheme only)" };
  }
  if (upstream === undefined && client === undefined) return { verdict: "ABSENT_BOTH", detail: "absent both sides" };
  if (upstream === undefined) {
    if (RESPONSE_TRANSPORT.has(lower)) return { verdict: "TRANSPORT_DERIVED", detail: "added by HTTP runtime framing" };
    return { verdict: "ADDED_BY_GOROUTER", detail: "present client only" };
  }
  if (client === undefined) {
    if (RESPONSE_TRANSPORT.has(lower)) return { verdict: "TRANSPORT_DERIVED", detail: "stripped by design (framing recomputed downstream)" };
    return { verdict: "REMOVED_BY_GOROUTER", detail: "present upstream only" };
  }
  if (upstream === client) return { verdict: "PRESERVED_UNCHANGED", detail: "byte-identical" };
  return { verdict: "CHANGED_BY_GOROUTER", detail: "value differs" };
}

/** Tracked response headers (§14) plus every header observed either side. */
export const TRACKED_RESPONSE_HEADERS = [
  "content-type",
  "content-length",
  "transfer-encoding",
  "connection",
  "cache-control",
  "x-request-id",
  "x-wi03-upstream",
  "retry-after",
  "x-ratelimit-limit-requests",
  "x-ratelimit-remaining-requests",
  "x-ratelimit-reset-requests",
  "server",
  "date",
] as const;

export function diffResponseHeaders(
  upstreamRec: Record<string, string>,
  clientRec: Record<string, string>,
): ResponseHeaderDiff[] {
  const up = lowerMap(upstreamRec);
  const down = lowerMap(clientRec);
  const names = new Set<string>([...TRACKED_RESPONSE_HEADERS.map((h) => h.toLowerCase()), ...up.keys(), ...down.keys()]);
  const out: ResponseHeaderDiff[] = [];
  for (const name of [...names].sort()) {
    const uv = up.get(name);
    const cv = down.get(name);
    const { verdict, detail } = classifyResponseHeader(name, uv, cv);
    out.push({
      header: name,
      upstream: uv === undefined ? null : redactHeaderValue(name, uv),
      client: cv === undefined ? null : redactHeaderValue(name, cv),
      verdict,
      detail,
    });
  }
  return out;
}

export type JsonBodyVerdict = "BYTE_IDENTICAL" | "SEMANTICALLY_IDENTICAL" | "CHANGED";

export interface JsonBodyDiff {
  verdict: JsonBodyVerdict;
  upstreamSha256: string;
  clientSha256: string;
  upstreamCanonicalSha256: string;
  clientCanonicalSha256: string;
  added: string[];
  removed: string[];
  changed: string[];
}

export function diffJsonBodies(upstreamText: string, clientText: string): JsonBodyDiff {
  const verdict: JsonBodyVerdict =
    upstreamText === clientText ? "BYTE_IDENTICAL" : "PENDING";
  let upCanon = "";
  let downCanon = "";
  let added: string[] = [];
  let removed: string[] = [];
  let changed: string[] = [];
  let finalVerdict: JsonBodyVerdict = verdict;
  if (verdict === "PENDING") {
    try {
      const up = JSON.parse(upstreamText) as unknown;
      const down = JSON.parse(clientText) as unknown;
      upCanon = canonicalJson(up);
      downCanon = canonicalJson(down);
      if (upCanon === downCanon) {
        finalVerdict = "SEMANTICALLY_IDENTICAL";
      } else {
        finalVerdict = "CHANGED";
        const upMap = flattenPaths(up);
        const downMap = flattenPaths(down);
        for (const [k, v] of upMap) {
          if (!downMap.has(k)) removed.push(k);
          else if (downMap.get(k) !== v) changed.push(k);
        }
        for (const k of downMap.keys()) {
          if (!upMap.has(k)) added.push(k);
        }
        added.sort(); removed.sort(); changed.sort();
      }
    } catch {
      finalVerdict = "CHANGED";
    }
  } else {
    try {
      upCanon = canonicalJson(JSON.parse(upstreamText) as unknown);
      downCanon = upCanon;
    } catch { /* non-JSON byte-identical text */ }
  }
  return {
    verdict: finalVerdict,
    upstreamSha256: sha256Hex(upstreamText),
    clientSha256: sha256Hex(clientText),
    upstreamCanonicalSha256: upCanon ? sha256Hex(upCanon) : "",
    clientCanonicalSha256: downCanon ? sha256Hex(downCanon) : "",
    added,
    removed,
    changed,
  };
}

export type SseBytesVerdict = "LOGICAL_BYTES_IDENTICAL" | "LOGICAL_BYTES_CHANGED";
export type SseSequenceVerdict = "SSE_EVENT_SEQUENCE_IDENTICAL" | "SSE_EVENT_SEQUENCE_CHANGED";
export type ChunkingVerdict = "TRANSPORT_CHUNKING_IDENTICAL" | "TRANSPORT_CHUNKING_DIFFERENT";

export interface SseDiff {
  bytesVerdict: SseBytesVerdict;
  sequenceVerdict: SseSequenceVerdict;
  chunkingVerdict: ChunkingVerdict;
  upstreamSha256: string;
  clientSha256: string;
  upstreamEvents: ReturnType<typeof parseSSE>;
  clientEvents: ReturnType<typeof parseSSE>;
  upstreamEventNames: (string | null)[];
  clientEventNames: (string | null)[];
  upstreamData: string[];
  clientData: string[];
  upstreamWrites: number[];
  clientReads: number[];
}

export function diffSSE(
  upstreamText: string,
  clientText: string,
  upstreamWrites: number[],
  clientReads: number[],
): SseDiff {
  const upEvents = parseSSE(upstreamText);
  const downEvents = parseSSE(clientText);
  const sameLengths = upstreamWrites.length === clientReads.length &&
    upstreamWrites.every((v, i) => v === clientReads[i]);
  return {
    bytesVerdict: upstreamText === clientText ? "LOGICAL_BYTES_IDENTICAL" : "LOGICAL_BYTES_CHANGED",
    sequenceVerdict: eventsEqual(upEvents, downEvents) ? "SSE_EVENT_SEQUENCE_IDENTICAL" : "SSE_EVENT_SEQUENCE_CHANGED",
    chunkingVerdict: sameLengths ? "TRANSPORT_CHUNKING_IDENTICAL" : "TRANSPORT_CHUNKING_DIFFERENT",
    upstreamSha256: sha256Hex(upstreamText),
    clientSha256: sha256Hex(clientText),
    upstreamEvents: upEvents,
    clientEvents: downEvents,
    upstreamEventNames: upEvents.map((e) => e.event),
    clientEventNames: downEvents.map((e) => e.event),
    upstreamData: upEvents.map((e) => e.data),
    clientData: downEvents.map((e) => e.data),
    upstreamWrites: [...upstreamWrites],
    clientReads: [...clientReads],
  };
}

export function renderResponseDiffText(args: {
  scenarioId: string;
  upstreamStatus: number;
  clientStatus: number;
  headers: ResponseHeaderDiff[];
  json?: JsonBodyDiff | null;
  sse?: SseDiff | null;
}): string {
  const L: string[] = [];
  L.push("GoRouter WI03 response diff (sanitized)");
  L.push("======================================");
  L.push("");
  L.push("scenario: " + args.scenarioId);
  L.push("status: upstream " + args.upstreamStatus + " -> client " + args.clientStatus +
    " [" + (args.upstreamStatus === args.clientStatus ? "STATUS_PRESERVED" : "STATUS_CHANGED") + "]");
  L.push("");
  L.push("headers:");
  for (const h of args.headers) {
    L.push("  " + h.header + " [" + h.verdict + "] upstream=" + (h.upstream ?? "<ABSENT>") + " client=" + (h.client ?? "<ABSENT>") + " (" + h.detail + ")");
  }
  L.push("");
  if (args.json) {
    L.push("json body: " + args.json.verdict);
    L.push("  upstream sha256: " + args.json.upstreamSha256);
    L.push("  client sha256:   " + args.json.clientSha256);
    if (args.json.verdict === "CHANGED") {
      L.push("  added: " + (args.json.added.join(", ") || "(none)"));
      L.push("  removed: " + (args.json.removed.join(", ") || "(none)"));
      L.push("  changed: " + (args.json.changed.join(", ") || "(none)"));
    }
  }
  if (args.sse) {
    L.push("sse logical bytes: " + args.sse.bytesVerdict + " (sha " + args.sse.upstreamSha256.slice(0, 12) + "… vs " + args.sse.clientSha256.slice(0, 12) + "…) ");
    L.push("sse event sequence: " + args.sse.sequenceVerdict + " (" + args.sse.upstreamEvents.length + " events)");
    L.push("  upstream events: " + JSON.stringify(args.sse.upstreamEventNames));
    L.push("  client events:   " + JSON.stringify(args.sse.clientEventNames));
    L.push("transport chunking: " + args.sse.chunkingVerdict +
      " (fixture writes [" + args.sse.upstreamWrites.join(", ") + "] vs client reads [" + args.sse.clientReads.join(", ") + "])");
    L.push("(chunk-boundary differences are transport detail, not content transformation)");
  }
  L.push("");
  return L.join("\n");
}

export { canonicalEvent };
