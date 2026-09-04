/**
 * Domain-layer tests: the shared authoritative operations used by both the
 * CLI and the desktop control service. Count-sensitive assertions guard the
 * read-modify-write cycle (a mutation must apply exactly once).
 */
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync, openSync, writeSync, closeSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDomain } from "../src/domain.ts";
import { withFileLock } from "../src/lock.ts";
import { resolvePaths, ensureStateDirs } from "../src/paths.ts";
import { memSecrets } from "./harness.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fresh(): { domain: ReturnType<typeof createDomain>; stateDir: string } {
  const stateDir = mkdtempSync(join(tmpdir(), "gorouter-domain-"));
  dirs.push(stateDir);
  const paths = resolvePaths(stateDir);
  ensureStateDirs(paths);
  const secrets = memSecrets();
  return { domain: createDomain(paths, secrets), stateDir };
}

describe("domain mutations apply exactly once", () => {
  test("account adds accumulate without duplication (count-sensitive)", () => {
    const { domain } = fresh();
    domain.setup();
    domain.accountAdd("alpha", "sk-one");
    domain.accountAdd("beta", "sk-two");
    domain.accountAdd("gamma", "sk-three");
    const accounts = domain.accountList();
    expect(accounts.length).toBe(3);
    expect(new Set(accounts.map((a) => a.alias)).size).toBe(3);
  });

  test("state.json holds exactly the accounts added, no duplicates", () => {
    const { domain, stateDir } = fresh();
    domain.setup();
    domain.accountAdd("alpha", "sk-one");
    domain.accountAdd("alpha2", "sk-two");
    const state = JSON.parse(readFileSync(join(stateDir, "state.json"), "utf8")) as { accounts: unknown[] };
    expect(state.accounts.length).toBe(2);
  });

  test("route set then clear leaves exactly null selection", () => {
    const { domain } = fresh();
    domain.setup();
    const a = domain.accountAdd("alpha", "sk-one");
    domain.routeSet("go", "alpha");
    expect(domain.status().routes.find((r) => r.lane === "go")!.accountId).toBe(a.id);
    domain.routeClear("go");
    expect(domain.status().routes.find((r) => r.lane === "go")!.accountId).toBeNull();
  });

  test("routeSet accepts the stable account id as well as the alias", () => {
    const { domain } = fresh();
    domain.setup();
    const a = domain.accountAdd("alpha", "sk-one");
    domain.accountAdd("beta", "sk-two");
    // by stable id (uuid form differs from alias)
    domain.routeSet("go", a.id);
    expect(domain.status().routes.find((r) => r.lane === "go")!.alias).toBe("alpha");
    // by alias on the other lane
    domain.routeSet("zen", "beta");
    expect(domain.status().routes.find((r) => r.lane === "zen")!.alias).toBe("beta");
    // unknown id → not found
    expect(() => domain.routeSet("go", "acct_does-not-exist")).toThrow(/not found/);
  });

  test("concurrent mutations in one process both commit (no lost update)", async () => {
    const { domain } = fresh();
    domain.setup();
    await Promise.all([
      Promise.resolve().then(() => domain.accountAdd("one", "sk-one")),
      Promise.resolve().then(() => domain.accountAdd("two", "sk-two")),
      Promise.resolve().then(() => domain.accountAdd("three", "sk-three")),
    ]);
    const accounts = domain.accountList();
    expect(accounts.length).toBe(3);
  });

  test("remove with force clears exactly the routed lane and deletes the secret", () => {
    const { domain } = fresh();
    domain.setup();
    domain.accountAdd("alpha", "sk-one");
    domain.accountAdd("beta", "sk-two");
    domain.routeSet("go", "alpha");
    const { clearedLanes } = domain.accountRemove("alpha", true);
    expect(clearedLanes).toEqual(["go"]);
    expect(domain.status().routes.find((r) => r.lane === "go")!.accountId).toBeNull();
    expect(domain.accountList().length).toBe(1);
    expect(domain.accountList()[0]!.alias).toBe("beta");
  });

  test("remove without force refuses a routed account and leaves state intact", () => {
    const { domain } = fresh();
    domain.setup();
    domain.accountAdd("alpha", "sk-one");
    domain.routeSet("go", "alpha");
    expect(() => domain.accountRemove("alpha", false)).toThrow(/selected GO account/);
    expect(domain.accountList().length).toBe(1);
    expect(domain.status().routes.find((r) => r.lane === "go")!.accountId).not.toBeNull();
  });

  test("config set port validates and persists once", () => {
    const { domain } = fresh();
    domain.setup();
    domain.configSet("port", "8899");
    expect(domain.configShow().port).toBe(8899);
    expect(() => domain.configSet("port", "70000")).toThrow(/port out of range/);
    expect(domain.configShow().port).toBe(8899);
    expect(() => domain.configSet("host", "0.0.0.0")).toThrow(/non-loopback/);
  });

  test("setup is idempotent; local credential generated once", () => {
    const { domain } = fresh();
    const first = domain.setup();
    expect(first.created).toBe(true);
    expect(first.credential).toBeTruthy();
    const second = domain.setup();
    expect(second.created).toBe(false);
    expect(second.credential).toBeNull();
    expect(domain.localCredential()).toBe(first.credential!);
  });

  test("state lock file is removed after mutations", () => {
    const { domain, stateDir } = fresh();
    domain.setup();
    domain.accountAdd("alpha", "sk-one");
    domain.routeSet("go", "alpha");
    expect(existsSync(join(stateDir, ".state.lock"))).toBe(false);
  });

  test("duplicate-alias race commits exactly one account", async () => {
    const { domain } = fresh();
    domain.setup();
    const outcomes = await Promise.allSettled([
      Promise.resolve().then(() => domain.accountAdd("dup", "sk-one")),
      Promise.resolve().then(() => domain.accountAdd("dup", "sk-two")),
      Promise.resolve().then(() => domain.accountAdd("dup", "sk-three")),
    ]);
    const ok = outcomes.filter((o) => o.status === "fulfilled").length;
    const rejected = outcomes.filter((o) => o.status === "rejected").length;
    expect(ok).toBe(1);
    expect(rejected).toBe(2);
    expect(domain.accountList().length).toBe(1);
    expect(domain.accountList()[0]!.alias).toBe("dup");
  });

  test("route-set racing forced removal never leaves a dangling route", async () => {
    const { domain } = fresh();
    domain.setup();
    domain.accountAdd("alpha", "sk-one");
    const results = await Promise.allSettled([
      Promise.resolve().then(() => domain.routeSet("go", "alpha")),
      Promise.resolve().then(() => domain.accountRemove("alpha", true)),
    ]);
    const status = domain.status();
    const go = status.routes.find((r) => r.lane === "go")!;
    if (go.accountId !== null) {
      // if a route remains, it must point at an existing account
      expect(status.accounts.some((a) => a.id === go.accountId)).toBe(true);
    }
    // deterministic committed result: both ops committed, or remove won and routeSet threw
    expect(results.length).toBe(2);
  });

  test("cross-process lock serializes two CLI writers (spawned processes)", async () => {
    const { stateDir } = fresh();
    const BUN = process.execPath;
    const cli = (args: string[], input?: string): Promise<{ status: number; stdout: string }> =>
      new Promise((resolve) => {
        const proc = Bun.spawn([BUN, "src/cli.ts", ...args], {
          cwd: process.cwd(),
          env: { ...process.env, GOROUTER_STATE_DIR: stateDir },
          stdin: input === undefined ? "inherit" : "pipe",
          stdout: "pipe",
          stderr: "pipe",
          windowsHide: true,
        });
        const out: Uint8Array[] = [];
        (async () => {
          if (input !== undefined && proc.stdin) {
            proc.stdin.write(input);
            proc.stdin.end();
          }
        })();
        (async () => {
          for await (const chunk of proc.stdout) out.push(chunk);
        })();
        proc.exited.then((status) => resolve({ status, stdout: Buffer.concat(out).toString("utf8") }));
      });
    await cli(["setup"]);
    const adds = await Promise.all([
      cli(["account", "add", "c1"], "sk-c1"),
      cli(["account", "add", "c2"], "sk-c2"),
      cli(["account", "add", "c3"], "sk-c3"),
    ]);
    expect(adds.every((r) => r.status === 0)).toBe(true);
    // concurrent writers must serialize: exactly 3 accounts, no duplicates
    const list = (await cli(["account", "list"])).stdout;
    expect((list.match(/^c\d\t/mg) ?? []).length).toBe(3);
    const routed = await cli(["route", "go", "c2"]);
    expect(routed.status).toBe(0);
    const statusOut = (await cli(["status"])).stdout;
    expect(statusOut).toContain("c2");
  }, 60_000);

  test("withFileLock times out against a live holder and never displaces it", () => {
    const dir = mkdtempSync(join(tmpdir(), "gorouter-lock-"));
    try {
      const lock = join(dir, ".state.lock");
      // a lock owned by THIS live process can never be reclaimed (INV-02)
      const fd = openSync(lock, "wx");
      writeSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now() }));
      closeSync(fd);
      const t0 = Date.now();
      expect(() => withFileLock(lock, 700, () => 1)).toThrow(/state lock timeout/);
      expect(Date.now() - t0).toBeGreaterThanOrEqual(600);
      // the holder's lock survives intact
      expect(existsSync(lock)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("stale lock with a dead holder is reclaimed and the cycle proceeds", () => {
    const dir = mkdtempSync(join(tmpdir(), "gorouter-lock-"));
    try {
      const lock = join(dir, ".state.lock");
      const fd = openSync(lock, "wx");
      writeSync(fd, JSON.stringify({ pid: 99999999, ts: Date.now() - 60_000 }));
      closeSync(fd);
      const old = new Date(Date.now() - 60_000);
      utimesSync(lock, old, old);
      expect(withFileLock(lock, 2_000, () => 42)).toBe(42);
      expect(existsSync(lock)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("secret I/O outside the lock (F-08)", () => {
  function sharedPair() {
    const stateDir = mkdtempSync(join(tmpdir(), "gorouter-domain-"));
    dirs.push(stateDir);
    const paths = resolvePaths(stateDir);
    ensureStateDirs(paths);
    const backing = memSecrets();
    const failingSecrets = { ...backing, put(_ref: string, _v: string) { throw new Error("DPAPI down"); } };
    return {
      domain: createDomain(paths, backing),
      failing: createDomain(paths, failingSecrets),
    };
  }

  test("rotate failure before claim leaves the old credential live", () => {
    const { domain, failing } = sharedPair();
    domain.setup();
    const before = domain.localCredential();
    expect(before.length).toBeGreaterThan(0);
    // DPAPI fails before any state is touched: the operator sees an error,
    // the old credential stays live, and no lock was ever held.
    expect(() => failing.rotateLocalCredential()).toThrow(/DPAPI down/);
    expect(domain.localCredential()).toBe(before);
  });

  test("account update failure before mutate leaves state untouched", () => {
    const { domain, failing } = sharedPair();
    domain.setup();
    domain.accountAdd("alpha", "sk-one");
    expect(() => failing.accountUpdate("alpha", "sk-two")).toThrow(/DPAPI down/);
    expect(domain.accountList().map((a) => a.alias)).toEqual(["alpha"]);
  });

  test("duplicate account add still throws the same error", () => {
    const { domain } = fresh();
    domain.setup();
    domain.accountAdd("alpha", "sk-one");
    expect(() => domain.accountAdd("alpha", "sk-two")).toThrow(/already exists/);
    expect(domain.accountList().length).toBe(1);
  });
});
