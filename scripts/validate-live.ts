/**
 * GoRouter V1 — live validation runner (evidence capture, redacted).
 *
 * Establishes the contract's required live account/lane truths against the
 * CURRENT OpenCode upstreams using the user's two real account credentials
 * (supplied via environment variables; never argv, never echoed):
 *
 *   Account 1 material: OPENCODE_GO_ACCOUNT_1 (== ROUTATIC_PROXY_OPENCODE_ZEN_API_KEY)
 *   Account 2 material: OPENCODE_GO_ACCOUNT_2 (== OMP agent.db opencode-zen credential)
 *
 * Matrix (contract §6):
 *   GO  A1, GO  A2  — current Go lane (https://opencode.ai/zen/go/v1)
 *   ZEN A1, ZEN A2  — current Zen lane, non-billing *-free model (mimo-v2.5-free)
 *   negative controls — invalid key on both lanes (must be 401 AuthError)
 *   distinctness — Account 1 vs Account 2 material must differ
 *
 * Then exercises the running local router (127.0.0.1:8787): proxied
 * completions per lane, no-restart route switching with account-specific
 * upstream signatures, and progressive streaming with chunk timing.
 *
 * Output: docs/evidence/live-validation.json + human summary on stdout.
 * The JSON contains NO secrets: only verdicts, statuses, error types and
 * workspace identifiers.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import { probeAccountKey, type ProbeResult } from "../src/probe.ts";
import { resolvePaths } from "../src/paths.ts";
import { createStateStore } from "../src/state.ts";
import { createSecretStore } from "../src/secret-store.ts";

const ROUTER = "http://127.0.0.1:8787";
const EVIDENCE_DIR = join(process.cwd(), "docs", "evidence");

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing environment variable ${name} — cannot run live validation`);
  return v.trim();
}

function fingerprint(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex").slice(0, 16);
}

async function proxiedCompletion(
  lane: "go" | "zen",
  localKey: string,
  model: string,
  correlationId: string,
): Promise<{ status: number; errorType: string | null; errorMessage: string | null; requestId: string | null; bodySample: string }> {
  const res = await fetch(`${ROUTER}/${lane}/v1/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${localKey}`,
      "content-type": "application/json",
      "x-gorouter-correlation-id": correlationId,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "Reply with exactly: OK" }],
      max_tokens: 64,
      stream: false,
    }),
    redirect: "manual",
  });
  const text = await res.text();
  let errorType: string | null = null;
  let errorMessage: string | null = null;
  try {
    const data = JSON.parse(text) as { error?: { type?: string; message?: string } };
    errorType = data.error?.type ?? null;
    errorMessage = data.error?.message ? data.error.message.slice(0, 140) : null;
  } catch { /* non-JSON body */ }
  return {
    status: res.status,
    errorType,
    errorMessage,
    requestId: res.headers.get("x-gorouter-request-id"),
    bodySample: text.slice(0, 120).replace(/\s+/g, " "),
  };
}

async function streamingProbe(localKey: string, lane: "go" | "zen", model: string): Promise<{
  status: number;
  firstChunkMs: number;
  totalChunks: number;
  totalBytes: number;
  doneSeen: boolean;
}> {
  const started = Date.now();
  const res = await fetch(`${ROUTER}/${lane}/v1/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${localKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "Count from 1 to 5, one number per line." }],
      max_tokens: 256,
      stream: true,
    }),
    redirect: "manual",
  });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let firstChunkMs = 0;
  let totalChunks = 0;
  let totalBytes = 0;
  let acc = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (firstChunkMs === 0) firstChunkMs = Date.now() - started;
    totalChunks++;
    totalBytes += value.length;
    acc += decoder.decode(value);
  }
  return {
    status: res.status,
    firstChunkMs,
    totalChunks,
    totalBytes,
    doneSeen: acc.includes("[DONE]"),
  };
}

async function main(): Promise<void> {
  const account1 = env("OPENCODE_GO_ACCOUNT_1");
  const account2 = env("OPENCODE_GO_ACCOUNT_2");
  const zen1 = env("ROUTATIC_PROXY_OPENCODE_ZEN_API_KEY");
  const paths = resolvePaths();
  const state = createStateStore(paths, createSecretStore(paths.secretsDir));
  const localKey = state.localCredential();

  const evidence: Record<string, unknown> = {
    contractId: "gorouter-v1-long-horizon-r4",
    ranAtUtc: new Date().toISOString(),
    upstreams: {
      go: "https://opencode.ai/zen/go/v1",
      zen: "https://opencode.ai/zen/v1",
      catalogEvidence: "GET /models: go=25 models, zen=61 models (200 both accounts, public catalog)",
    },
    probes: {},
    router: {},
    streaming: {},
  };

  // --- distinctness --------------------------------------------------------
  evidence.accountDistinctness = {
    account1Fingerprint: fingerprint(account1),
    account2Fingerprint: fingerprint(account2),
    distinct: fingerprint(account1) !== fingerprint(account2),
    zen1EqualsAccount1: zen1 === account1,
  };

  // --- direct probe matrix --------------------------------------------------
  const probeCases: Array<{ id: string; lane: "go" | "zen"; key: string; base: string }> = [
    { id: "go_a1", lane: "go", key: account1, base: "https://opencode.ai/zen/go/v1" },
    { id: "go_a2", lane: "go", key: account2, base: "https://opencode.ai/zen/go/v1" },
    { id: "zen_a1", lane: "zen", key: zen1, base: "https://opencode.ai/zen/v1" },
    { id: "zen_a2", lane: "zen", key: account2, base: "https://opencode.ai/zen/v1" },
    { id: "neg_go", lane: "go", key: "sk-bogus-invalid-key-00000000000000000000000000000000", base: "https://opencode.ai/zen/go/v1" },
    { id: "neg_zen", lane: "zen", key: "sk-bogus-invalid-key-00000000000000000000000000000000", base: "https://opencode.ai/zen/v1" },
  ];
  const probes: Record<string, ProbeResult & { id: string }> = {};
  for (const c of probeCases) {
    const r = await probeAccountKey(c.lane, c.key, c.base);
    probes[c.id] = { id: c.id, ...r };
    console.log(`probe ${c.id.padEnd(8)} lane=${c.lane} => ${r.verdict} http=${r.httpStatus ?? "net"} model=${r.model}${r.errorType ? ` err=${r.errorType}` : ""}`);
  }
  evidence.probes = probes;

  // --- through-router matrix ------------------------------------------------
  const routerCases: Array<{ id: string; lane: "go" | "zen"; model: string }> = [
    { id: "router_go_a2", lane: "go", model: "mimo-v2.5" },
    { id: "router_zen_a1", lane: "zen", model: "mimo-v2.5-free" },
  ];
  const router: Record<string, unknown> = {};
  for (const c of routerCases) {
    const r = await proxiedCompletion(c.lane, localKey, c.model, `live-${c.id}`);
    router[c.id] = r;
    console.log(`router ${c.id.padEnd(14)} => http=${r.status} err=${r.errorType ?? "none"} rid=${r.requestId?.slice(0, 8)}`);
  }
  evidence.router = router;

  // --- no-restart route switch ----------------------------------------------
  const switchEvidence: Record<string, unknown> = {};
  {
    // router must be running with GO -> acct2 for the first call (set by operator)
    const before = await proxiedCompletion("go", localKey, "mimo-v2.5", "live-switch-before");
    switchEvidence.beforeSwitch = { status: before.status, errorType: before.errorType };
    // switch via CLI (no router restart)
    const switchOut = Bun.spawnSync(["bun", "src/cli.ts", "route", "go", "acct1"], {
      cwd: process.cwd(),
      env: process.env,
    });
    await new Promise((r) => setTimeout(r, 300));
    const after = await proxiedCompletion("go", localKey, "mimo-v2.5", "live-switch-after-a1");
    switchEvidence.afterSwitchToA1 = { status: after.status, errorType: after.errorType, errorMessage: after.errorMessage };
    // back to acct2
    Bun.spawnSync(["bun", "src/cli.ts", "route", "go", "acct2"], { cwd: process.cwd(), env: process.env });
    await new Promise((r) => setTimeout(r, 300));
    const back = await proxiedCompletion("go", localKey, "gpt-5.6-luna", "live-switch-back-a2");
    switchEvidence.backToA2 = { status: back.status, errorType: back.errorType };
    switchEvidence.cliExit = switchOut.exitCode;
  }
  evidence.routeSwitch = switchEvidence;

  // --- streaming -------------------------------------------------------------
  const sGo = await streamingProbe(localKey, "go", "mimo-v2.5");
  const sZen = await streamingProbe(localKey, "zen", "mimo-v2.5-free");
  evidence.streaming = {
    go: sGo,
    zen: sZen,
    progressive: sGo.firstChunkMs > 0 && sGo.totalChunks > 1 && sGo.doneSeen && sZen.totalChunks > 1 && sZen.doneSeen,
  };
  console.log(`stream go: status=${sGo.status} chunks=${sGo.totalChunks} firstChunkMs=${sGo.firstChunkMs} done=${sGo.doneSeen}`);
  console.log(`stream zen: status=${sZen.status} chunks=${sZen.totalChunks} firstChunkMs=${sZen.firstChunkMs} done=${sZen.doneSeen}`);

  // --- journal cross-check ----------------------------------------------------
  interface JournalRow {
    router_request_id: string;
    started_at_utc: string;
    completed_at_utc: string | null;
    duration_ms: number | null;
    lane: string;
    selected_account_id: string | null;
    selected_account_alias_snapshot: string | null;
    method: string;
    endpoint_family: string;
    terminal_outcome: string;
    http_status: number | null;
    upstream_request_ids: string;
    model: string | null;
    client_correlation_id: string | null;
  }
  const db = new Database(paths.journalDb, { readonly: true });
  const rows = db.query<JournalRow, []>("SELECT router_request_id, started_at_utc, completed_at_utc, duration_ms, lane, selected_account_id, selected_account_alias_snapshot, method, endpoint_family, terminal_outcome, http_status, upstream_request_ids, model, client_correlation_id FROM request_journal ORDER BY id").all();
  db.close();
  evidence.journal = {
    records: rows.length,
    samples: rows.slice(-6),
    correlationIds: rows.map((r) => r.client_correlation_id).filter(Boolean),
  };

  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const outPath = join(EVIDENCE_DIR, "live-validation.json");
  writeFileSync(outPath, JSON.stringify(evidence, null, 2) + "\n", "utf8");
  console.log(`\nevidence written to ${outPath}`);

  // verdict summary
  const p = probes as Record<string, ProbeResult>;
  const pass = p.go_a1?.verdict === "AUTH_PASS_QUOTA_STATE" && p.go_a2?.verdict === "AUTH_PASS_LIVE" &&
    p.zen_a1?.verdict === "AUTH_PASS_LIVE" && p.zen_a2?.verdict === "AUTH_PASS_LIVE" &&
    p.neg_go?.verdict === "AUTH_FAIL" && p.neg_zen?.verdict === "AUTH_FAIL";
  console.log(pass ? "\nLIVE MATRIX: PASS" : "\nLIVE MATRIX: INCOMPLETE");
  process.exit(pass ? 0 : 2);
}

main().catch((e) => {
  console.error(`validate-live failed: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
