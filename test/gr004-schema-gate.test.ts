/**
 * GR-004 regression: unsupported persistent-state versions are refused,
 * never normalized-and-overwritten. Future-version files stay byte-for-byte
 * intact across attempted mutations; unsupported journals are not restamped.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { createStateStore, defaultState } from "../src/state.ts";
import { loadDesktopSettings, DESKTOP_SETTINGS_SCHEMA_VERSION } from "../src/desktop/desktop-settings.ts";
import { createJournal } from "../src/journal.ts";
import { resolvePaths, ensureStateDirs } from "../src/paths.ts";
import { memSecrets } from "./harness.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    for (let i = 0; i < 5; i++) {
      try { rmSync(d, { recursive: true, force: true }); break; } catch { Bun.sleepSync(50 * (i + 1)); }
    }
  }
});

function freshDir(prefix: string) {
  const stateDir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(stateDir);
  const paths = resolvePaths(stateDir);
  ensureStateDirs(paths);
  return { stateDir, paths };
}

describe("GR-004 state.json version gate", () => {
  for (const v of [0, 2, 99]) {
    test("schema v" + v + " is refused and the file stays byte-identical", () => {
      const f = freshDir("gorouter-gr004-");
      const seed = defaultState();
      (seed as unknown as Record<string, unknown>).schemaVersion = v;
      (seed as unknown as Record<string, unknown>).futureSentinel = "keep-me";
      seed.settings.port = 9999;
      writeFileSync(f.paths.stateJson, JSON.stringify(seed));
      const before = readFileSync(f.paths.stateJson, "utf8");
      const store = createStateStore(f.paths, memSecrets());
      const loaded = store.read();
      expect(loaded.settings.port).toBe(8787);
      expect((loaded as unknown as Record<string, unknown>).futureSentinel).toBeUndefined();
      expect(store.health().unsupportedSchemaVersion).toBe(v);
      expect(() => store.mutate((s) => { s.settings.port = 1111; })).toThrow(/unsupported schema version/);
      expect(() => store.write(defaultState())).toThrow(/unsupported schema version/);
      expect(readFileSync(f.paths.stateJson, "utf8")).toBe(before);
      expect(JSON.parse(readFileSync(f.paths.stateJson, "utf8"))).toMatchObject({ futureSentinel: "keep-me" });
    });
  }

  test("restoring v1 heals the gate and mutations work again", () => {
    const f = freshDir("gorouter-gr004-");
    const seed = defaultState();
    (seed as unknown as Record<string, unknown>).schemaVersion = 2;
    writeFileSync(f.paths.stateJson, JSON.stringify(seed));
    const store = createStateStore(f.paths, memSecrets());
    store.read();
    expect(store.health().unsupportedSchemaVersion).toBe(2);
    writeFileSync(f.paths.stateJson, JSON.stringify(defaultState()));
    store.mutate((s) => { s.settings.port = 1111; });
    expect(store.health().unsupportedSchemaVersion).toBeNull();
    expect(store.read().settings.port).toBe(1111);
  });

  test("supported v1 mutates normally", () => {
    const f = freshDir("gorouter-gr004-");
    const store = createStateStore(f.paths, memSecrets());
    store.mutate((s) => { s.settings.port = 1111; });
    expect(store.health().unsupportedSchemaVersion).toBeNull();
    expect(store.read().settings.port).toBe(1111);
  });
});

describe("GR-004 desktop.json version gate", () => {
  test("schema v99 reads defaults, refuses writes, file stays byte-identical", () => {
    const f = freshDir("gorouter-gr004-");
    const raw = { schemaVersion: 99, startAtLogin: true, futureSentinel: "keep-me" };
    writeFileSync(join(f.stateDir, "desktop.json"), JSON.stringify(raw));
    const before = readFileSync(join(f.stateDir, "desktop.json"), "utf8");
    const desk = loadDesktopSettings(f.stateDir);
    const loaded = desk.read();
    expect(loaded.startAtLogin).toBe(false);
    expect(loaded.schemaVersion).toBe(DESKTOP_SETTINGS_SCHEMA_VERSION);
    expect(desk.unsupportedVersion()).toBe(99);
    expect(() => desk.write({ ...loaded, startAtLogin: true })).toThrow(/unsupported schema version/);
    expect(readFileSync(join(f.stateDir, "desktop.json"), "utf8")).toBe(before);
  });

  test("supported v1 reads and writes normally", () => {
    const f = freshDir("gorouter-gr004-");
    const desk = loadDesktopSettings(f.stateDir);
    const loaded = desk.read();
    desk.write({ ...loaded, startAtLogin: true });
    expect(desk.unsupportedVersion()).toBeNull();
    expect(desk.read().startAtLogin).toBe(true);
  });
});

describe("GR-004 journal version gate", () => {
  test("unsupported journal version is not restamped and routing degrades to memory", () => {
    const f = freshDir("gorouter-gr004-");
    const seed = new Database(f.paths.journalDb, { create: true });
    seed.exec("CREATE TABLE journal_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);");
    seed.exec("INSERT INTO journal_meta (key, value) VALUES ('schema_version', '99'), ('created_at_utc', '2099-01-01T00:00:00.000Z');");
    seed.close();
    const journal = createJournal(f.paths.journalDb, 30, 100000);
    try {
      journal.begin({ lane: "go", selectedAccountId: null, selectedAccountAliasSnapshot: null, method: "GET", endpointFamily: "models", terminalOutcome: "ok", httpStatus: null, upstreamRequestIds: [], model: null, clientCorrelationId: null });
      journal.prune();
      const stats = journal.stats();
      expect(stats.degraded).toBe(true);
      expect(stats.lastError).toMatch(/unsupported journal schema version 99/);
    } finally {
      journal.close();
    }
    const check = new Database(f.paths.journalDb, { readonly: true });
    try {
      const row = check.query("SELECT value FROM journal_meta WHERE key = 'schema_version'").get() as { value: string };
      expect(row.value).toBe("99");
    } finally {
      check.close();
    }
  });

  test("supported journal v1 records rows without degrading", () => {
    const f = freshDir("gorouter-gr004-");
    const journal = createJournal(f.paths.journalDb, 30, 100000);
    try {
      journal.begin({ lane: "go", selectedAccountId: null, selectedAccountAliasSnapshot: null, method: "GET", endpointFamily: "models", terminalOutcome: "ok", httpStatus: null, upstreamRequestIds: [], model: null, clientCorrelationId: null });
      const stats = journal.stats();
      expect(stats.degraded).toBe(false);
      expect(stats.records).toBe(1);
    } finally {
      journal.close();
    }
  });
});
