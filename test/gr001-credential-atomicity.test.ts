/**
 * GR-001 regression: a failed account-credential update must not change
 * the live credential. The update stages the new secret under a fresh ref
 * and swaps the reference inside the lock; commit failure reaps the orphan
 * and concurrent updates leave the last-committed credential live.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDomain } from "../src/domain.ts";
import { type SecretStore } from "../src/secret-store.ts";
import { resolvePaths, ensureStateDirs } from "../src/paths.ts";
import { lockPathFor, withFileLockAsyncAt } from "../src/lock.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    for (let i = 0; i < 5; i++) {
      try { rmSync(d, { recursive: true, force: true }); break; } catch { Bun.sleepSync(50 * (i + 1)); }
    }
  }
});

/** Recording in-memory secret store: tracks live blob keys for orphan checks. */
function recordingSecrets() {
  const map = new Map<string, string>();
  const store: SecretStore = {
    put(ref, value) { map.set(ref, value); },
    get(ref) {
      const v = map.get(ref);
      if (v === undefined) throw new Error("secret missing: " + ref);
      return v;
    },
    delete(ref) { return map.delete(ref); },
    exists(ref) { return map.has(ref); },
  };
  return { store, keys: () => [...map.keys()] };
}

function fresh() {
  const stateDir = mkdtempSync(join(tmpdir(), "gorouter-gr001-"));
  dirs.push(stateDir);
  const paths = resolvePaths(stateDir);
  ensureStateDirs(paths);
  const rec = recordingSecrets();
  return { domain: createDomain(paths, rec.store), paths, stateDir, secrets: rec.store, keys: rec.keys };
}

describe("GR-001 failed update keeps the live credential", () => {
  test("held-lock timeout retains the old secret and reaps the orphan", async () => {
    const f = fresh();
    f.domain.setup();
    f.domain.accountAdd("alpha", "old-secret");
    const before = f.domain.accountList().find((a) => a.alias === "alpha")!;
    const oldRef = before.secretRef;
    const updatedAt = before.updatedAtUtc;
    const keysBefore = f.keys().sort();
    // Hold the state lock from the async path (same live pid: never reclaimed).
    const holder = withFileLockAsyncAt(lockPathFor(f.stateDir), { timeoutMs: 30000 }, async () => {
      await Bun.sleep(15000);
    });
    await Bun.sleep(200);
    const started = Date.now();
    let err: unknown = null;
    try {
      f.domain.accountUpdate("alpha", "new-secret");
    } catch (e) { err = e; }
    const elapsed = Date.now() - started;
    await holder;
    expect(String((err as Error)?.message ?? err)).toMatch(/state lock timeout/);
    expect(elapsed).toBeGreaterThanOrEqual(9000);
    const after = f.domain.accountList().find((a) => a.alias === "alpha")!;
    expect(after.secretRef).toBe(oldRef);
    expect(after.updatedAtUtc).toBe(updatedAt);
    expect(f.secrets.get(oldRef)).toBe("old-secret");
    expect(f.keys().sort()).toEqual(keysBefore);
  }, 30000);

  test("secret-store failure leaves the old secret live and state untouched", () => {
    const f = fresh();
    f.domain.setup();
    f.domain.accountAdd("alpha", "old-secret");
    const before = f.domain.accountList().find((a) => a.alias === "alpha")!;
    const failing: SecretStore = {
      put() { throw new Error("DPAPI protect failed"); },
      get: (ref) => f.secrets.get(ref),
      delete: (ref) => f.secrets.delete(ref),
      exists: (ref) => f.secrets.exists(ref),
    };
    const domain2 = createDomain(f.paths, failing);
    expect(() => domain2.accountUpdate("alpha", "new-secret")).toThrow(/DPAPI protect failed/);
    const after = f.domain.accountList().find((a) => a.alias === "alpha")!;
    expect(after.secretRef).toBe(before.secretRef);
    expect(f.secrets.get(before.secretRef)).toBe("old-secret");
  });

  test("sequential updates leave the last-committed credential live with no orphans", () => {
    const f = fresh();
    f.domain.setup();
    f.domain.accountAdd("alpha", "secret-one");
    const refOne = f.domain.accountList().find((a) => a.alias === "alpha")!.secretRef;
    f.domain.accountUpdate("alpha", "secret-two");
    const refTwo = f.domain.accountList().find((a) => a.alias === "alpha")!.secretRef;
    expect(refTwo).not.toBe(refOne);
    expect(f.secrets.get(refTwo)).toBe("secret-two");
    expect(f.secrets.exists(refOne)).toBe(false);
    expect(f.keys().length).toBe(2);
  });

  test("update of a removed account stages nothing observable (no leak)", () => {
    const f = fresh();
    f.domain.setup();
    f.domain.accountAdd("alpha", "old-secret");
    f.domain.accountRemove("alpha", true);
    const keysBefore = f.keys().sort();
    expect(() => f.domain.accountUpdate("alpha", "another")).toThrow(/not found/);
    expect(f.keys().sort()).toEqual(keysBefore);
  });
});
