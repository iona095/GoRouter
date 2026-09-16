/**
 * WI01 run — synthetic client -> GoRouter (in-process, isolated state) ->
 * loopback capture upstream -> sanitized diff.
 *
 * Safety:
 * - Only synthetic credentials (WI01-SYNTHETIC-*-TEST-ONLY).
 * - Isolated state dir INSIDE WireInspector/output (never production state).
 * - Upstream MUST be loopback http (assertLoopbackUrl); anything else fails closed.
 * - Redaction happens in memory BEFORE any disk write; raw secrets never touch disk.
 * - Capture server is an endpoint only (no proxy/CONNECT/redirect/relay).
 * - Client fetch uses redirect:"manual" (never follows redirects).
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { assertLoopbackUrl } from "./loopback.ts";
import { startCaptureServer } from "./capture-server.ts";
import { getScenario, materializeHeaders, type WireScenario } from "./scenarios.ts";
import { sanitizeHeaders, sanitizeBody, authMetaForValue } from "./redaction.ts";
import { sha256Hex, canonicalJson } from "./normalize.ts";
import { buildDiff, renderDiffText } from "./diff.ts";

// Read-only reference imports: GoRouter v1.0.0 source at the released commit.
// WI01 never patches these files; they are exercised in-process with fully
// synthetic isolated state (accepted harness seam: isolated state root +
// loopback upstream + startupRefresh:false).
// eslint-disable-next-line
import { resolvePaths, ensureStateDirs } from "../../../src/paths.ts";
// eslint-disable-next-line
import { createStateStore, makeAccount } from "../../../src/state.ts";
// eslint-disable-next-line
import { newRef, type SecretStore } from "../../../src/secret-store.ts";
// eslint-disable-next-line
import { lockPathFor, withFileLock } from "../../../src/lock.ts";
// eslint-disable-next-line
import { createJournal } from "../../../src/journal.ts";
// eslint-disable-next-line
import { createServer } from "../../../src/server.ts";

export const WI01_LOCAL_KEY = "WI01-SYNTHETIC-LOCAL-KEY-001-TEST-ONLY-NOT-REAL";
export const WI01_ACCOUNT_KEY = "WI01-SYNTHETIC-ACCOUNT-KEY-001-TEST-ONLY-NOT-REAL";
export const WI02_GO_ACCOUNT_KEY = "WI02-SYNTHETIC-GO-ACCOUNT-KEY-001-TEST-ONLY-NOT-REAL";
export const WI02_ZEN_ACCOUNT_KEY = "WI02-SYNTHETIC-ZEN-ACCOUNT-KEY-001-TEST-ONLY-NOT-REAL";
export const WI02_GO_ALIAS = "wi02-synthetic-go";
export const WI02_ZEN_ALIAS = "wi02-synthetic-zen";
/** All synthetic credential literals that must never reach retained output. */
export const ALL_SYNTHETIC_LITERALS = [WI01_LOCAL_KEY, WI01_ACCOUNT_KEY, WI02_GO_ACCOUNT_KEY, WI02_ZEN_ACCOUNT_KEY];
export const WI01_SESSION = "WI01-SESSION-001";
export const WI01_USER_AGENT = "WI01-Synthetic-Client/1.0";
export const WI01_MODEL = "wi01-synthetic-model";
export const WI01_ACCOUNT_ALIAS = "wi01-synthetic";

export function memSecrets(): SecretStore {
  const map = new Map<string, string>();
  return {
    put(ref, value) { map.set(ref, value); },
    get(ref) {
      const v = map.get(ref);
      if (v === undefined) throw new Error("secret missing: " + ref);
      return v;
    },
    delete(ref) { return map.delete(ref); },
    exists(ref) { return map.has(ref); },
  };
}

import { resolveOutBase, assertSafeStateEnv, assertStateUnderOut } from "./tool-root.ts";

export interface RunOptions {
  outDir?: string;
  runId?: string;
  scenario?: string;
  keepStateDir?: boolean;
}

export type ScenarioOutcome =
  | "SUPPORTED_CAPTURED"
  | "SUPPORTED_REJECTED_BY_TEST_INPUT"
  | "HARNESS_FAILURE";

export interface RunResult {
  runId: string;
  outPath: string;
  summary: string;
  scenarioId: string;
  lane: string;
  outcome: ScenarioOutcome;
  clientStatus: number;
  upstreamHit: boolean;
}

function newRunId(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp =
    d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()) +
    "-" + pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + pad(d.getUTCSeconds());
  const rand = Math.floor(Math.random() * 0xffff).toString(16).padStart(4, "0");
  return "run-" + stamp + "-" + rand;
}

export async function wireInspectorRun(opts: RunOptions = {}): Promise<RunResult> {
  const runId = opts.runId ?? newRunId();
  const scenarioId = opts.scenario ?? "chat-completions-stream";
  // Fail closed: unknown scenario names never silently run chat/completions.
  const scn: WireScenario = getScenario(scenarioId);
  const scenario = scenarioId;
  const outBase = resolveOutBase(opts.outDir);
  assertSafeStateEnv(outBase);
  const outPath = join(outBase, runId);
  mkdirSync(outPath, { recursive: true });

  const startedUtc = new Date().toISOString();
  const startedMs = Date.now();

  // 1. Loopback capture upstream (endpoint only).
  const capture = await startCaptureServer();
  assertLoopbackUrl(capture.baseUrl);

  // 2. Isolated synthetic state INSIDE WireInspector/output (never production).
  const stateParent = join(outBase, ".wi-state-" + runId);
  mkdirSync(stateParent, { recursive: true });
  const stateDir = mkdtempSync(join(stateParent, "gorouter-wi01-"));
  // Double-check isolation: state must live beneath the resolved output base.
  try {
    assertStateUnderOut(stateDir, outBase);
  } catch (e) {
    capture.stop();
    throw new Error("WI01 state dir escaped isolated output base (refusing)");
  }

  const paths = resolvePaths(stateDir);
  ensureStateDirs(paths);
  const secrets = memSecrets();
  const state = createStateStore(paths, secrets);
  withFileLock(lockPathFor(paths.state), 10_000, () => state.ensureV2());
  const localRef = newRef();
  secrets.put(localRef, WI01_LOCAL_KEY);
  // Validate loopback through GoRouter's own validator shape too (defense in depth).
  assertLoopbackUrl(capture.baseUrl);
  state.mutate((s) => {
    s.localCredentialRef = localRef;
    s.settings.port = 0;
    s.settings.host = "127.0.0.1";
    s.settings.upstreamGo = capture.baseUrl;
    s.settings.upstreamZen = capture.baseUrl;
  });
  // Seed BOTH lanes with distinct synthetic accounts so go and zen scenarios
  // each exercise their real lane (WI01 alias retained for S1 compat).
  const wi01Ref = newRef();
  secrets.put(wi01Ref, WI01_ACCOUNT_KEY);
  const goRef = newRef();
  secrets.put(goRef, WI02_GO_ACCOUNT_KEY);
  const zenRef = newRef();
  secrets.put(zenRef, WI02_ZEN_ACCOUNT_KEY);
  state.mutate((s) => {
    s.accounts.push(makeAccount(WI01_ACCOUNT_ALIAS, wi01Ref));
    s.accounts.push(makeAccount(WI02_GO_ALIAS, goRef));
    s.accounts.push(makeAccount(WI02_ZEN_ALIAS, zenRef));
  });
  {
    const s = state.read();
    const wi01 = s.accounts.find((x) => x.alias === WI01_ACCOUNT_ALIAS);
    const go = s.accounts.find((x) => x.alias === WI02_GO_ALIAS);
    const zen = s.accounts.find((x) => x.alias === WI02_ZEN_ALIAS);
    if (!wi01 || !go || !zen) throw new Error("WI synthetic account seeding failed");
    // GO lane: WI01 baseline keeps its historical account; other GO scenarios
    // use the WI02 GO account. ZEN lane always uses the WI02 ZEN account.
    const goAlias = scn.id === "chat-completions-stream" ? wi01.id : go.id;
    state.mutate((st) => {
      st.routes.go.accountId = goAlias;
      st.routes.zen.accountId = zen.id;
    });
  }
  const activeAccountAlias = scn.id === "chat-completions-stream" ? WI01_ACCOUNT_ALIAS : scn.accountAlias;

  const journal = createJournal(paths.journalDb, 1, 1000);
  const server = createServer({ state, journal, paths, startupRefresh: false });
  await server.serve();
  const gorouterPort = server.port();
  const gorouterBase = "http://127.0.0.1:" + gorouterPort;
  assertLoopbackUrl(gorouterBase);

  // 3. Execute the selected scenario definition (never hardcoded chat).
  const clientPath = scn.clientPath;
  const clientQuery = scn.query ?? "";
  const clientBodyObj = structuredClone(scn.body) as Record<string, unknown>;
  const clientBodyText = JSON.stringify(clientBodyObj);
  const clientHeadersRaw: Record<string, string> = materializeHeaders(scn, WI01_LOCAL_KEY);
  const inboundTimestamp = new Date().toISOString();
  const gorouterUrl = gorouterBase + clientPath + clientQuery;

  let clientStatus = 0;
  let clientBody = "";
  let clientError: string | null = null;
  try {
    const res = await fetch(gorouterUrl, {
      method: scn.method,
      headers: clientHeadersRaw,
      body: clientBodyText,
      redirect: "manual",
    });
    clientStatus = res.status;
    clientBody = await res.text().catch(() => "");
  } catch (e) {
    clientError = e instanceof Error ? e.message : String(e);
  }

  // 4. Outbound capture: exactly what GoRouter emitted to loopback.
  const deadline = Date.now() + 10_000;
  while (capture.requests.length === 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
  }
  const hit = capture.requests[0] ?? null;

  // 5. Stop + cleanup (journal close, server stop, state dir removal).
  const stopErrors: string[] = [];
  try { server.stop(); } catch (e) { stopErrors.push("router stop: " + (e instanceof Error ? e.message : String(e))); }
  try { journal.close(); } catch (e) { stopErrors.push("journal close: " + (e instanceof Error ? e.message : String(e))); }
  capture.stop();
  if (!opts.keepStateDir) {
    // Windows sqlite/AV may hold journal.db briefly after close: retry.
    let cleaned = false;
    let lastErr: string | null = null;
    for (let attempt = 0; attempt < 5 && !cleaned; attempt++) {
      try {
        rmSync(stateParent, { recursive: true, force: true });
        cleaned = true;
      } catch (e) {
        lastErr = e instanceof Error ? e.message : String(e);
        await new Promise((rr) => setTimeout(rr, 150 * (attempt + 1)));
      }
    }
    if (!cleaned) stopErrors.push("state cleanup: " + (lastErr ?? "unknown") + " (synthetic isolated state left under " + stateParent + "; contains no plaintext secrets — refs only, in-memory keys dropped)");
    try { rmSync(stateDir, { recursive: true, force: true }); } catch { /* parent already removed */ }
  }

  if (clientError) {
    throw new Error("WI synthetic client failed [" + scn.id + "]: " + clientError);
  }
  // Rejection observation (§19): a local 4xx/5xx with zero upstream bytes is a
  // recorded outcome, never a capture PASS. Matrix distinguishes these states.
  const upstreamHit = hit !== null;
  let outcome: ScenarioOutcome = "SUPPORTED_CAPTURED";
  if (!upstreamHit) {
    outcome = clientStatus >= 400 && clientStatus < 600
      ? "SUPPORTED_REJECTED_BY_TEST_INPUT"
      : "HARNESS_FAILURE";
  }

  // 6. Build raw records in memory, diff, THEN sanitize before disk write.
  const inboundRaw = {
    method: scn.method,
    path: clientPath,
    query: clientQuery,
    headers: clientHeadersRaw,
    body: clientBodyObj,
  };
  const hitUrl = hit ? new URL(hit.url) : null;
  let outboundBody: unknown = {};
  if (hit) {
    try { outboundBody = hit.bodyText ? JSON.parse(hit.bodyText) : {}; }
    catch { outboundBody = { _raw: hit.bodyText.slice(0, 2000) }; }
  }
  const outboundRaw = hit && hitUrl ? {
    method: hit.method,
    path: hitUrl.pathname,
    query: hitUrl.search,
    headers: hit.headers,
    body: outboundBody,
  } : null;
  const diff = outboundRaw ? buildDiff(inboundRaw, outboundRaw) : null;

  // Sanitized retained records (redaction BEFORE write).
  const inboundAuthRaw =
    inboundRaw.headers["authorization"] ??
    inboundRaw.headers["x-api-key"] ??
    inboundRaw.headers["x-goog-api-key"] ?? null;
  const inboundSanitized = {
    timestampUtc: inboundTimestamp,
    method: inboundRaw.method,
    path: inboundRaw.path,
    query: inboundRaw.query,
    headers: sanitizeHeaders(inboundRaw.headers),
    headerMeta: {
      authorization: authMetaForValue(inboundAuthRaw),
    },
    body: sanitizeBody(inboundRaw.body),
    bodySha256: sha256Hex(clientBodyText),
    clientEndpoint: "synthetic-client (loopback)",
    gorouterEndpoint: gorouterUrl,
    scenario,
  };
  const outboundSanitized = outboundRaw && hit && hitUrl ? {
    timestampUtc: hit.timestampUtc,
    method: outboundRaw.method,
    path: outboundRaw.path,
    query: outboundRaw.query,
    headers: sanitizeHeaders(outboundRaw.headers),
    headerMeta: {
      authorization: authMetaForValue(outboundRaw.headers["authorization"] ?? outboundRaw.headers["x-api-key"] ?? outboundRaw.headers["x-goog-api-key"] ?? null),
    },
    body: sanitizeBody(outboundRaw.body),
    bodySha256: sha256Hex(hit.bodyText),
    gorouterSourceEndpoint: "gorouter (loopback, ephemeral)",
    syntheticUpstreamEndpoint: capture.baseUrl + hitUrl.pathname + hitUrl.search,
    upstreamHost: hitUrl.host,
    captured: true,
  } : {
    captured: false,
    outcome,
    clientStatus,
    note: "no upstream request reached the synthetic endpoint (local rejection or harness failure); not a capture PASS",
  };

  // Prove no secret literal survives into retained JSON.
  const ALL_SYNTHETIC_LITERALS = [WI01_LOCAL_KEY, WI01_ACCOUNT_KEY, WI02_GO_ACCOUNT_KEY, WI02_ZEN_ACCOUNT_KEY];
  const retainedPreview = JSON.stringify([inboundSanitized, outboundSanitized, diff]);
  for (const lit of ALL_SYNTHETIC_LITERALS) {
    if (retainedPreview.includes(lit)) {
      throw new Error("WI redaction failure: synthetic secret literal would reach disk (aborting write)");
    }
  }

  const diffSanitized = diff ? {
    scenario,
    lane: scn.lane,
    outcome,
    method: diff.method,
    path: diff.path,
    query: diff.query,
    session: diff.session,
    userAgent: diff.userAgent,
    authorization: diff.authorization,
    headers: diff.headers,
    body: {
      identical: diff.body.identical,
      added: diff.body.added,
      removed: diff.body.removed,
      changed: diff.body.changed,
      fields: diff.body.fields,
      inboundCanonical: diff.body.inboundCanonical,
      outboundCanonical: diff.body.outboundCanonical,
    },
  } : {
    scenario,
    lane: scn.lane,
    outcome,
    clientStatus,
    captured: false,
    note: "no outbound capture; see rejection observation",
  };
  const diffText = diff ? renderDiffText(diff) : [
    "GoRouter WI02 wire diff (sanitized)",
    "================================",
    "",
    "outcome: " + outcome,
    "client status: " + clientStatus,
    "upstream capture: NONE (local rejection; not a capture PASS)",
    "",
  ].join("\n");

  // 7. Write retained sanitized outputs.
  writeFileSync(join(outPath, "inbound.sanitized.json"), JSON.stringify(inboundSanitized, null, 2) + "\n", "utf8");
  writeFileSync(join(outPath, "outbound.sanitized.json"), JSON.stringify(outboundSanitized, null, 2) + "\n", "utf8");
  writeFileSync(join(outPath, "diff.sanitized.json"), JSON.stringify(diffSanitized, null, 2) + "\n", "utf8");
  writeFileSync(join(outPath, "diff.txt"), diffText, "utf8");

  const upstreamHost = hitUrl ? hitUrl.host : "(none — no upstream capture)";
  const modelOf = (b: unknown): string => {
    if (typeof b === "object" && b !== null && "model" in (b as Record<string, unknown>)) {
      return String((b as Record<string, unknown>)["model"]);
    }
    return "(none)";
  };
  const summaryLines = diff && outboundRaw ? [
    "GoRouter Wire Inspector",
    "",
    "Scenario:",
    scenario,
    "",
    "Lane:",
    scn.lane,
    "",
    "Outcome:",
    outcome,
    "",
    "x-opencode-session:",
    diff.session.verdict,
    "",
    "User-Agent:",
    diff.userAgent.verdict,
    "",
    "Authorization:",
    diff.authorization.classification,
    "(values redacted)",
    "",
    "Upstream destination:",
    upstreamHost,
    "",
    "External network:",
    "NONE",
    "",
    "Client -> GoRouter:",
    "  " + inboundRaw.method + " " + inboundRaw.path + " (status " + clientStatus + ")",
    "GoRouter -> synthetic upstream:",
    "  " + outboundRaw.method + " " + outboundRaw.path + outboundRaw.query,
    "Body identical: " + diff.body.identical,
  ] : [
    "GoRouter Wire Inspector",
    "",
    "Scenario:",
    scenario,
    "",
    "Lane:",
    scn.lane,
    "",
    "Outcome:",
    outcome,
    "(no upstream capture; not a capture PASS)",
    "",
    "Client -> GoRouter:",
    "  " + inboundRaw.method + " " + inboundRaw.path + " (status " + clientStatus + ")",
    "",
    "External network:",
    "NONE",
    "",
  ];
  const summary = summaryLines.join("\n") + "\n";
  writeFileSync(join(outPath, "run-summary.md"), summary, "utf8");

  const scenarioMeta = {
    scenarioId: scn.id,
    description: scn.description,
    lane: scn.lane,
    method: scn.method,
    clientPath: scn.clientPath,
    query: scn.query ?? "",
    upstreamPath: hitUrl ? hitUrl.pathname + hitUrl.search : null,
    expectedUpstreamPath: scn.expectedUpstreamPath,
    routeEvidence: scn.routeEvidence,
    observationProfile: scn.observationProfile,
    accountAlias: activeAccountAlias,
    model: modelOf(clientBodyObj),
    authKind: scn.authKind,
    support: scn.support,
    outcome,
    clientStatus,
    stream: (clientBodyObj as Record<string, unknown>)["stream"] ?? null,
    reasoningControl: "NOT REPRESENTED IN RELEASED REQUEST CONTRACT",
  };
  const runtimeLines = [
    "# WI02 runtime record",
    "",
    "- runId: " + runId,
    "- startedUtc: " + startedUtc,
    "- finishedUtc: " + new Date().toISOString(),
    "- durationMs: " + (Date.now() - startedMs),
    "- scenario: " + scenario,
    "- lane: " + scn.lane,
    "- outcome: " + outcome,
    "- synthetic client: " + scn.method + " " + clientPath + (clientQuery || ""),
    "- gorouter endpoint: " + gorouterUrl,
    "- synthetic upstream base: " + capture.baseUrl,
    "- upstream host: " + upstreamHost + " (loopback proven via assertLoopbackUrl)",
    "- upstream requests captured: " + capture.requests.length,
    "- client status: " + clientStatus,
    "- client error: " + (clientError ?? "none"),
    "- external network: NONE (all destinations 127.0.0.1, redirect:manual, no relay)",
    "- TLS MITM: NOT USED (plain http loopback only)",
    "- production state: NOT USED (isolated temp state under WireInspector/output, GOROUTER_STATE_DIR=" + (process.env.GOROUTER_STATE_DIR ?? "(unset)") + ")",
    "- real credentials: NOT USED (WI01-SYNTHETIC-*-TEST-ONLY only)",
    "- real provider contact: NONE",
    "- redaction: in-memory sanitize before write; synthetic literals absent from retained JSON (verified pre-write)",
    "- state cleanup: " + (opts.keepStateDir ? "KEPT (debug)" : "removed (" + stateParent + ")"),
    "- stop errors: " + (stopErrors.length ? stopErrors.join("; ") : "none"),
    "- bun: " + (typeof Bun !== "undefined" ? Bun.version : "unknown"),
    "",
  ];
  writeFileSync(join(outPath, "runtime-record.md"), runtimeLines.join("\n"), "utf8");
  writeFileSync(join(outPath, "scenario.json"), JSON.stringify(scenarioMeta, null, 2) + "\n", "utf8");

  return { runId, outPath, summary, scenarioId: scn.id, lane: scn.lane, outcome, clientStatus, upstreamHit: hit !== null };
}
