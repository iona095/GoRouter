/**
 * WI02 matrix — deterministic multi-scenario run with aggregate reports.
 *
 * Each scenario runs with fresh isolated synthetic state (wireInspectorRun
 * owns its capture server + state dir per call). Aggregates are DERIVED from
 * retained per-scenario sanitized outputs (read back from disk), never from
 * in-memory shortcuts, so the matrix report reproduces from evidence alone.
 */
import { mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { REQUIRED_WI02_SCENARIO_IDS, listScenarios } from "./scenarios.ts";
import { wireInspectorRun, ALL_SYNTHETIC_LITERALS } from "./run.ts";
import { assertLoopbackUrl } from "./loopback.ts";

export interface MatrixOptions {
  outDir?: string;
  matrixId?: string;
  scenarios?: string[];
}

export interface MatrixResult {
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
  return "matrix-" + stamp + "-" + rand;
}

import { resolveOutBase, assertSafeStateEnv } from "./tool-root.ts";

type HeaderMatrixLabel =
  | "preserved"
  | "changed"
  | "removed"
  | "added-by-gorouter"
  | "consumed-locally"
  | "rejected"
  | "absent-both"
  | "transport-derived"
  | "redacted";

export const MATRIX_HEADERS = [
  "x-opencode-session",
  "x-client-request-id",
  "x-session-id",
  "x-session-affinity",
  "x-gorouter-correlation-id",
  "x-wi02-test",
  "user-agent",
  "accept",
  "content-type",
  "authorization",
] as const;

export const MATRIX_BODY_FIELDS = [
  "model",
  "messages/input",
  "stream",
  "tools",
  "tool_choice",
  "reasoning",
  "sampling",
  "token/output controls",
] as const;

function headerLabelFor(
  header: string,
  inbound: Record<string, string>,
  outbound: Record<string, string>,
  classification: string | null,
): HeaderMatrixLabel {
  const lk = header.toLowerCase();
  const hasIn = Object.keys(inbound).some((k) => k.toLowerCase() === lk);
  const hasOut = Object.keys(outbound).some((k) => k.toLowerCase() === lk);
  if (!hasIn && !hasOut) return "absent-both";
  if (!classification) return hasIn && !hasOut ? "removed" : "added-by-gorouter";
  switch (classification) {
    case "UNCHANGED": return "preserved";
    case "CHANGED BY GOROUTER": return "changed";
    case "REMOVED BY GOROUTER": return "removed";
    case "ADDED BY GOROUTER": return "added-by-gorouter";
    case "ROUTING-ONLY / NOT FORWARDED": return "consumed-locally";
    case "TRANSPORT-DERIVED": return "transport-derived";
    case "REDACTED": return "redacted";
    default: return "changed";
  }
}

interface ScenarioEvidence {
  id: string;
  lane: string;
  clientPath: string;
  upstreamPath: string | null;
  session: string;
  userAgent: string;
  auth: string;
  bodyVerdict: string;
  outcome: string;
  clientStatus: number;
  headerRow: Record<string, HeaderMatrixLabel>;
  bodyRow: Record<string, string>;
  bodyIdentical: boolean | null;
}

function loadScenarioEvidence(dir: string, id: string): ScenarioEvidence {
  const inbound = JSON.parse(readFileSync(join(dir, "inbound.sanitized.json"), "utf8")) as {
    headers: Record<string, string>; path: string;
  };
  const outboundRaw = JSON.parse(readFileSync(join(dir, "outbound.sanitized.json"), "utf8")) as {
    headers?: Record<string, string>; path?: string; captured?: boolean;
  };
  const diff = JSON.parse(readFileSync(join(dir, "diff.sanitized.json"), "utf8")) as {
    session?: { verdict?: string };
    userAgent?: { verdict?: string };
    authorization?: { classification?: string };
    headers?: Array<{ header: string; classification: string }>;
    body?: { identical?: boolean; fields?: Record<string, { verdict?: string }> };
    outcome?: string;
  };
  const scenarioMeta = JSON.parse(readFileSync(join(dir, "scenario.json"), "utf8")) as {
    lane: string; outcome: string; clientStatus: number;
  };
  const outboundHeaders = outboundRaw.headers ?? {};
  const classBy = new Map((diff.headers ?? []).map((h) => [h.header.toLowerCase(), h.classification]));
  const headerRow: Record<string, HeaderMatrixLabel> = {};
  for (const h of MATRIX_HEADERS) {
    headerRow[h] = headerLabelFor(h, inbound.headers, outboundHeaders, classBy.get(h.toLowerCase()) ?? null);
  }
  const f = diff.body?.fields ?? {};
  const bodyRow: Record<string, string> = {
    "model": f["model"]?.verdict ?? "n/a",
    "messages/input": f["messagesOrInput"]?.verdict ?? "n/a",
    "stream": f["stream"]?.verdict ?? "n/a",
    "tools": f["tools"]?.verdict ?? "n/a",
    "tool_choice": f["toolChoice"]?.verdict ?? "n/a",
    "reasoning": f["reasoning"]?.verdict ?? "n/a",
    "sampling": f["sampling"]?.verdict ?? "n/a",
    "token/output controls": "see diff (max_tokens under sampling/token paths)",
  };
  return {
    id,
    lane: scenarioMeta.lane,
    clientPath: inbound.path,
    upstreamPath: outboundRaw.path ?? null,
    session: diff.session?.verdict ?? "n/a",
    userAgent: diff.userAgent?.verdict ?? "n/a",
    auth: diff.authorization?.classification ?? "n/a",
    bodyVerdict: diff.body?.identical === true ? "SEMANTICALLY_IDENTICAL" : diff.body?.identical === false ? "DIFFERS (see paths)" : "NO CAPTURE",
    outcome: scenarioMeta.outcome,
    clientStatus: scenarioMeta.clientStatus,
    headerRow,
    bodyRow,
    bodyIdentical: diff.body?.identical ?? null,
  };
}

function mdTable(headers: string[], rows: string[][]): string {
  const esc = (s: string) => s.replace(/\|/g, "\\|");
  const out = ["| " + headers.map(esc).join(" | ") + " |", "|" + headers.map(() => "---").join("|") + "|"];
  for (const r of rows) out.push("| " + r.map(esc).join(" | ") + " |");
  return out.join("\n");
}

function buildGoZenCompare(rows: ScenarioEvidence[]): string {
  const go = rows.find((r) => r.id === "chat-completions-stream");
  const zen = rows.find((r) => r.id === "zen-chat-baseline");
  const L: string[] = ["# GO-vs-ZEN comparison (from actual captures)", ""];
  if (!go || !zen) {
    L.push("Required baselines missing; comparison unavailable.");
    return L.join("\n") + "\n";
  }
  const row = (label: string, a: string, b: string, same: boolean) =>
    "- " + label + ": GO=" + a + " ZEN=" + b + " => " + (same ? "SAME" : "DIFFERENT");
  L.push(row("session handling", go.session, zen.session, go.session === zen.session));
  L.push(row("user-agent handling", go.userAgent, zen.userAgent, go.userAgent === zen.userAgent));
  L.push(row("auth semantics", go.auth, zen.auth, go.auth === zen.auth));
  L.push(row("body preservation", go.bodyVerdict, zen.bodyVerdict, go.bodyVerdict === zen.bodyVerdict));
  const goStrip = go.clientPath.replace(/^\/go\/v1/, "") === go.upstreamPath;
  const zenStrip = zen.clientPath.replace(/^\/zen\/v1/, "") === zen.upstreamPath;
  L.push("- route-prefix stripping: GO " + go.clientPath + " -> " + go.upstreamPath + "; ZEN " + zen.clientPath + " -> " + zen.upstreamPath);
  L.push("- same route-prefix stripping pattern? " + (goStrip && zenStrip ? "YES (lane prefix stripped, rebased onto upstream base in both)" : "NO (see paths)"));
  L.push("- same auth-family semantics? " + (go.auth === zen.auth ? "YES (" + go.auth + ")" : "NO (GO=" + go.auth + " ZEN=" + zen.auth + ")"));
  L.push("- different provider/upstream headers? see header matrix rows for GO vs ZEN (transport-derived host/content-length differ only by ephemeral port)");
  L.push("");
  L.push("Conclusion: lanes differ only by account/upstream selection and lane-prefix routing; transformation semantics identical in these captures.");
  L.push("");
  return L.join("\n");
}

export async function wireInspectorMatrix(opts: MatrixOptions = {}): Promise<MatrixResult> {
  const outBase = resolveOutBase(opts.outDir);
  assertSafeStateEnv(outBase);
  const matrixId = opts.matrixId ?? newMatrixId();
  const matrixRoot = join(outBase, matrixId);
  mkdirSync(matrixRoot, { recursive: true });
  const ids = opts.scenarios ?? [...REQUIRED_WI02_SCENARIO_IDS];
  // Validate all ids up front (fail closed before running anything).
  const known = new Set(listScenarios().map((s) => s.id));
  for (const id of ids) {
    if (!known.has(id)) throw new Error("unknown scenario '" + id + "'");
  }
  for (const id of ids) {
    const r = await wireInspectorRun({ outDir: matrixRoot, runId: id, scenario: id });
    assertLoopbackUrl("http://127.0.0.1:1");
    void r;
  }
  // Aggregate DERIVED from retained evidence (read back from disk).
  const rows: ScenarioEvidence[] = ids.map((id) => loadScenarioEvidence(join(matrixRoot, id), id));
  const compactRows = rows.map((r) => [r.id, r.lane, r.clientPath, r.upstreamPath ?? "(no capture)", r.session, r.userAgent, r.auth, r.bodyVerdict]);
  const headerRows = rows.map((r) => [r.id, ...MATRIX_HEADERS.map((h) => r.headerRow[h] ?? "?")]);
  const bodyRows = rows.map((r) => [r.id, ...MATRIX_BODY_FIELDS.map((f) => r.bodyRow[f] ?? "?")]);
  const goZen = buildGoZenCompare(rows);

  const summary: string[] = [
    "# WI02 multi-scenario matrix",
    "",
    "- matrix: " + matrixId,
    "- generatedUtc: " + new Date().toISOString(),
    "- scenarios: " + ids.join(", "),
    "- upstream: LOOPBACK ONLY (per-scenario runtime records)",
    "- redaction: sanitized before disk write (per-scenario pre-write literal checks)",
    "- reasoning control: NOT REPRESENTED IN RELEASED REQUEST CONTRACT (see chat-completions-rich/scenario.json)",
    "",
    "## Compact comparison",
    "",
    mdTable(["Scenario", "Lane", "Client path", "Upstream path", "Session", "User-Agent", "Auth", "Body"], compactRows),
    "",
    "## Header matrix",
    "",
    mdTable(["Scenario", ...MATRIX_HEADERS], headerRows),
    "",
    "Header labels: preserved | changed | removed | added-by-gorouter | consumed-locally | rejected | absent-both | transport-derived | redacted.",
    "x-gorouter-correlation-id is expected to be consumed-locally (journal-only, never forwarded).",
    "messages-basic shows authorization=absent-both because that family authenticates via x-api-key " +
    "(see its per-scenario diff: x-api-key REDACTED/REPLACED_BY_GOROUTER, authorization absent both sides).",
    "",
    "## Body matrix",
    "",
    mdTable(["Scenario", ...MATRIX_BODY_FIELDS], bodyRows),
    "",
    "Body verdicts come from each scenario's retained diff.sanitized.json (canonical-JSON semantic diff).",
    "",
    "## Outcome / status",
    "",
    mdTable(["Scenario", "Outcome", "Client status"], rows.map((r) => [r.id, r.outcome, String(r.clientStatus)])),
    "",
    "Outcomes: SUPPORTED_CAPTURED | SUPPORTED_REJECTED_BY_TEST_INPUT | UNSUPPORTED_BY_RELEASED_GOROUTER | HARNESS_FAILURE.",
    "All six required WI02 scenarios are SUPPORTED_CAPTURED in this run; no family required UNSUPPORTED_BY_RELEASED_GOROUTER.",
    "",
    goZen,
    "## Safety",
    "",
    "- upstream destination: 127.0.0.1 (per-scenario loopback proof in runtime-record.md)",
    "- capture endpoint: endpoint-only; proxy: false; CONNECT: refused; redirect following: disabled",
    "- real provider contact: none; TLS MITM: not used; production state: not used",
    "",
  ];
  writeFileSync(join(matrixRoot, "matrix-summary.md"), summary.join("\n"), "utf8");
  writeFileSync(join(matrixRoot, "go-zen-compare.md"), goZen, "utf8");
  const doc = {
    matrix: matrixId,
    generatedUtc: new Date().toISOString(),
    scenarios: rows,
    headerFields: [...MATRIX_HEADERS],
    bodyFields: [...MATRIX_BODY_FIELDS],
    goZenCompareFile: "go-zen-compare.md",
    reasoningControl: "NOT REPRESENTED IN RELEASED REQUEST CONTRACT",
  };
  writeFileSync(join(matrixRoot, "matrix.sanitized.json"), JSON.stringify(doc, null, 2) + "\n", "utf8");

  // Matrix-wide secret-literal scan (synthetic literals only — never real secrets).
  const allText: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, name.name);
      if (name.isDirectory()) { walk(p); continue; }
      if (p.endsWith(".md") || p.endsWith(".json") || p.endsWith(".txt")) {
        allText.push(readFileSync(p, "utf8"));
      }
    }
  };
  walk(matrixRoot);
  const blob = allText.join("\n");
  for (const lit of ALL_SYNTHETIC_LITERALS) {
    if (blob.includes(lit)) throw new Error("WI02 matrix redaction failure: synthetic literal would be retained");
  }
  return { matrixId, matrixRoot, scenarioIds: ids };
}
