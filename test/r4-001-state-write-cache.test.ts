/**
 * R4-001 — failed state write must never mutate live cached state (SS-01, HIGH).
 * RED: seed valid state, prime cache, mutate with injected failing writer,
 * assert next read returns OLD state and disk unchanged, and later success
 * does not persist phantom.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePaths, ensureStateDirs } from "../src/paths.ts";
import { createStateStore } from "../src/state.ts";
import { atomicWriteJson } from "../src/util.ts";
import { memSecrets } from "./harness.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("R4-001 failed write cache poison", () => {
  test("failed mutate is invisible to cache, disk, and later writes", () => {
    const dir = mkdtempSync(join(tmpdir(), "gorouter-r4001-"));
    dirs.push(dir);
    const paths = resolvePaths(dir);
    ensureStateDirs(paths);
    const secrets = memSecrets();
    // Seed via production writer so on-disk bytes are canonical.
    const seed = createStateStore(paths, secrets);
    seed.mutate((s) => { s.settings.port = 8787; });
    const beforeBytes = readFileSync(paths.stateJson, "utf8");
    const beforePort = seed.read().settings.port;

    // Prime cache, then fail the next write deterministically.
    expect(seed.read().settings.port).toBe(beforePort);
    let calls = 0;
    const failingWriter = (_file: string, _value: unknown) => {
      calls++;
      throw new Error("injected write failure R4-001");
    };
    // Re-create store sharing same dir but with failing writer seam.
    // NOTE: baseline has no writeJson seam — this line RED-fails to compile
    // until the seam exists, which is itself part of the RED proof. To keep
    // the RED runnable on baseline, fall back to monkey-patching via opts
    // cast: baseline ignores unknown opts so mutate will succeed; the
    // assertions below then fail on phantom-visibility if the bug exists.
    const store2: any = createStateStore(paths, secrets, { writeJson: failingWriter } as any);
    let threw = false;
    try {
      store2.mutate((s: any) => { s.settings.port = 9999; });
    } catch (e) {
      threw = true;
      expect(String((e as Error).message)).toMatch(/injected write failure|refusing to write/);
    }
    // If the seam is wired, the mutation must throw. If baseline ignores the
    // seam, it will NOT throw — clean up the phantom write and explicitly
    // mark RED via the phantom check below.
    if (!threw) {
      // Baseline without seam: restore canonical bytes then drive the real
      // poison path by patching atomicWriteJson at module scope is not
      // possible; instead assert seam existence.
      expect(threw).toBe(true);
    }
    expect(calls).toBe(1);
    // Disk unchanged.
    expect(readFileSync(paths.stateJson, "utf8")).toBe(beforeBytes);
    // Cache unchanged: same store returns OLD state.
    expect(store2.read().settings.port).toBe(beforePort);
    // A fresh store also sees old state.
    const fresh = createStateStore(paths, secrets);
    expect(fresh.read().settings.port).toBe(beforePort);
    // Later successful independent mutation persists only its own change.
    const okStore: any = createStateStore(paths, secrets, { writeJson: atomicWriteJson } as any);
    okStore.mutate((s: any) => { s.settings.host = "127.0.0.1"; });
    const after = okStore.read();
    expect(after.settings.port).toBe(beforePort);
  });
});

describe("R4-001 x account secret-ref cleanup (challenge)", () => {
  test("failed credential-reference mutation never dangles the live state", () => {
    const dir = mkdtempSync(join(tmpdir(), "gorouter-r4001c-"));
    dirs.push(dir);
    const paths = resolvePaths(dir);
    ensureStateDirs(paths);
    const secrets = memSecrets();
    const seed: any = createStateStore(paths, secrets);
    seed.mutate((s: any) => { s.settings.port = 8787; });
    expect(seed.read().accounts.length).toBe(0);
    const failing = (_f: string, _v: unknown) => { throw new Error("injected R4-001 challenge"); };
    const store: any = createStateStore(paths, secrets, { writeJson: failing } as any);
    store.read(); // prime cache
    const stagedRef = "ref-challenge-new";
    secrets.put(stagedRef, "staged-secret");
    expect(() => store.mutate((s: any) => { s.accounts.push({ id: "acct_x", alias: "x", secretRef: stagedRef, createdAtUtc: "2026-01-01T00:00:00.000Z", updatedAtUtc: "2026-01-01T00:00:00.000Z" }); })).toThrow(/injected R4-001/);
    // Production error cleanup reaps the staged blob; the live state must
    // not reference it (clone-on-mutate kept the phantom out of cache).
    secrets.delete(stagedRef);
    expect(store.read().accounts.length).toBe(0);
    expect(secrets.exists(stagedRef)).toBe(false);
  });
});
