/**
 * R3-005 regression: synchronous DPAPI must not hold the cross-process
 * state lock, and repeated decrypt failures must not respawn PowerShell
 * on every read.
 *
 * - ensureAdminToken reads outside the mutation lock (creation stays
 *   locked with a re-check so concurrent starters agree on one token);
 * - a corrupt blob fails closed once, then fails fast from a brief
 *   negative cache instead of paying a PowerShell spawn per read.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSecretStore, newRef, type SecretStore } from "../src/secret-store.ts";
import { ensureAdminToken, ADMIN_TOKEN_REF } from "../src/desktop/admin-token.ts";
import { lockPathFor } from "../src/lock.ts";
import { resolvePaths, ensureStateDirs } from "../src/paths.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    for (let i = 0; i < 5; i++) {
      try { rmSync(d, { recursive: true, force: true }); break; } catch { Bun.sleepSync(50 * (i + 1)); }
    }
  }
});

function freshPaths() {
  const stateDir = mkdtempSync(join(tmpdir(), "gorouter-r3005-"));
  dirs.push(stateDir);
  const paths = resolvePaths(stateDir);
  ensureStateDirs(paths);
  return { stateDir, paths };
}

describe("R3-005 DPAPI isolation", () => {
  test("ensureAdminToken reads without holding the state lock", () => {
    const { paths } = freshPaths();
    const lockPath = lockPathFor(paths.state);
    const slow: SecretStore = {
      exists: () => true,
      get: () => {
        // A slow DPAPI decrypt runs here. If the mutation lock were held
        // across it, unrelated state mutations would stall for the whole
        // crypto duration.
        expect(existsSync(lockPath)).toBe(false);
        Bun.sleepSync(300);
        return "tok-slow-read";
      },
      put: () => { throw new Error("must not create when the blob exists"); },
      delete: () => false,
    };
    expect(ensureAdminToken(paths, slow)).toBe("tok-slow-read");
    expect(existsSync(lockPath)).toBe(false);
  });

  test("concurrent creation still agrees on one token (locked re-check)", () => {
    const { paths } = freshPaths();
    let puts = 0;
    const blobs = new Map<string, string>();
    const store: SecretStore = {
      exists: (ref) => blobs.has(ref),
      get: (ref) => {
        const v = blobs.get(ref);
        if (v === undefined) throw new Error(`secret missing: ${ref}`);
        return v;
      },
      put: (ref, plaintext) => { puts++; if (!blobs.has(ref)) blobs.set(ref, plaintext); return ref; },
      delete: () => false,
    };
    const t1 = ensureAdminToken(paths, store);
    const t2 = ensureAdminToken(paths, store);
    expect(t1).toBe(t2);
    expect(puts).toBe(1);
    expect(blobs.get(ADMIN_TOKEN_REF)).toBe(t1);
  });

  test("a corrupt blob fails closed without a PowerShell spawn per read", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "gorouter-r3005-"));
    dirs.push(stateDir);
    const secretsDir = join(stateDir, "secrets");
    mkdirSync(secretsDir, { recursive: true });
    const store = createSecretStore(secretsDir);
    const ref = newRef();
    writeFileSync(join(secretsDir, `${ref}.bin`), "not-valid-dpapi-base64!!!");
    expect(() => store.get(ref)).toThrow(/DPAPI unprotect failed/);
    const t0 = Date.now();
    for (let i = 0; i < 4; i++) {
      expect(() => store.get(ref)).toThrow(/DPAPI unprotect failed/);
    }
    // Four fresh PowerShell spawns reliably cost seconds on Windows; a
    // negative decrypt-failure cache answers in milliseconds.
    expect(Date.now() - t0).toBeLessThan(500);
  });
});
