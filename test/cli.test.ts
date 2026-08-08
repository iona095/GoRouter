/**
 * CLI lifecycle tests through the real DPAPI secret store (slow but proves
 * the production secret path and output redaction).
 */
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMockUpstream } from "./harness.ts";

// portable: under bun test, process.execPath IS the bun binary that runs this suite
const BUN = process.execPath;
const CLI = "src/cli.ts";

const stateDirs: string[] = [];
afterEach(() => {
  for (const d of stateDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function freshStateDir(): string {
  const d = mkdtempSync(join(tmpdir(), "gorouter-cli-"));
  stateDirs.push(d);
  return d;
}

function runCli(stateDir: string, args: string[], input?: string): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = Bun.spawn([BUN, CLI, ...args], {
      cwd: process.cwd(),
      env: { ...process.env, GOROUTER_STATE_DIR: stateDir },
      stdin: input === undefined ? "inherit" : "pipe",
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    });
    const out: Uint8Array[] = [];
    const err: Uint8Array[] = [];
    (async () => {
      if (input !== undefined && proc.stdin) {
        proc.stdin.write(input);
        proc.stdin.end();
      }
    })();
    (async () => {
      for await (const chunk of proc.stdout) out.push(chunk);
    })();
    (async () => {
      for await (const chunk of proc.stderr) err.push(chunk);
    })();
    proc.exited.then((status) => {
      resolve({
        status,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      });
    });
  });
}

async function cli(stateDir: string, args: string[], input?: string): Promise<{ status: number; stdout: string; stderr: string }> {
  return await runCli(stateDir, args, input);
}

describe("CLI lifecycle", () => {
  test("setup initializes state and a distinct local credential", async () => {
    const dir = freshStateDir();
    const setup = await runCli(dir, ["setup"]);
    expect(setup.status).toBe(0);
    expect(setup.stdout).toContain("Local client credential");
    const cred = setup.stdout.split("\n").find((l) => /^[A-Za-z0-9_-]{40,}$/.test(l.trim()));
    expect(cred).toBeTruthy();
    const second = await runCli(dir, ["setup"]);
    expect(second.stdout).toContain("already initialized");
    // state.json holds a ref, not the credential
    const state = JSON.parse(require("node:fs").readFileSync(join(dir, "state.json"), "utf8"));
    expect(JSON.stringify(state)).not.toContain(cred!.trim());
  }, 30_000);

  test("account add/list/rename/duplicate/remove lifecycle without leaking secrets", async () => {
    const dir = freshStateDir();
    await runCli(dir, ["setup"]);
    const key = "sk-cli-lifecycle-key-9876543210";
    const add = await runCli(dir, ["account", "add", "alpha"], key);
    expect(add.status).toBe(0);
    expect(add.stdout).not.toContain(key);
    // duplicate alias rejected
    const dup = await runCli(dir, ["account", "add", "alpha"], "sk-other");
    expect(dup.status).toBe(1);
    expect(dup.stderr).toContain("already exists");
    // list shows alias + DPAPI ref, never the key
    const list = await runCli(dir, ["account", "list"]);
    expect(list.stdout).toContain("alpha");
    expect(list.stdout).toContain("DPAPI:sec_");
    expect(list.stdout).not.toContain(key);
    // rename
    const rename = await runCli(dir, ["account", "rename", "alpha", "beta"]);
    expect(rename.status).toBe(0);
    expect((await runCli(dir, ["account", "list"])).stdout).toContain("beta");
    // route + routed-remove refusal
    expect((await runCli(dir, ["route", "go", "beta"])).status).toBe(0);
    const refusal = await runCli(dir, ["account", "remove", "beta"]);
    expect(refusal.status).toBe(1);
    expect(refusal.stderr).toContain("selected GO account");
    // force remove clears the route
    const forced = await runCli(dir, ["account", "remove", "beta", "--force"]);
    expect(forced.status).toBe(0);
    const status = await runCli(dir, ["status"]);
    expect(status.stdout).toContain("(none)");
    expect(status.stdout).not.toContain(key);
  }, 60_000);

  test("account test probes a lane through the configured upstream and classifies", async () => {
    const upstream = await startMockUpstream(() =>
      Response.json({ type: "error", error: { type: "GoUsageLimitError", message: "Monthly usage limit reached." } }, { status: 429 }),
    );
    const dir = freshStateDir();
    await runCli(dir, ["setup"]);
    expect((await runCli(dir, ["config", "set", "upstreamGo", upstream.baseUrl])).status).toBe(0);
    expect((await runCli(dir, ["config", "set", "upstreamZen", upstream.baseUrl])).status).toBe(0);
    const key = "sk-probe-key-1234567890";
    await runCli(dir, ["account", "add", "p1"], key);
    const t = await runCli(dir, ["account", "test", "p1", "--lane", "go"]);
    expect(t.status).toBe(0);
    expect(t.stdout).toContain("AUTH_PASS_QUOTA_STATE");
    expect(t.stdout).not.toContain(key);
    upstream.stop();
  }, 60_000);

  test("rotate-local-cred replaces the local credential", async () => {
    const dir = freshStateDir();
    await runCli(dir, ["setup"]);
    const before = (await runCli(dir, ["local-cred"])).stdout.trim();
    const rotated = await runCli(dir, ["rotate-local-cred"]);
    expect(rotated.status).toBe(0);
    const after = (await runCli(dir, ["local-cred"])).stdout.trim();
    expect(after).not.toBe(before);
    expect(after).toMatch(/^[A-Za-z0-9_-]{40,}$/);
  }, 60_000);

  test("journal stats command reports schema and counts", async () => {
    const dir = freshStateDir();
    await runCli(dir, ["setup"]);
    const stats = await runCli(dir, ["journal", "stats"]);
    expect(stats.status).toBe(0);
    const parsed = JSON.parse(stats.stdout) as { schemaVersion: number; records: number; retentionDays: number };
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.records).toBe(0);
    expect(parsed.retentionDays).toBe(30);
  }, 30_000);

  test("config set host refuses non-loopback persistence", async () => {
    const dir = freshStateDir();
    await runCli(dir, ["setup"]);
    const refusal = await runCli(dir, ["config", "set", "host", "0.0.0.0"]);
    expect(refusal.status).toBe(1);
    expect(refusal.stderr).toContain("non-loopback");
    // loopback persistence still works
    const loopback = await runCli(dir, ["config", "set", "host", "127.0.0.1"]);
    expect(loopback.status).toBe(0);
  }, 30_000);

  test("config set upstream refuses foreign https origins (OpenCode pinning)", async () => {
    const dir = freshStateDir();
    await runCli(dir, ["setup"]);
    // arbitrary HTTPS host must be refused — account credentials stay OpenCode-only
    const evil = await runCli(dir, ["config", "set", "upstreamGo", "https://evil.example.com/v1"]);
    expect(evil.status).toBe(1);
    expect(evil.stderr).toContain("not an allowed OpenCode authority");
    // the allowed OpenCode origin still works
    const ok = await runCli(dir, ["config", "set", "upstreamGo", "https://opencode.ai/zen/go/v1"]);
    expect(ok.status).toBe(0);
    // loopback test hosts still work (fixtures/mocks)
    const loopback = await runCli(dir, ["config", "set", "upstreamZen", "http://127.0.0.1:9999/v1"]);
    expect(loopback.status).toBe(0);
    // http to a non-loopback host is refused
    const httpEvil = await runCli(dir, ["config", "set", "upstreamZen", "http://evil.example.com/v1"]);
    expect(httpEvil.status).toBe(1);
  }, 30_000);

  test("foreign upstream origin in state fails closed to the safe default", async () => {
    const dir = freshStateDir();
    await runCli(dir, ["setup"]);
    // simulate a hand-edited / corrupted state file
    const statePath = join(dir, "state.json");
    const state = JSON.parse(require("node:fs").readFileSync(statePath, "utf8")) as Record<string, unknown>;
    (state.settings as Record<string, unknown>).upstreamGo = "https://evil.example.com/v1";
    require("node:fs").writeFileSync(statePath, JSON.stringify(state, null, 2));
    // the effective state must fail closed to the OpenCode default, never evil
    const show = await runCli(dir, ["config", "show"]);
    expect(show.status).toBe(0);
    const settings = JSON.parse(show.stdout) as { upstreamGo: string };
    expect(settings.upstreamGo).toBe("https://opencode.ai/zen/go/v1");
  }, 30_000);
});
