/**
 * WI03 response-run — scripted loopback upstream -> GoRouter -> synthetic client.
 *
 * Safety (same discipline as WI01/WI02 run.ts):
 * - Only synthetic credentials (WI*-SYNTHETIC-*-TEST-ONLY).
 * - Isolated state dir INSIDE WireInspector/output (never production state).
 * - Upstream MUST be loopback http (assertLoopbackUrl); anything else fails closed.
 * - Redaction happens in memory BEFORE any disk write.
 * - Scripted fixture is an endpoint only (no proxy/CONNECT/redirect/relay).
 * - Client fetch uses redirect:"manual" (never follows redirects).
 * - The selected response scenario owns the emitted response; the fixture
 *   never sniffs request bodies to choose a profile.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { assertLoopbackUrl } from "./loopback.ts";
import { startCaptureServer, type ScriptedResponseProfile } from "./capture-server.ts";
import { sanitizeHeaders, sanitizeBody } from "./redaction.ts";
import { sha256Hex } from "./normalize.ts";
import { buildDiff } from "./diff.ts";
import { parseSSE } from "./sse.ts";
import {
  diffResponseHeaders,
  diffJsonBodies,
  diffSSE,
  renderResponseDiffText,
} from "./response-diff.ts";
import { getResponseScenario, materializeResponseHeaders } from "./response-scenarios.ts";
import {
  WI01_LOCAL_KEY,
  WI01_ACCOUNT_KEY,
  WI02_GO_ACCOUNT_KEY,
  WI02_ZEN_ACCOUNT_KEY,
  WI01_ACCOUNT_ALIAS,
  WI02_GO_ALIAS,
  WI02_ZEN_ALIAS,
  ALL_SYNTHETIC_LITERALS,
  memSecrets,
} from "./run.ts";

// Read-only reference imports: GoRouter v1.0.0 source at the released commit.
// WI03 never patches these files; they are exercised in-process with fully
// synthetic isolated state.
// eslint-disable-next-line
import { resolvePaths, ensureStateDirs } from "../../../src/paths.ts";
// eslint-disable-next-line
import { createStateStore, makeAccount } from "../../../src/state.ts";
// eslint-disable-next-line
import { newRef } from "../../../src/secret-store.ts";
// eslint-disable-next-line
import { lockPathFor, withFileLock } from "../../../src/lock.ts";
// eslint-disable-next-line
import { createJournal } from "../../../src/journal.ts";
// eslint-disable-next-line
import { createServer } from "../../../src/server.ts";

export type ResponseOutcome =
  | "SUPPORTED_CAPTURED"
  | "SUPPORTED_REJECTED_BY_TEST_INPUT"
  | "HARNESS_FAILURE";

export interface ResponseRunOptions {
  outDir?: string;
  runId?: string;
  scenario?: string;
  keepStateDir?: boolean;
}

export interface ResponseRunResult {
  runId: string;
  outPath: string;
  scenarioId: string;
  lane: string;
  outcome: ResponseOutcome;
  clientStatus: number;
  upstreamStatus: number;
  summary: string;
}

function newResponseRunId(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp =
    d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()) +
    "-" + pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + pad(d.getUTCSeconds());
  const rand = Math.floor(Math.random() * 0xffff).toString(16).padStart(4, "0");
  return "response-" + stamp + "-" + rand;
}

import { resolveOutBase, assertSafeStateEnv, assertStateUnderOut } from "./tool-root.ts";

function headersToRecord(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((v, k) => { out[k] = v; });
  return out;
}

export async function wireResponseRun(opts: ResponseRunOptions = {}): Promise<ResponseRunResult> {
  const runId = opts.runId ?? newResponseRunId();
  const scenarioId = opts.scenario ?? "chat-json-200";
  // Fail closed: unknown response scenario ids never fall back to a default.
  const scn = getResponseScenario(scenarioId);
  const outBase = resolveOutBase(opts.outDir);
  assertSafeStateEnv(outBase);
  const outPath = join(outBase, runId);
  mkdirSync(outPath, { recursive: true });

  const startedUtc = new Date().toISOString();
  const startedMs = Date.now();

  // Scripted profile owned by the selected scenario (no body sniffing).
  const scriptedLogicalText = scn.responseKind === "json"
    ? JSON.stringify(scn.jsonBody)
    : (scn.sseWrites ?? []).join("");
  const profile: ScriptedResponseProfile = {
    status: scn.upstreamStatus,
    headers: { ...scn.upstreamHeaders },
    ...(scn.responseKind === "json"
      ? { jsonText: scriptedLogicalText }
      : { sseWrites: [...(scn.sseWrites ?? [])], sseWriteDelayMs: 5 }),
  };

  // 1. Scripted loopback upstream (endpoint only).
  const capture = await startCaptureServer({ responseProfile: profile });
  assertLoopbackUrl(capture.baseUrl);

  // 2. Isolated synthetic state INSIDE WireInspector/output (never production).
  const stateParent = join(outBase, ".wi-state-" + runId);
  mkdirSync(stateParent, { recursive: true });
  const stateDir = mkdtempSync(join(stateParent, "gorouter-wi03-"));
  try {
    assertStateUnderOut(stateDir, outBase);
  } catch {
    capture.stop();
    throw new Error("WI03 state dir escaped isolated output base (refusing)");
  }

  const paths = resolvePaths(stateDir);
  ensureStateDirs(paths);
  const secrets = memSecrets();
  const state = createStateStore(paths, secrets);
  withFileLock(lockPathFor(paths.state), 10_000, () => state.ensureV2());
  const localRef = newRef();
  secrets.put(localRef, WI01_LOCAL_KEY);
  assertLoopbackUrl(capture.baseUrl);
  state.mutate((s) => {
    s.localCredentialRef = localRef;
    s.settings.port = 0;
    s.settings.host = "127.0.0.1";
    s.settings.upstreamGo = capture.baseUrl;
    s.settings.upstreamZen = capture.baseUrl;
  });
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
    const target = s.accounts.find((x) => x.alias === scn.accountAlias);
    if (!target) throw new Error("WI03 synthetic account seeding failed");
    state.mutate((st) => {
      if (scn.lane === "go") {
        st.routes.go.accountId = target.id;
        st.routes.zen.accountId = s.accounts.find((x) => x.alias === WI02_ZEN_ALIAS)!.id;
      } else {
        st.routes.zen.accountId = target.id;
        st.routes.go.accountId = s.accounts.find((x) => x.alias === WI02_GO_ALIAS)!.id;
      }
    });
  }

  const journal = createJournal(paths.journalDb, 1, 1000);
  const server = createServer({ state, journal, paths, startupRefresh: false });
  await server.serve();
  const gorouterPort = server.port();
  const gorouterBase = "http://127.0.0.1:" + gorouterPort;
  assertLoopbackUrl(gorouterBase);

  // 3. Synthetic client request (bytes owned by the response scenario).
  const clientBodyObj = structuredClone(scn.body) as Record<string, unknown>;
  const clientBodyText = JSON.stringify(clientBodyObj);
  const clientHeadersRaw = materializeResponseHeaders(scn, WI01_LOCAL_KEY);
  const inboundTimestamp = new Date().toISOString();
  const gorouterUrl = gorouterBase + scn.clientPath;

  let clientStatus = 0;
  let clientStatusText = "";
  let respHeadersRaw: Record<string, string> = {};
  let clientBytes = new Uint8Array(0);
  const clientReads: number[] = [];
  let clientError: string | null = null;
  try {
    const res = await fetch(gorouterUrl, {
      method: scn.method,
      headers: clientHeadersRaw,
      body: clientBodyText,
      redirect: "manual",
    });
    clientStatus = res.status;
    clientStatusText = res.statusText ?? "";
    respHeadersRaw = headersToRecord(res.headers);
    // Streamed read: record every ReadableStream read length, then reassemble.
    const reader = res.body ? res.body.getReader() : null;
    const chunks: Uint8Array[] = [];
    if (reader) {
      const deadline = Date.now() + 20_000;
      for (;;) {
        if (Date.now() > deadline) throw new Error("client stream read timed out");
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.byteLength > 0) {
          clientReads.push(value.byteLength);
          chunks.push(value);
        }
      }
      try { reader.releaseLock(); } catch { /* already released */ }
    }
    const total = chunks.reduce((n, c) => n + c.byteLength, 0);
    clientBytes = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { clientBytes.set(c, off); off += c.byteLength; }
  } catch (e) {
    clientError = e instanceof Error ? e.message : String(e);
  }

  // 4. Request-side causality: the fixture must have been reached.
  const deadline = Date.now() + 10_000;
  while (capture.requests.length === 0 && Date.now() < deadline && !clientError) {
    await new Promise((r) => setTimeout(r, 25));
  }
  const hit = capture.requests[0] ?? null;

  // 5. Stop + cleanup.
  const stopErrors: string[] = [];
  try { server.stop(); } catch (e) { stopErrors.push("router stop: " + (e instanceof Error ? e.message : String(e))); }
  try { journal.close(); } catch (e) { stopErrors.push("journal close: " + (e instanceof Error ? e.message : String(e))); }
  capture.stop();
  if (!opts.keepStateDir) {
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
    if (!cleaned) stopErrors.push("state cleanup: " + (lastErr ?? "unknown"));
    try { rmSync(stateDir, { recursive: true, force: true }); } catch { /* parent already removed */ }
  }

  if (clientError) {
    throw new Error("WI03 synthetic client failed [" + scn.id + "]: " + clientError);
  }

  const clientText = new TextDecoder().decode(clientBytes);
  const fixtureWrites = capture.scriptedWrites.map((w) => w.bytes);

  // Rejection observation: local GoRouter rejection (no fixture hit) is a
  // recorded outcome, never a capture PASS.
  let outcome: ResponseOutcome = "SUPPORTED_CAPTURED";
  if (!hit) {
    outcome = clientStatus >= 400 && clientStatus < 600 ? "SUPPORTED_REJECTED_BY_TEST_INPUT" : "HARNESS_FAILURE";
  }

  // Request-side evidence (WI02 machinery proves the fixture was reached).
  // NOTE: clientHeadersRaw now holds RESPONSE headers; request headers are
  // rebuilt from the scenario definition (identical bytes to what was sent).
  const requestHeaders = materializeResponseHeaders(scn, WI01_LOCAL_KEY);
  const inboundForDiff = { method: scn.method, path: scn.clientPath, query: "", headers: requestHeaders, body: clientBodyObj };
  let outboundForDiff: { method: string; path: string; query: string; headers: Record<string, string>; body: unknown } | null = null;
  if (hit) {
    const hitUrl = new URL(hit.url);
    let outboundBody: unknown = {};
    try { outboundBody = hit.bodyText ? JSON.parse(hit.bodyText) : {}; }
    catch { outboundBody = { _raw: hit.bodyText.slice(0, 2000) }; }
    outboundForDiff = { method: hit.method, path: hitUrl.pathname, query: hitUrl.search, headers: hit.headers, body: outboundBody };
  }
  const requestDiff = outboundForDiff ? buildDiff(inboundForDiff, outboundForDiff) : null;

  // Response records. Upstream record comes from the ACTUAL script used
  // (profile + recorded fixture writes), not from re-stated expectations.
  const upstreamRecord = {
    scenarioId: scn.id,
    scripted: true,
    status: scn.upstreamStatus,
    statusText: "",
    headers: sanitizeHeaders({ ...scn.upstreamHeaders }),
    responseKind: scn.responseKind,
    logicalText: scn.responseKind === "json"
      ? JSON.stringify(sanitizeBody(scn.jsonBody))
      : scriptedLogicalText,
    logicalSha256: sha256Hex(scriptedLogicalText),
    canonicalSha256: scn.responseKind === "json" ? sha256Hex(JSON.stringify(scn.jsonBody)) : "",
    sseEvents: scn.responseKind === "sse" ? parseSSE(scriptedLogicalText).map((e) => ({ event: e.event, data: e.data, id: e.id, retry: e.retry })) : [],
    fixtureWrites: [...fixtureWrites],
  };
  const clientRecord = {
    scenarioId: scn.id,
    status: clientStatus,
    statusText: clientStatusText,
    headers: sanitizeHeaders(respHeadersRaw),
    responseKind: scn.responseKind,
    logicalText: scn.responseKind === "json" ? clientText : clientText,
    logicalSha256: sha256Hex(clientText),
    sseEvents: scn.responseKind === "sse" ? parseSSE(clientText).map((e) => ({ event: e.event, data: e.data, id: e.id, retry: e.retry })) : [],
    clientReads: [...clientReads],
  };

  const headerDiffs = hit ? diffResponseHeaders(scn.upstreamHeaders, respHeadersRaw) : [];
  const jsonDiff = hit && scn.responseKind === "json" ? diffJsonBodies(scriptedLogicalText, clientText) : null;
  const sseDiff = hit && scn.responseKind === "sse"
    ? diffSSE(scriptedLogicalText, clientText, fixtureWrites, clientReads)
    : null;

  // Pre-write secret scan (synthetic literals only — never real secrets).
  const retainedPreview = JSON.stringify([upstreamRecord, clientRecord, headerDiffs, jsonDiff, sseDiff, requestDiff]);
  for (const lit of ALL_SYNTHETIC_LITERALS) {
    if (retainedPreview.includes(lit)) {
      throw new Error("WI03 redaction failure: synthetic secret literal would reach disk (aborting write)");
    }
  }

  const responseDiffDoc = hit ? {
    scenarioId: scn.id,
    lane: scn.lane,
    outcome,
    status: {
      upstream: scn.upstreamStatus,
      client: clientStatus,
      verdict: scn.upstreamStatus === clientStatus ? "STATUS_PRESERVED" : "STATUS_CHANGED",
    },
    headers: headerDiffs,
    json: jsonDiff ? {
      verdict: jsonDiff.verdict,
      upstreamSha256: jsonDiff.upstreamSha256,
      clientSha256: jsonDiff.clientSha256,
      upstreamCanonicalSha256: jsonDiff.upstreamCanonicalSha256,
      clientCanonicalSha256: jsonDiff.clientCanonicalSha256,
      added: jsonDiff.added,
      removed: jsonDiff.removed,
      changed: jsonDiff.changed,
    } : null,
    sse: sseDiff ? {
      bytesVerdict: sseDiff.bytesVerdict,
      sequenceVerdict: sseDiff.sequenceVerdict,
      chunkingVerdict: sseDiff.chunkingVerdict,
      upstreamSha256: sseDiff.upstreamSha256,
      clientSha256: sseDiff.clientSha256,
      upstreamEventNames: sseDiff.upstreamEventNames,
      clientEventNames: sseDiff.clientEventNames,
      upstreamData: sseDiff.upstreamData,
      clientData: sseDiff.clientData,
      upstreamWrites: sseDiff.upstreamWrites,
      clientReads: sseDiff.clientReads,
    } : null,
  } : {
    scenarioId: scn.id,
    lane: scn.lane,
    outcome,
    clientStatus,
    captured: false,
    note: "no fixture response was reached; not a capture PASS",
  };
  const diffText = hit ? renderResponseDiffText({
    scenarioId: scn.id,
    upstreamStatus: scn.upstreamStatus,
    clientStatus,
    headers: headerDiffs,
    json: jsonDiff,
    sse: sseDiff,
  }) : "WI03 response diff: no capture (" + outcome + ", client status " + clientStatus + ")\n";

  // Retained files (all sanitized).
  const requestInbound = {
    timestampUtc: inboundTimestamp,
    method: scn.method,
    path: scn.clientPath,
    query: "",
    headers: sanitizeHeaders(requestHeaders),
    body: sanitizeBody(clientBodyObj),
    bodySha256: sha256Hex(clientBodyText),
    clientEndpoint: "synthetic-client (loopback)",
    gorouterEndpoint: gorouterUrl,
    scenario: scn.id,
  };
  const hitUrl = hit ? new URL(hit.url) : null;
  const requestOutbound = hit && hitUrl ? {
    timestampUtc: hit.timestampUtc,
    method: hit.method,
    path: hitUrl.pathname,
    query: hitUrl.search,
    headers: sanitizeHeaders(hit.headers),
    bodySha256: sha256Hex(hit.bodyText),
    syntheticUpstreamEndpoint: capture.baseUrl + hitUrl.pathname + hitUrl.search,
    upstreamHost: hitUrl.host,
    captured: true,
  } : { captured: false, outcome, clientStatus };
  writeFileSync(join(outPath, "request-inbound.sanitized.json"), JSON.stringify(requestInbound, null, 2) + "\n", "utf8");
  writeFileSync(join(outPath, "request-outbound.sanitized.json"), JSON.stringify(requestOutbound, null, 2) + "\n", "utf8");
  writeFileSync(join(outPath, "request-diff.sanitized.json"), JSON.stringify(requestDiff ? {
    scenario: scn.id,
    method: requestDiff.method,
    path: requestDiff.path,
    session: requestDiff.session,
    userAgent: requestDiff.userAgent,
    authorization: requestDiff.authorization,
  } : { scenario: scn.id, outcome, captured: false }, null, 2) + "\n", "utf8");
  writeFileSync(join(outPath, "upstream-response.sanitized.json"), JSON.stringify(upstreamRecord, null, 2) + "\n", "utf8");
  writeFileSync(join(outPath, "client-response.sanitized.json"), JSON.stringify(clientRecord, null, 2) + "\n", "utf8");
  writeFileSync(join(outPath, "response-diff.sanitized.json"), JSON.stringify(responseDiffDoc, null, 2) + "\n", "utf8");
  writeFileSync(join(outPath, "response-diff.txt"), diffText, "utf8");

  const scenarioMeta = {
    scenarioId: scn.id,
    description: scn.description,
    requestScenarioId: scn.requestScenarioId,
    lane: scn.lane,
    method: scn.method,
    clientPath: scn.clientPath,
    upstreamPath: hitUrl ? hitUrl.pathname + hitUrl.search : null,
    accountAlias: scn.accountAlias,
    upstreamStatus: scn.upstreamStatus,
    clientStatus,
    outcome,
    responseKind: scn.responseKind,
    expectedObservationProfile: scn.expectedObservationProfile,
  };
  writeFileSync(join(outPath, "response-scenario.json"), JSON.stringify(scenarioMeta, null, 2) + "\n", "utf8");

  const summary = [
    "GoRouter WI03 response inspector",
    "",
    "Scenario:",
    scn.id,
    "",
    "Lane:",
    scn.lane,
    "",
    "Outcome:",
    outcome,
    "",
    "Upstream status:",
    String(scn.upstreamStatus),
    "",
    "Client status:",
    String(clientStatus),
    "",
    "Body/SSE:",
    jsonDiff ? jsonDiff.verdict : sseDiff ? sseDiff.bytesVerdict + " / " + sseDiff.sequenceVerdict : "(no capture)",
    "",
    "External network:",
    "NONE",
    "",
  ].join("\n") + "\n";
  writeFileSync(join(outPath, "response-summary.md"), summary, "utf8");

  const runtimeLines = [
    "# WI03 response runtime record",
    "",
    "- runId: " + runId,
    "- startedUtc: " + startedUtc,
    "- finishedUtc: " + new Date().toISOString(),
    "- durationMs: " + (Date.now() - startedMs),
    "- scenario: " + scn.id,
    "- lane: " + scn.lane,
    "- outcome: " + outcome,
    "- client route: " + scn.method + " " + scn.clientPath,
    "- gorouter endpoint: " + gorouterUrl,
    "- synthetic upstream base: " + capture.baseUrl,
    "- upstream bind: 127.0.0.1 (loopback proven via assertLoopbackUrl)",
    "- upstream requests captured: " + capture.requests.length,
    "- fixture writes: [" + fixtureWrites.join(", ") + "]",
    "- client reads: [" + clientReads.join(", ") + "]",
    "- client status: " + clientStatus,
    "- upstream status: " + scn.upstreamStatus,
    "- proxy: false; CONNECT: refused; redirect follow: disabled",
    "- production state: NOT USED (isolated temp state under WireInspector/output)",
    "- real credentials: NOT USED (WI*-SYNTHETIC-*-TEST-ONLY only)",
    "- real provider contact: NONE",
    "- redaction: in-memory sanitize before write; synthetic literals absent (verified pre-write)",
    "- state cleanup: " + (opts.keepStateDir ? "KEPT (debug)" : "removed (" + stateParent + ")"),
    "- stop errors: " + (stopErrors.length ? stopErrors.join("; ") : "none"),
    "- bun: " + (typeof Bun !== "undefined" ? Bun.version : "unknown"),
    "",
  ];
  writeFileSync(join(outPath, "runtime-response-record.md"), runtimeLines.join("\n"), "utf8");

  return { runId, outPath, scenarioId: scn.id, lane: scn.lane, outcome, clientStatus, upstreamStatus: scn.upstreamStatus, summary };
}
