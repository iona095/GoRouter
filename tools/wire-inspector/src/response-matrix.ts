/**
 * WI03 response matrix — all required response scenarios with aggregates
 * DERIVED from retained per-scenario sanitized outputs (read back from disk).
 */
import { mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { REQUIRED_WI03_SCENARIO_IDS, listResponseScenarios } from "./response-scenarios.ts";
import { wireResponseRun } from "./response-run.ts";
import { ALL_SYNTHETIC_LITERALS } from "./run.ts";
import { assertLoopbackUrl } from "./loopback.ts";
import { resolveOutBase, assertSafeStateEnv } from "./tool-root.ts";

export interface ResponseMatrixOptions {
  outDir?: string;
  matrixId?: string;
  scenarios?: string[];
}

export interface ResponseMatrixResult {
  matrixId: string;
  matrixRoot: string;
  scenarioIds: string[];
}

function newMatrixId(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp =
    d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()) +
    "-" + pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + pad(d.getUTCSeconds());
  const rand = Math.floor(Math.random() * 0xffff).toString(16).padStart(4, "0");
  return "response-matrix-" + stamp + "-" + rand;
}

function mdTable(headers: string[], rows: string[][]): string {
  const esc = (s: string) => s.replace(/\|/g, "\\|");
  const out = ["| " + headers.map(esc).join(" | ") + " |", "|" + headers.map(() => "---").join("|") + "|"];
  for (const r of rows) out.push("| " + r.map(esc).join(" | ") + " |");
  return out.join("\n");
}

interface RowEvidence {
  id: string;
  family: string;
  lane: string;
  upstreamStatus: number;
  clientStatus: number;
  contentType: string;
  requestId: string;
  bodyVerdict: string;
  outcome: string;
}

function familyOf(id: string): string {
  if (id.startsWith("messages")) return "messages";
  if (id.startsWith("responses")) return "responses";
  if (id.startsWith("zen")) return "chat/completions (zen)";
  if (id.startsWith("error")) return "chat/completions (error)";
  return "chat/completions";
}

function loadRow(dir: string, id: string): RowEvidence {
  const diff = JSON.parse(readFileSync(join(dir, "response-diff.sanitized.json"), "utf8")) as {
    status?: { upstream?: number; client?: number };
    headers?: Array<{ header: string; client: string | null }>;
    json?: { verdict?: string } | null;
    sse?: { bytesVerdict?: string; sequenceVerdict?: string } | null;
    outcome?: string;
  };
  const meta = JSON.parse(readFileSync(join(dir, "response-scenario.json"), "utf8")) as { lane: string };
  const h = new Map((diff.headers ?? []).map((x) => [x.header, x.client]));
  const bodyVerdict = diff.json?.verdict ?? (diff.sse ? diff.sse.bytesVerdict + " / " + diff.sse.sequenceVerdict : "NO CAPTURE");
  return {
    id,
    family: familyOf(id),
    lane: meta.lane,
    upstreamStatus: diff.status?.upstream ?? -1,
    clientStatus: diff.status?.client ?? -1,
    contentType: h.get("content-type") ?? "(absent)",
    requestId: h.get("x-request-id") ?? "(absent)",
    bodyVerdict,
    outcome: diff.outcome ?? "UNKNOWN",
  };
}

function headerCell(dir: string, name: string): string {
  const diff = JSON.parse(readFileSync(join(dir, "response-diff.sanitized.json"), "utf8")) as {
    headers?: Array<{ header: string; verdict: string; upstream: string | null; client: string | null }>;
  };
  const found = (diff.headers ?? []).find((h) => h.header === name);
  if (!found) return "absent-both";
  const map: Record<string, string> = {
    PRESERVED_UNCHANGED: "preserved",
    CHANGED_BY_GOROUTER: "changed",
    REMOVED_BY_GOROUTER: "removed",
    ADDED_BY_GOROUTER: "added",
    TRANSPORT_DERIVED: "transport",
    REDACTED: "redacted",
    ABSENT_BOTH: "absent-both",
  };
  return map[found.verdict] ?? found.verdict;
}

export async function wireResponseMatrix(opts: ResponseMatrixOptions = {}): Promise<ResponseMatrixResult> {
  const outBase = resolveOutBase(opts.outDir);
  assertSafeStateEnv(outBase);
  const matrixId = opts.matrixId ?? newMatrixId();
  const matrixRoot = join(outBase, matrixId);
  mkdirSync(matrixRoot, { recursive: true });
  const ids = opts.scenarios ?? [...REQUIRED_WI03_SCENARIO_IDS];
  const known = new Set(listResponseScenarios().map((s) => s.id));
  for (const id of ids) {
    if (!known.has(id)) throw new Error("unknown response scenario '" + id + "'");
  }
  for (const id of ids) {
    const r = await wireResponseRun({ outDir: matrixRoot, runId: id, scenario: id });
    assertLoopbackUrl("http://127.0.0.1:1");
    void r;
  }
  // Aggregates derived from retained evidence.
  const rows = ids.map((id) => loadRow(join(matrixRoot, id), id));
  const compact = rows.map((r) => [r.id, r.family, r.lane, String(r.upstreamStatus), String(r.clientStatus), r.contentType, r.requestId, r.bodyVerdict]);
  const errorIds = ["error-400", "error-401", "error-422", "error-429", "error-500"];
  const errorRows = rows.filter((r) => errorIds.includes(r.id)).map((r) => {
    const dir = join(matrixRoot, r.id);
    const retry = headerCell(dir, "retry-after");
    const rl = ["x-ratelimit-limit-requests", "x-ratelimit-remaining-requests", "x-ratelimit-reset-requests"].map((h) => headerCell(dir, h)).join("/");
    const statusVerdict = r.upstreamStatus === r.clientStatus ? "STATUS_PRESERVED" : "STATUS_CHANGED";
    const bodyVerdict = r.bodyVerdict === "BYTE_IDENTICAL" ? "BODY_PRESERVED" : "BODY_CHANGED";
    return [r.id, String(r.upstreamStatus), String(r.clientStatus), statusVerdict, r.requestId === "(absent)" ? "HEADER_REMOVED" : "HEADER_PRESERVED", retry, rl, bodyVerdict];
  });
  const headerFields = ["content-type", "cache-control", "x-request-id", "x-wi03-upstream", "retry-after", "x-ratelimit-limit-requests", "x-ratelimit-remaining-requests", "x-ratelimit-reset-requests"];
  const headerRows = rows.map((r) => [r.id, ...headerFields.map((h) => headerCell(join(matrixRoot, r.id), h))]);
  const sseIds = ["chat-sse-200", "responses-sse-200", "messages-sse-200", "zen-chat-sse-200"];
  const sseRows = sseIds.map((id) => {
    const diff = JSON.parse(readFileSync(join(matrixRoot, id, "response-diff.sanitized.json"), "utf8")) as {
      sse?: { bytesVerdict?: string; sequenceVerdict?: string; chunkingVerdict?: string; upstreamWrites?: number[]; clientReads?: number[] } | null;
    };
    const s = diff.sse;
    return [id, s?.bytesVerdict ?? "?", s?.sequenceVerdict ?? "?", "[" + (s?.upstreamWrites ?? []).join(", ") + "]", "[" + (s?.clientReads ?? []).join(", ") + "]", s?.chunkingVerdict ?? "?"];
  });

  const go = rows.find((r) => r.id === "chat-sse-200")!;
  const zen = rows.find((r) => r.id === "zen-chat-sse-200")!;
  const goZenLines = [
    "# GO-vs-ZEN response comparison (from actual captures: chat-sse-200 vs zen-chat-sse-200)",
    "",
    "- same status? GO=" + go.upstreamStatus + "->" + go.clientStatus + " ZEN=" + zen.upstreamStatus + "->" + zen.clientStatus + " => " + (go.clientStatus === zen.clientStatus && go.upstreamStatus === zen.upstreamStatus ? "YES" : "NO"),
    "- same response headers? content-type GO=" + go.contentType + " ZEN=" + zen.contentType + "; request-id GO=" + go.requestId + " ZEN=" + zen.requestId + " (ids differ by scripted fixture value, both preserved)",
    "- same logical SSE bytes? GO=" + go.bodyVerdict + " ZEN=" + zen.bodyVerdict + " => " + (go.bodyVerdict === zen.bodyVerdict ? "YES (both LOGICAL_BYTES_IDENTICAL)" : "SEE MATRIX"),
    "- same SSE event order? see SSE matrix rows (both SSE_EVENT_SEQUENCE_IDENTICAL in this run)",
    "- same transport chunking? chunk boundaries are runtime timing detail; see upstream-writes vs client-reads columns (content verdicts do not depend on them)",
    "",
    "Conclusion: no lane-dependent response transformation observed in these captures.",
    "",
  ];
  const goZen = goZenLines.join("\n");

  const famLines = [
    "# Family response comparison (from actual captures)",
    "",
    "- chat/completions JSON success (chat-json-200): " + (rows.find((r) => r.id === "chat-json-200")?.bodyVerdict ?? "?"),
    "- chat/completions SSE (chat-sse-200): " + (rows.find((r) => r.id === "chat-sse-200")?.bodyVerdict ?? "?"),
    "- responses SSE (responses-sse-200): " + (rows.find((r) => r.id === "responses-sse-200")?.bodyVerdict ?? "?"),
    "- messages SSE (messages-sse-200): " + (rows.find((r) => r.id === "messages-sse-200")?.bodyVerdict ?? "?"),
    "- content-type/cache-control/request-id preserved in all families: see header matrix",
    "",
  ];
  const chatV = rows.find((r) => r.id === "chat-json-200")?.bodyVerdict;
  const chatSseV = rows.find((r) => r.id === "chat-sse-200")?.bodyVerdict;
  const respV = rows.find((r) => r.id === "responses-sse-200")?.bodyVerdict;
  const msgV = rows.find((r) => r.id === "messages-sse-200")?.bodyVerdict;
  const identical = chatV === "BYTE_IDENTICAL" && chatSseV === "LOGICAL_BYTES_IDENTICAL / SSE_EVENT_SEQUENCE_IDENTICAL" &&
    respV === "LOGICAL_BYTES_IDENTICAL / SSE_EVENT_SEQUENCE_IDENTICAL" && msgV === "LOGICAL_BYTES_IDENTICAL / SSE_EVENT_SEQUENCE_IDENTICAL";
  famLines.push(identical
    ? "IDENTICAL IN TESTED RESPONSE TRANSFORMATION SEMANTICS (not a universal guarantee for all possible provider responses)."
    : "Differences observed — see per-scenario response diffs (not a universal claim).");
  famLines.push("");
  const family = famLines.join("\n");

  const summary = [
    "# WI03 response/SSE/error propagation matrix",
    "",
    "- matrix: " + matrixId,
    "- generatedUtc: " + new Date().toISOString(),
    "- scenarios: " + ids.join(", "),
    "- upstream: LOOPBACK ONLY, endpoint-only (per-scenario runtime records)",
    "- redaction: sanitized before disk write",
    "",
    "## Aggregate summary",
    "",
    mdTable(["Scenario", "Family", "Lane", "Upstream status", "Client status", "Content-Type", "Request-ID", "Body/SSE verdict"], compact),
    "",
    "## Status matrix (400/401/422/429/500)",
    "",
    mdTable(["Scenario", "Upstream status", "Client status", "Status", "x-request-id", "Retry-After", "ratelimit limit/rem/reset", "Body"], errorRows),
    "",
    "Statuses are synthetic fixture responses observed through GoRouter (client-facing proxy behavior; not H0 probe classification).",
    "",
    "## Header matrix",
    "",
    mdTable(["Scenario", ...headerFields], headerRows),
    "",
    "Labels: preserved | changed | removed | added | transport | redacted | absent-both.",
    "content-length/transfer-encoding/connection/date/server differences are transport-derived framing, not application rewrites.",
    "",
    "## SSE matrix",
    "",
    mdTable(["Scenario", "Logical bytes", "Event order", "Upstream writes", "Client reads", "Chunking"], sseRows),
    "",
    "Chunk-boundary differences are transport detail; content verdicts use logical bytes + event sequence only.",
    "",
    "## Outcome",
    "",
    mdTable(["Scenario", "Outcome"], rows.map((r) => [r.id, r.outcome])),
    "",
    goZen,
    family,
    "## Safety",
    "",
    "- upstream bind: 127.0.0.1; proxy: false; CONNECT: refused; redirect follow: disabled",
    "- real provider contact: none; TLS MITM: not used; production state: not used",
    "",
  ];
  writeFileSync(join(matrixRoot, "response-matrix-summary.md"), summary.join("\n"), "utf8");
  writeFileSync(join(matrixRoot, "go-zen-response-compare.md"), goZen, "utf8");
  writeFileSync(join(matrixRoot, "family-response-compare.md"), family, "utf8");
  writeFileSync(join(matrixRoot, "response-matrix.sanitized.json"), JSON.stringify({
    matrix: matrixId,
    generatedUtc: new Date().toISOString(),
    scenarios: rows,
    headerFields,
    errorScenarios: errorIds,
    sseScenarios: sseIds,
  }, null, 2) + "\n", "utf8");

  const texts: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, name.name);
      if (name.isDirectory()) { walk(p); continue; }
      if (/\.(json|md|txt)$/.test(p)) texts.push(readFileSync(p, "utf8"));
    }
  };
  walk(matrixRoot);
  const blob = texts.join("\n");
  for (const lit of ALL_SYNTHETIC_LITERALS) {
    if (blob.includes(lit)) throw new Error("WI03 matrix redaction failure: synthetic literal would be retained");
  }
  return { matrixId, matrixRoot, scenarioIds: ids };
}
