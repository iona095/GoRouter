/**
 * State-file quarantine: a corrupt state.json must be preserved as evidence
 * (F-19) instead of being served-and-forgotten or overwritten by the next
 * mutation.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePaths, ensureStateDirs } from "../src/paths.ts";
import { createStateStore, isTransientReadError, readWithTransientRetry } from "../src/state.ts";
import { lockPathFor, withFileLock } from "../src/lock.ts";
import { memSecrets } from "./harness.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function freshStateDir(): { dir: string; stateJson: string } {
  const dir = mkdtempSync(join(tmpdir(), "gorouter-state-"));
  dirs.push(dir);
  const paths = resolvePaths(dir);
  ensureStateDirs(paths);
  return { dir, stateJson: paths.stateJson };
}

describe("corrupt state quarantine (F-19)", () => {
  test("corrupt state.json is quarantined, defaults served, health flags it", () => {
    const { dir, stateJson } = freshStateDir();
    const garbage = "{not json!!";
    writeFileSync(stateJson, garbage);
    const store = createStateStore(resolvePaths(dir), memSecrets());
    const s = store.read();
    expect(s.accounts).toEqual([]);
    expect(store.health()).toEqual({ corrupt: true, unsupportedSchemaVersion: null });
    // Original moved away to a timestamped backup holding the evidence.
    expect(existsSync(stateJson)).toBe(false);
    const backups = readdirSync(dir).filter((f) => f.startsWith("state.json.corrupt-"));
    expect(backups.length).toBe(1);
    expect(readFileSync(join(dir, backups[0]!), "utf8")).toBe(garbage);
  });

  test("a later mutation REFUSES while corrupt (no silent wipe of the good copy)", async () => {
    const { dir, stateJson } = freshStateDir();
    writeFileSync(stateJson, "{corrupt");
    const paths = resolvePaths(dir);
    // Failing quarantine (rare on real filesystems: rename failure) leaves
    // the corrupt bytes in place with no preserved copy — mutations must
    // refuse rather than commit defaults over the only copy.
    const store = createStateStore(paths, memSecrets(), { quarantine: () => null });
    store.read();
    expect(store.health()).toEqual({ corrupt: true, unsupportedSchemaVersion: null });
    expect(existsSync(stateJson)).toBe(true); // quarantine could not move it
    expect(() => store.mutate((s) => { s.settings.port = 9999; }))
      .toThrow(/refusing to write: state\.json is corrupt.*restore a backup or delete state\.json/);
    expect(() => store.write(store.read())).toThrow(/refusing to write/);
    expect(readFileSync(stateJson, "utf8")).toBe("{corrupt"); // untouched
    // Documented repair: operator restores a backup (or deletes the file),
    // and the next load heals the flag.
    writeFileSync(stateJson, JSON.stringify({ schemaVersion: 1, localCredentialRef: null, accounts: [], routes: {}, settings: { port: 9999 } }));
    store.mutate((s) => { s.settings.host = "127.0.0.1"; });
    expect(store.health()).toEqual({ corrupt: false, unsupportedSchemaVersion: null });
  });

  test("same-process delete+setup repairs: explicit repair heals the latch (B0/R4-003)", () => {
    const { dir, stateJson } = freshStateDir();
    writeFileSync(stateJson, "{corrupt");
    const paths = resolvePaths(dir);
    const store = createStateStore(paths, memSecrets());
    store.read(); // quarantine moves the only copy away; file now absent
    expect(existsSync(stateJson)).toBe(false);
    // R4-003: reads alone must NOT self-clear the latch — explicit repair
    // (domain.setup path) heals WITHOUT a process restart.
    store.read();
    expect(store.health()).toEqual({ corrupt: true, unsupportedSchemaVersion: null });
    store.acknowledgeCorruptRepair();
    expect(store.health()).toEqual({ corrupt: false, unsupportedSchemaVersion: null });
    // W0 (Amendment A3): establish the v2 lineage before the first raw write,
    // mirroring production setup — a raw mutate cannot mint a lineage.
    withFileLock(lockPathFor(paths.state), 10_000, () => store.ensureV2());
    store.mutate((s) => { s.settings.port = 9999; });
    expect(existsSync(stateJson)).toBe(true);
    expect(store.read().settings.port).toBe(9999);
    // Evidence survived the repair for forensics.
    expect(readdirSync(dir).filter((f) => f.startsWith("state.json.corrupt-"))).toHaveLength(1);
  });

  test("unreadable path (directory) still quarantines immediately — fail-closed", () => {
    const { dir } = freshStateDir();
    const paths = resolvePaths(dir);
    // Replace the state file with a directory: reads fail non-transiently.
    rmSync(paths.stateJson, { force: true });
    mkdirSync(paths.stateJson);
    let quarantines = 0;
    const store = createStateStore(paths, memSecrets(), { quarantine: () => { quarantines++; return null; } });
    const s = store.read();
    expect(s.accounts).toEqual([]);
    expect(store.health()).toEqual({ corrupt: true, unsupportedSchemaVersion: null });
    expect(quarantines).toBe(1);
    rmSync(paths.stateJson, { recursive: true, force: true });
  });

  test("valid state never quarantines", () => {
    const { dir, stateJson } = freshStateDir();
    const paths = resolvePaths(dir);
    const store = createStateStore(paths, memSecrets());
    // W0 (Amendment A3): establish first; the unestablished default is not committable.
    withFileLock(lockPathFor(paths.state), 10_000, () => store.ensureV2());
    store.mutate((s) => {
      s.settings.port = 8787;
    });
    store.read();
    expect(readdirSync(dir).filter((f) => f.includes(".corrupt-"))).toEqual([]);
    expect(existsSync(stateJson)).toBe(true);
  });
});

describe("transient read retry (F-13)", () => {
  const err = (code: string) => Object.assign(new Error(code), { code });

  test("isTransientReadError classifies retryable vs permanent codes", () => {
    for (const code of ["EBUSY", "EAGAIN", "EINTR", "EPERM"]) expect(isTransientReadError(err(code))).toBe(true);
    for (const code of ["ENOENT", "EACCES", "EISDIR", "EPARSE"] as const)
      expect(isTransientReadError(Object.assign(new Error(code), { code }))).toBe(false);
    expect(isTransientReadError(new Error("plain"))).toBe(false);
    expect(isTransientReadError(null)).toBe(false);
  });

  test("flaky transient reads succeed without quarantining the good file", () => {
    let calls = 0;
    const sleeps: number[] = [];
    const out = readWithTransientRetry(() => {
      calls++;
      if (calls < 3) throw err("EBUSY");
      return "{\"ok\":true}";
    }, (ms) => sleeps.push(ms));
    expect(out).toBe("{\"ok\":true}");
    expect(calls).toBe(3);
    expect(sleeps).toEqual([25, 50]);
  });

  test("persistent transient-code failure throws after bounded attempts", () => {
    let calls = 0;
    expect(() => readWithTransientRetry(() => { calls++; throw err("EBUSY"); }, () => {}))
      .toThrow(/EBUSY/);
    expect(calls).toBe(3);
  });

  test("non-transient errors throw immediately (single attempt)", () => {
    let calls = 0;
    expect(() => readWithTransientRetry(() => { calls++; throw err("EISDIR"); }, () => { throw new Error("must not sleep"); }))
      .toThrow(/EISDIR/);
    expect(calls).toBe(1);
  });
});
