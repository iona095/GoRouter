/**
 * CLI account-test credential redaction (F-02): upstream-controlled probe
 * error fields (error.message / error.type / error.metadata.workspace) must
 * be redacted at the CLI output boundary — the same defense the desktop
 * control service applies (SEC-01). A hostile/buggy upstream that echoes the
 * account key or the local credential back into its error JSON must not
 * print them to stdout or stderr.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMockUpstream } from "./harness.ts";

// portable: under bun test, process.execPath IS the bun binary that runs this suite
const BUN = process.execPath;
const CLI = "src/cli.ts";

// Visibly synthetic account credential — never a real key.
const KEY = "sk-synth-acc-SECRET-0123456789abcdef";

const stateDirs: string[] = [];
afterEach(() => {
  for (const d of stateDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function freshStateDir(): string {
  const d = mkdtempSync(join(tmpdir(), "gorouter-cli-redact-"));
  stateDirs.push(d);
  return d;
}

function runCli(stateDir: string, args: string[], input?: string): Promise<{ status: number; stdout: string; stderr: string }> {
  const { promise, resolve } = Promise.withResolvers<{ status: number; stdout: string; stderr: string }>();
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
  return promise;
}

describe("CLI account-test output redaction (F-02)", () => {
  test("upstream error fields echoing the account key / local credential are redacted at the CLI boundary", async () => {
    const dir = freshStateDir();

    // `setup` prints the local credential once by product spec — capture it
    // here but never assert against setup output below.
    const setup = await runCli(dir, ["setup"]);
    expect(setup.status).toBe(0);
    const credLine = setup.stdout.split("\n").find((l) => /^[A-Za-z0-9_-]{40,}$/.test(l.trim()));
    expect(credLine).toBeTruthy();
    const localCred = credLine!.trim();

    // Mock upstream: branch on the probe model (go: minimax-m3, zen:
    // mimo-v2.5-free) and echo both secrets back into the error JSON fields
    // the CLI prints (errorType / errorMessageBrief / workspaceHint).
    const upstream = await startMockUpstream(async (req) => {
      const body = JSON.parse(await req.text()) as { model: string };
      if (body.model === "minimax-m3") {
        return Response.json(
          {
            type: "error",
            error: {
              type: `ServerError-${localCred}`,
              message: `upstream failure: ${KEY}; adjacent: xx${KEY} ${KEY}yy zz${KEY}zz`,
              metadata: { workspace: `ws-${KEY}` },
            },
          },
          { status: 500 },
        );
      }
      return Response.json(
        {
          type: "error",
          error: {
            type: "GoUsageLimitError",
            message: `quota exceeded: ${KEY}; adjacent: xx${KEY} ${KEY}yy zz${KEY}zz`,
            metadata: { workspace: `workspace-${KEY}` },
          },
        },
        { status: 429 },
      );
    });

    try {
      expect((await runCli(dir, ["config", "set", "upstreamGo", upstream.baseUrl])).status).toBe(0);
      expect((await runCli(dir, ["config", "set", "upstreamZen", upstream.baseUrl])).status).toBe(0);
      const add = await runCli(dir, ["account", "add", "synthacct"], KEY);
      expect(add.status).toBe(0);

      const go = await runCli(dir, ["account", "test", "synthacct", "--lane", "go"]);
      expect(go.status).toBe(0);
      const zen = await runCli(dir, ["account", "test", "synthacct", "--lane", "zen"]);
      expect(zen.status).toBe(0);

      // Neither the account key nor the local credential — nor 20-char
      // substrings of either — may appear on stdout or stderr of the
      // account-test commands.
      for (const out of [go, zen]) {
        for (const text of [out.stdout, out.stderr]) {
          expect(text).not.toContain(KEY);
          expect(text).not.toContain(KEY.slice(0, 20));
          expect(text).not.toContain(KEY.slice(-20));
          expect(text).not.toContain(localCred);
          expect(text).not.toContain(localCred.slice(0, 20));
          expect(text).not.toContain(localCred.slice(-20));
        }
      }

      // Positive control: redaction actually engaged (fails on the unpatched
      // CLI — this is the red regression).
      expect(go.stdout).toContain("[REDACTED]");
      expect(zen.stdout).toContain("[REDACTED]");

      // The secret genuinely transited the probe (the test is not vacuous):
      // every /chat/completions request carried `Bearer <key>`.
      const probes = upstream.requests.filter((r) => r.path === "/chat/completions");
      expect(probes.length).toBe(2);
      for (const p of probes) {
        expect(p.headers.get("authorization")).toBe(`Bearer ${KEY}`);
      }
    } finally {
      upstream.stop();
    }
  }, 90_000);
});
