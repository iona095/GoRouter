/**
 * GoRouter V1 — OMP end-to-end integration runner.
 *
 * Drives the installed OMP client through the local GoRouter proxy and
 * captures redacted evidence:
 *   1. Go lane run        (GO route -> acct2)      expect success text
 *   2. Zen lane run       (ZEN route -> acct1)     expect success text (free model)
 *   3. Switch GO -> acct1, run again               expect GoUsageLimitError surfaced
 *   4. Switch GO -> acct2, run again               expect success
 *
 * Requires: router running on 127.0.0.1:8787, GOROUTER_LOCAL_KEY exported,
 * and the OMP models.yml GoRouter override in place.
 * Output: docs/evidence/omp-e2e.json (no secrets).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";

const EVIDENCE_DIR = join(process.cwd(), "docs", "evidence");
const PROMPT = "Reply with exactly: OK";

function runOmp(model: string, timeoutMs: number): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const proc = spawn("omp", ["run", "--model", model, "-p", "--no-session", PROMPT], {
      cwd: process.cwd(),
      env: process.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    proc.stdout.on("data", (d) => { out += d.toString(); });
    proc.stderr.on("data", (d) => { out += d.toString(); });
    const timer = setTimeout(() => { proc.kill(); resolve({ code: -1, output: out + "\n[TIMEOUT]"}); }, timeoutMs);
    proc.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? -1, output: out }); });
  });
}

function summarize(output: string): { ok: boolean; note: string } {
  const hasOk = /\bOK\b/.test(output) && !/error|fail|exhausted/i.test(output);
  const quota = /GoUsageLimitError|Monthly usage limit reached/.test(output);
  const connectFail = /Unable to connect|Retry budget exhausted/.test(output);
  if (quota) return { ok: false, note: "GoUsageLimitError surfaced (selected account quota state)" };
  if (connectFail) return { ok: false, note: "connection failure" };
  if (hasOk) return { ok: true, note: "completion received" };
  return { ok: false, note: "unexpected output: " + output.replace(/\s+/g, " ").slice(-200) };
}

async function main(): Promise<void> {
  const evidence: {
    contractId: string;
    ranAtUtc: string;
    router: string;
    localKeyConfigured: boolean;
    runs: Record<string, { model: string; routeCmd: string | null; exitCode: number; ok: boolean; note: string; outputTail: string }>;
  } = {
    contractId: "gorouter-v1-long-horizon-r4",
    ranAtUtc: new Date().toISOString(),
    router: "http://127.0.0.1:8787",
    localKeyConfigured: Boolean(process.env.GOROUTER_LOCAL_KEY),
    runs: {},
  };

  const run = async (id: string, model: string, routeCmd: string | null) => {
    if (routeCmd) {
      Bun.spawnSync(["bun", "src/cli.ts", ...routeCmd.split(" ")], { cwd: process.cwd(), env: process.env });
      await Bun.sleep(400);
    }
    const { code, output } = await runOmp(model, 240_000);
    const summary = summarize(output);
    evidence.runs[id] = {
      model,
      routeCmd,
      exitCode: code,
      ok: summary.ok,
      note: summary.note,
      outputTail: output.replace(/\s+/g, " ").slice(-300),
    };
    console.log(`${id.padEnd(12)} model=${model.padEnd(28)} ${summary.ok ? "PASS" : "CHECK"} — ${summary.note}`);
  };

  await run("go_acct2", "opencode-go/mimo-v2.5", "route go acct2");
  await run("zen_acct1", "opencode-zen/mimo-v2.5-free", "route zen acct1");
  await run("go_acct1_quota", "opencode-go/mimo-v2.5", "route go acct1");
  await run("go_acct2_back", "opencode-go/mimo-v2.5", "route go acct2");

  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const outPath = join(EVIDENCE_DIR, "omp-e2e.json");
  writeFileSync(outPath, JSON.stringify(evidence, null, 2) + "\n", "utf8");
  console.log(`\nevidence written to ${outPath}`);
  const r1 = evidence.runs.go_acct2!;
  const r2 = evidence.runs.zen_acct1!;
  const r3 = evidence.runs.go_acct1_quota!;
  const r4 = evidence.runs.go_acct2_back!;
  const ok = r1.ok && r2.ok && !r3.ok && /GoUsageLimitError/.test(r3.outputTail) && r4.ok;
  console.log(ok ? "OMP E2E: PASS" : "OMP E2E: INCOMPLETE");
  process.exit(ok ? 0 : 2);
}

main().catch((e) => {
  console.error(`omp-e2e failed: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
