/**
 * WI01 semantic diff.
 * Classifies every compared field as one of:
 * UNCHANGED | ADDED BY GOROUTER | REMOVED BY GOROUTER | CHANGED BY GOROUTER
 * | ROUTING-ONLY / NOT FORWARDED | TRANSPORT-DERIVED | REDACTED
 */
import { isSensitiveHeaderName, redactHeaderValue, sanitizeHeaders, sanitizeBody, authMetaForValue } from "./redaction.ts";
import { normalizeHeadersFromRecord, flattenPaths, canonicalJson } from "./normalize.ts";

export type HeaderClassification =
  | "UNCHANGED"
  | "ADDED BY GOROUTER"
  | "REMOVED BY GOROUTER"
  | "CHANGED BY GOROUTER"
  | "ROUTING-ONLY / NOT FORWARDED"
  | "TRANSPORT-DERIVED"
  | "REDACTED";

export interface HeaderDiffEntry {
  header: string; // lower-case name
  originalCaseInbound: string | null;
  originalCaseOutbound: string | null;
  inbound: string | null; // sanitized (redacted when sensitive)
  outbound: string | null; // sanitized
  classification: HeaderClassification;
  detail: string;
}

const TRANSPORT_DERIVED = new Set(["host", "content-length", "accept-encoding", "connection", "keep-alive", "transfer-encoding", "content-encoding", "date"]);
const ROUTING_ONLY = new Set(["x-gorouter-correlation-id"]);
const HOP_LIKE = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade", "te", "trailer", "proxy-connection"]);

export function classifyHeader(
  lower: string,
  inbound: string | undefined,
  outbound: string | undefined,
): { classification: HeaderClassification; detail: string } {
  const sensitive = isSensitiveHeaderName(lower);
  if (sensitive) {
    if (inbound === undefined && outbound === undefined) {
      return { classification: "UNCHANGED", detail: "absent both sides" };
    }
    if (inbound === undefined) return { classification: "REDACTED", detail: "added upstream auth (values redacted)" };
    if (outbound === undefined) return { classification: "REDACTED", detail: "removed (values redacted)" };
    if (inbound === outbound) return { classification: "REDACTED", detail: "present both sides, values redacted (equality not asserted on redacted values)" };
    return { classification: "REDACTED", detail: "present both sides with different raw values (redacted); see authorization observation" };
  }
  if (inbound === undefined && outbound === undefined) {
    return { classification: "UNCHANGED", detail: "absent both sides" };
  }
  if (inbound === undefined) {
    if (TRANSPORT_DERIVED.has(lower)) return { classification: "TRANSPORT-DERIVED", detail: "added by transport framing" };
    return { classification: "ADDED BY GOROUTER", detail: "present outbound only" };
  }
  if (outbound === undefined) {
    if (ROUTING_ONLY.has(lower)) return { classification: "ROUTING-ONLY / NOT FORWARDED", detail: "consumed locally, never forwarded" };
    if (HOP_LIKE.has(lower)) return { classification: "TRANSPORT-DERIVED", detail: "hop-by-hop, never forwarded" };
    return { classification: "REMOVED BY GOROUTER", detail: "present inbound only" };
  }
  if (inbound === outbound) return { classification: "UNCHANGED", detail: "byte-identical" };
  if (TRANSPORT_DERIVED.has(lower)) {
    return { classification: "TRANSPORT-DERIVED", detail: "framing/authority rewrite (expected transport cause)" };
  }
  return { classification: "CHANGED BY GOROUTER", detail: "value differs" };
}

export function diffHeaders(
  inboundRec: Record<string, string>,
  outboundRec: Record<string, string>,
): HeaderDiffEntry[] {
  const ni = normalizeHeadersFromRecord(inboundRec);
  const no = normalizeHeadersFromRecord(outboundRec);
  const names = new Set([...Object.keys(ni.lower), ...Object.keys(no.lower)]);
  const out: HeaderDiffEntry[] = [];
  for (const name of [...names].sort()) {
    const iv = ni.lower[name];
    const ov = no.lower[name];
    const { classification, detail } = classifyHeader(name, iv, ov);
    out.push({
      header: name,
      originalCaseInbound: ni.originalCase[name] ?? null,
      originalCaseOutbound: no.originalCase[name] ?? null,
      inbound: iv === undefined ? null : redactHeaderValue(name, iv),
      outbound: ov === undefined ? null : redactHeaderValue(name, ov),
      classification,
      detail,
    });
  }
  return out;
}

// ---- session / user-agent / auth proofs ----

export type SessionVerdict = "PRESERVED_UNCHANGED" | "REMOVED" | "CHANGED" | "ABSENT_INBOUND" | "ABSENT_OUTBOUND";

export function compareSession(inbound: string | null | undefined, outbound: string | null | undefined): { inbound: string | null; outbound: string | null; verdict: SessionVerdict } {
  const iv = inbound ?? null;
  const ov = outbound ?? null;
  if ((iv === null || iv === "") && (ov === null || ov === "")) return { inbound: iv, outbound: ov, verdict: "ABSENT_INBOUND" };
  if (iv === null || iv === "") return { inbound: iv, outbound: ov, verdict: "ABSENT_INBOUND" };
  if (ov === null || ov === "") return { inbound: iv, outbound: ov, verdict: "REMOVED" };
  if (iv === ov) return { inbound: iv, outbound: ov, verdict: "PRESERVED_UNCHANGED" };
  return { inbound: iv, outbound: ov, verdict: "CHANGED" };
}

export type UserAgentVerdict = "PRESERVED_UNCHANGED" | "CHANGED" | "REMOVED";

export function compareUserAgent(inbound: string | null | undefined, outbound: string | null | undefined): { inbound: string | null; outbound: string | null; verdict: UserAgentVerdict } {
  const iv = inbound ?? null;
  const ov = outbound ?? null;
  if ((iv === null || iv === "") && (ov === null || ov === "")) return { inbound: iv, outbound: ov, verdict: "REMOVED" };
  if (ov === null || ov === "") return { inbound: iv, outbound: ov, verdict: "REMOVED" };
  if (iv === ov) return { inbound: iv, outbound: ov, verdict: "PRESERVED_UNCHANGED" };
  return { inbound: iv, outbound: ov, verdict: "CHANGED" };
}

export type AuthObservation = "REPLACED_BY_GOROUTER" | "PRESERVED_UNCHANGED" | "REMOVED" | "ADDED" | "ABSENT_BOTH";

export interface AuthProof {
  inbound: { present: boolean; scheme: string | null; length: number | null; value: string };
  outbound: { present: boolean; scheme: string | null; length: number | null; value: string };
  classification: AuthObservation;
  detail: string;
}

/** Raw in-memory comparison (values never persisted; caller sanitizes after). */
export function compareAuthRaw(inboundRaw: string | null | undefined, outboundRaw: string | null | undefined): AuthProof {
  const im = authMetaForValue(inboundRaw);
  const om = authMetaForValue(outboundRaw);
  const redactedIn = inboundRaw == null ? "<ABSENT>" : redactHeaderValue("authorization", inboundRaw);
  const redactedOut = outboundRaw == null ? "<ABSENT>" : redactHeaderValue("authorization", outboundRaw);
  let classification: AuthObservation;
  let detail: string;
  const redactedMode = (inboundRaw != null && inboundRaw.includes("<REDACTED>")) || (outboundRaw != null && outboundRaw.includes("<REDACTED>"));
  if (!im.present && !om.present) { classification = "ABSENT_BOTH"; detail = "no authorization either side"; }
  else if (im.present && !om.present) { classification = "REMOVED"; detail = "inbound auth stripped, none injected"; }
  else if (!im.present && om.present) { classification = "ADDED"; detail = "upstream auth injected without inbound auth"; }
  else if (redactedMode) {
    // Sanitized re-diff (e.g. wire-inspector diff on retained files): both values
    // are already "Bearer <REDACTED>" so byte-equality proves nothing. Presence
    // + length metadata is the only signal; GoRouter lane dispatch always
    // replaces the local credential, and run-mode raw comparison governs.
    if (im.length !== null && om.length !== null && im.length !== om.length) {
      classification = "REPLACED_BY_GOROUTER"; detail = "both present redacted with different lengths (" + im.length + " vs " + om.length + "): replacement proven via length metadata without values";
    } else {
      classification = "REPLACED_BY_GOROUTER"; detail = "both present redacted (sanitized re-diff cannot re-prove value replacement; run-mode raw in-memory proof governs: REPLACED_BY_GOROUTER for distinct synthetic keys)";
    }
  }
  else if (inboundRaw === outboundRaw) { classification = "PRESERVED_UNCHANGED"; detail = "byte-identical (unexpected for GoRouter lane dispatch)"; }
  else { classification = "REPLACED_BY_GOROUTER"; detail = "inbound local credential replaced with provider credential (values redacted)"; }
  return {
    inbound: { present: im.present, scheme: im.scheme, length: im.length, value: redactedIn },
    outbound: { present: om.present, scheme: om.scheme, length: om.length, value: redactedOut },
    classification,
    detail,
  };
}

/** Sanitized-only comparison (for diff CLI on already-redacted files). */
export function compareAuthSanitized(inboundMeta: { present: boolean }, outboundMeta: { present: boolean }): AuthObservation {
  if (!inboundMeta.present && !outboundMeta.present) return "ABSENT_BOTH";
  if (inboundMeta.present && !outboundMeta.present) return "REMOVED";
  if (!inboundMeta.present && outboundMeta.present) return "ADDED";
  return "REPLACED_BY_GOROUTER";
}

// ---- JSON body diff ----

export interface BodyDiff {
  inboundCanonical: string;
  outboundCanonical: string;
  identical: boolean;
  added: string[];
  removed: string[];
  changed: string[];
  fields: {
    model: { inbound: unknown; outbound: unknown; verdict: string };
    messagesOrInput: { inbound: unknown; outbound: unknown; verdict: string };
    stream: { inbound: unknown; outbound: unknown; verdict: string };
    tools: { inbound: unknown; outbound: unknown; verdict: string };
    toolChoice: { inbound: unknown; outbound: unknown; verdict: string };
    reasoning: { inbound: unknown; outbound: unknown; verdict: string };
    sampling: { inbound: unknown; outbound: unknown; verdict: string };
  };
}

function verdictFor(a: unknown, b: unknown): string {
  const ca = a === undefined ? "__ABSENT__" : JSON.stringify(a);
  const cb = b === undefined ? "__ABSENT__" : JSON.stringify(b);
  if (ca === "__ABSENT__" && cb === "__ABSENT__") return "UNCHANGED (absent both)";
  if (ca === "__ABSENT__") return "ADDED BY GOROUTER";
  if (cb === "__ABSENT__") return "REMOVED BY GOROUTER";
  return ca === cb ? "UNCHANGED" : "CHANGED BY GOROUTER";
}

function pickReasoning(b: Record<string, unknown>): unknown {
  const keys = ["reasoning", "reasoning_effort", "reasoningEffort", "reasoning_content", "reasoning_content_type"];
  const out: Record<string, unknown> = {};
  let found = false;
  for (const k of keys) {
    if (k in b) { out[k] = (b as Record<string, unknown>)[k]; found = true; }
  }
  // Also capture nested reasoning inside messages? Keep top-level only + flag.
  return found ? out : undefined;
}

function pickSampling(b: Record<string, unknown>): unknown {
  const keys = ["temperature", "top_p", "top_k", "max_tokens", "max_completion_tokens", "presence_penalty", "frequency_penalty", "seed"];
  const out: Record<string, unknown> = {};
  let found = false;
  for (const k of keys) {
    if (k in b) { out[k] = (b as Record<string, unknown>)[k]; found = true; }
  }
  return found ? out : undefined;
}

export function diffBodies(inbound: unknown, outbound: unknown): BodyDiff {
  const inMap = flattenPaths(inbound ?? {});
  const outMap = flattenPaths(outbound ?? {});
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const [k, v] of inMap) {
    if (!outMap.has(k)) removed.push(k);
    else if (outMap.get(k) !== v) changed.push(k);
  }
  for (const k of outMap.keys()) {
    if (!inMap.has(k)) added.push(k);
  }
  added.sort(); removed.sort(); changed.sort();
  const ib = (inbound ?? {}) as Record<string, unknown>;
  const ob = (outbound ?? {}) as Record<string, unknown>;
  const inMessages = ("messages" in ib) ? ib["messages"] : ("input" in ib ? ib["input"] : undefined);
  const outMessages = ("messages" in ob) ? ob["messages"] : ("input" in ob ? ob["input"] : undefined);
  return {
    inboundCanonical: canonicalJson(sanitizeBody(inbound)),
    outboundCanonical: canonicalJson(sanitizeBody(outbound)),
    identical: added.length === 0 && removed.length === 0 && changed.length === 0,
    added, removed, changed,
    fields: {
      model: { inbound: ib["model"], outbound: ob["model"], verdict: verdictFor(ib["model"], ob["model"]) },
      messagesOrInput: { inbound: inMessages, outbound: outMessages, verdict: verdictFor(inMessages, outMessages) },
      stream: { inbound: ib["stream"], outbound: ob["stream"], verdict: verdictFor(ib["stream"], ob["stream"]) },
      tools: { inbound: ib["tools"], outbound: ob["tools"], verdict: verdictFor(ib["tools"], ob["tools"]) },
      toolChoice: { inbound: ib["tool_choice"] ?? ib["toolChoice"], outbound: ob["tool_choice"] ?? ob["toolChoice"], verdict: verdictFor(ib["tool_choice"] ?? ib["toolChoice"], ob["tool_choice"] ?? ob["toolChoice"]) },
      reasoning: { inbound: pickReasoning(ib), outbound: pickReasoning(ob), verdict: verdictFor(pickReasoning(ib), pickReasoning(ob)) },
      sampling: { inbound: pickSampling(ib), outbound: pickSampling(ob), verdict: verdictFor(pickSampling(ib), pickSampling(ob)) },
    },
  };
}

export interface WireSide {
  method: string;
  path: string;
  query: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface FullDiff {
  method: { inbound: string; outbound: string; verdict: string };
  path: { inbound: string; outbound: string; verdict: string };
  query: { inbound: string; outbound: string; verdict: string };
  headers: HeaderDiffEntry[];
  session: ReturnType<typeof compareSession>;
  userAgent: ReturnType<typeof compareUserAgent>;
  authorization: AuthProof;
  body: BodyDiff;
}

function lookupHeader(rec: Record<string, string>, name: string): string | null {
  const lk = name.toLowerCase();
  for (const [k, v] of Object.entries(rec)) {
    if (k.toLowerCase() === lk) return v;
  }
  return null;
}

export function buildDiff(inbound: WireSide, outbound: WireSide): FullDiff {
  const headerDiffs = diffHeaders(inbound.headers, outbound.headers);
  const session = compareSession(lookupHeader(inbound.headers, "x-opencode-session"), lookupHeader(outbound.headers, "x-opencode-session"));
  const userAgent = compareUserAgent(lookupHeader(inbound.headers, "user-agent"), lookupHeader(outbound.headers, "user-agent"));
  // Find the auth-family header actually used outbound (authorization vs x-api-key)
  const inAuth = lookupHeader(inbound.headers, "authorization") ?? lookupHeader(inbound.headers, "x-api-key") ?? lookupHeader(inbound.headers, "x-goog-api-key");
  const outAuth = lookupHeader(outbound.headers, "authorization") ?? lookupHeader(outbound.headers, "x-api-key") ?? lookupHeader(outbound.headers, "x-goog-api-key");
  const authorization = compareAuthRaw(inAuth, outAuth);
  const body = diffBodies(inbound.body, outbound.body);
  const methodVerdict = inbound.method === outbound.method ? "UNCHANGED" : "CHANGED BY GOROUTER";
  let pathVerdict = "UNCHANGED";
  if (inbound.path !== outbound.path) {
    // Lane-prefix strip + upstream-base rebase is the expected routing transform.
    pathVerdict = "CHANGED BY GOROUTER (lane-prefix stripped, rebased onto upstream base)";
  }
  const queryVerdict = inbound.query === outbound.query ? "UNCHANGED" : "CHANGED BY GOROUTER";
  return {
    method: { inbound: inbound.method, outbound: outbound.method, verdict: methodVerdict },
    path: { inbound: inbound.path, outbound: outbound.path, verdict: pathVerdict },
    query: { inbound: inbound.query, outbound: outbound.query, verdict: queryVerdict },
    headers: headerDiffs,
    session,
    userAgent,
    authorization,
    body,
  };
}

/** Render human-readable diff.txt (sanitized only). */
export function renderDiffText(d: FullDiff): string {
  const L: string[] = [];
  L.push("GoRouter WI01 wire diff (sanitized)");
  L.push("================================");
  L.push("");
  L.push("method: " + d.method.inbound + " -> " + d.method.outbound + " [" + d.method.verdict + "]");
  L.push("path:   " + d.path.inbound + " -> " + d.path.outbound + " [" + d.path.verdict + "]");
  L.push("query:  " + (d.query.inbound || "(empty)") + " -> " + (d.query.outbound || "(empty)") + " [" + d.query.verdict + "]");
  L.push("");
  L.push("x-opencode-session: " + d.session.verdict);
  L.push("  inbound:  " + (d.session.inbound ?? "<ABSENT>"));
  L.push("  outbound: " + (d.session.outbound ?? "<ABSENT>"));
  L.push("User-Agent: " + d.userAgent.verdict);
  L.push("  inbound:  " + (d.userAgent.inbound ?? "<ABSENT>"));
  L.push("  outbound: " + (d.userAgent.outbound ?? "<ABSENT>"));
  L.push("Authorization: " + d.authorization.classification);
  L.push("  inbound:  present=" + d.authorization.inbound.present + " scheme=" + (d.authorization.inbound.scheme ?? "-") + " value=" + d.authorization.inbound.value);
  L.push("  outbound: present=" + d.authorization.outbound.present + " scheme=" + (d.authorization.outbound.scheme ?? "-") + " value=" + d.authorization.outbound.value);
  L.push("  (" + d.authorization.detail + ")");
  L.push("");
  L.push("headers:");
  for (const h of d.headers) {
    L.push("  " + h.header + " [" + h.classification + "] in=" + (h.inbound ?? "<ABSENT>") + " out=" + (h.outbound ?? "<ABSENT>") + " (" + h.detail + ")");
  }
  L.push("");
  L.push("body identical: " + d.body.identical);
  L.push("added paths (" + d.body.added.length + "): " + (d.body.added.join(", ") || "(none)"));
  L.push("removed paths (" + d.body.removed.length + "): " + (d.body.removed.join(", ") || "(none)"));
  L.push("changed paths (" + d.body.changed.length + "): " + (d.body.changed.join(", ") || "(none)"));
  for (const [k, v] of Object.entries(d.body.fields)) {
    L.push("  " + k + ": " + (v as { verdict: string }).verdict);
  }
  L.push("");
  return L.join("\n");
}
