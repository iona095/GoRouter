/**
 * CURRENT-001 — secretRef path containment (defense in depth).
 *
 * Relative traversal refs must never escape the secrets directory:
 * - file-store path construction rejects non-canonical refs;
 * - state load drops accounts / nulls localCredentialRef carrying them;
 * - put/delete cannot touch files outside the secrets dir (canary proof).
 */
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSecretStore, newRef, isValidSecretRef } from "../src/secret-store.ts";
import { ADMIN_TOKEN_REF } from "../src/desktop/admin-token.ts";
import { resolvePaths, ensureStateDirs } from "../src/paths.ts";
import { createStateStore, defaultState } from "../src/state.ts";
import { memSecrets } from "./harness.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function freshSecrets() {
  const dir = mkdtempSync(join(tmpdir(), "gorouter-secref-"));
  dirs.push(dir);
  return { dir, secretsDir: join(dir, "secrets"), store: createSecretStore(join(dir, "secrets")) };
}

describe("CURRENT-001 isValidSecretRef allowlist", () => {
  test("accepts newRef values and the fixed admin ref only", () => {
    expect(isValidSecretRef(newRef())).toBe(true);
    expect(isValidSecretRef(newRef())).toBe(true);
    expect(isValidSecretRef(ADMIN_TOKEN_REF)).toBe(true);
    expect(isValidSecretRef("sec_desktop_admin")).toBe(true);
  });

  test("rejects traversal, absolute, empty, oversized and lookalike refs", () => {
    const bad = [
      "../canary",
      "../../canary",
      "a/../../canary",
      "..\\canary",
      "a\\..\\b",
      "C:\\Windows\\Temp\\x",
      "C:/Windows/Temp/x",
      "\\\\server\\share",
      "//server/share",
      "/etc/passwd",
      "/",
      "",
      "sec_",
      "sec_" + "a".repeat(31), // one short
      "sec_" + "a".repeat(33), // one long
      "sec_" + "A".repeat(32), // uppercase hex not canonical
      "sec_" + "g".repeat(32), // non-hex
      "sec_desktop_admin!",
      "sec_desktop_adminx",
      "xsec_" + "a".repeat(32),
      " sec_" + "a".repeat(32),
      "sec_" + "a".repeat(32) + " ",
    ];
    for (const ref of bad) expect(isValidSecretRef(ref)).toBe(false);
    expect(isValidSecretRef(null)).toBe(false);
    expect(isValidSecretRef(undefined)).toBe(false);
    expect(isValidSecretRef(123)).toBe(false);
  });
});

describe("CURRENT-001 file-store containment", () => {
  test("valid generated ref round-trips (put/get/exists/delete)", () => {
    const { store } = freshSecrets();
    const ref = newRef();
    store.put(ref, "sk-containment-valid-1");
    expect(store.exists(ref)).toBe(true);
    expect(store.get(ref)).toBe("sk-containment-valid-1");
    store.delete(ref);
    expect(store.exists(ref)).toBe(false);
  });

  test("fixed admin ref round-trips", () => {
    const { store } = freshSecrets();
    store.put(ADMIN_TOKEN_REF, "admin-token-value");
    expect(store.get(ADMIN_TOKEN_REF)).toBe("admin-token-value");
    store.delete(ADMIN_TOKEN_REF);
  });

  test("traversal put/delete cannot touch an outside canary", () => {
    const { dir, store } = freshSecrets();
    const canary = join(dir, "canary-target.bin");
    writeFileSync(canary, "precious", "utf8");
    const evil = ["../canary-target", "..\\canary-target", "a/../../canary-target"];
    for (const ref of evil) {
      expect(() => store.put(ref, "x")).toThrow(/invalid secret ref/);
      expect(() => store.delete(ref)).toThrow(/invalid secret ref/);
      expect(() => store.get(ref)).toThrow(/invalid secret ref/);
      expect(store.exists.bind(store, ref)).toThrow(/invalid secret ref/);
    }
    // canary untouched; nothing new beside it
    expect(readFileSync(canary, "utf8")).toBe("precious");
    expect(readdirSync(dir).sort()).toEqual(["canary-target.bin", "secrets"]);
  });

  test("absolute / drive / root refs rejected before disk", () => {
    const { dir, store } = freshSecrets();
    for (const ref of ["C:\\t\\x", "C:/t/x", "/etc/passwd", "\\\\s\\x", ""]) {
      expect(() => store.put(ref, "x")).toThrow(/invalid secret ref/);
    }
    expect(readdirSync(dir)).toEqual(["secrets"]);
  });
});

describe("CURRENT-001 state-load containment", () => {
  test("malformed account refs dropped; malformed localCredentialRef nulled", () => {
    const dir = mkdtempSync(join(tmpdir(), "gorouter-secref-state-"));
    dirs.push(dir);
    const paths = resolvePaths(dir);
    ensureStateDirs(paths);
    const okRef = newRef();
    const base = defaultState();
    const crafted = {
      ...base,
      accounts: [
        { id: "acct_evil", alias: "evil", secretRef: "../canary", createdAtUtc: "2026-01-01T00:00:00.000Z", updatedAtUtc: "2026-01-01T00:00:00.000Z" },
        { id: "acct_ok", alias: "ok", secretRef: okRef, createdAtUtc: "2026-01-01T00:00:00.000Z", updatedAtUtc: "2026-01-01T00:00:00.000Z" },
      ],
      localCredentialRef: "../evil-local",
    };
    writeFileSync(paths.stateJson, JSON.stringify(crafted), "utf8");
    const state = createStateStore(paths, memSecrets());
    const loaded = state.read();
    expect(loaded.accounts.map((a) => a.alias)).toEqual(["ok"]);
    expect(loaded.localCredentialRef).toBeNull();
  });

  test("canonical refs survive a load round-trip", () => {
    const dir = mkdtempSync(join(tmpdir(), "gorouter-secref-state-"));
    dirs.push(dir);
    const paths = resolvePaths(dir);
    ensureStateDirs(paths);
    const secrets = memSecrets();
    const state = createStateStore(paths, secrets);
    const ref = newRef();
    secrets.put(ref, "k");
    state.mutate((s) => {
      s.localCredentialRef = ref;
      s.accounts.push({ id: "acct_1", alias: "a1", secretRef: ref, createdAtUtc: "2026-01-01T00:00:00.000Z", updatedAtUtc: "2026-01-01T00:00:00.000Z" });
    });
    const reloaded = createStateStore(paths, memSecrets()).read();
    expect(reloaded.accounts.length).toBe(1);
    expect(reloaded.localCredentialRef).toBe(ref);
  });
});
