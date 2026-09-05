/**
 * R3-002 regression: the journal compatibility probe must run BEFORE any
 * mutating PRAGMA/DDL. A future-version DB must be refused byte-identical:
 * no new tables/indexes, no journal-mode switch, version stamp unchanged.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { createJournal } from "../src/journal.ts";
import { resolvePaths, ensureStateDirs } from "../src/paths.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    for (let i = 0; i < 5; i++) {
      try { rmSync(d, { recursive: true, force: true }); break; } catch { Bun.sleepSync(50 * (i + 1)); }
    }
  }
});

interface MasterRow { type: string; name: string; sql: string | null; }

function inspect(dbPath: string): { master: MasterRow[]; version: string; mode: string } {
  const db = new Database(dbPath, { readonly: true });
  try {
    const master = db.query("SELECT type, name, sql FROM sqlite_master ORDER BY name").all() as MasterRow[];
    const ver = db.query("SELECT value FROM journal_meta WHERE key = 'schema_version'").get() as { value: string };
    const mode = db.query("PRAGMA journal_mode").get() as { journal_mode: string };
    return { master, version: ver.value, mode: mode.journal_mode };
  } finally {
    db.close();
  }
}

const BEGIN = { lane: "go", selectedAccountId: null, selectedAccountAliasSnapshot: null, method: "GET", endpointFamily: "models", terminalOutcome: "ok", httpStatus: null, upstreamRequestIds: [], model: null, clientCorrelationId: null } as const;

describe("R3-002 journal preflight", () => {
  test("future-version DB is refused without any schema or mode mutation", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "gorouter-r3002-"));
    dirs.push(stateDir);
    const paths = resolvePaths(stateDir);
    ensureStateDirs(paths);
    const seed = new Database(paths.journalDb, { create: true });
    seed.exec("CREATE TABLE journal_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);");
    seed.exec("INSERT INTO journal_meta (key, value) VALUES ('schema_version', '99'), ('created_at_utc', '2099-01-01T00:00:00.000Z');");
    seed.exec("CREATE TABLE future_sentinel (id INTEGER PRIMARY KEY);");
    seed.close();
    const before = inspect(paths.journalDb);
    const journal = createJournal(paths.journalDb, 30, 100000);
    try {
      journal.begin({ ...BEGIN });
      journal.prune();
      const stats = journal.stats();
      expect(stats.degraded).toBe(true);
      expect(stats.lastError).toMatch(/unsupported journal schema version 99/);
    } finally {
      journal.close();
    }
    const after = inspect(paths.journalDb);
    expect(after.version).toBe("99");
    expect(after.mode).toBe(before.mode);
    expect(after.master).toEqual(before.master);
    expect(after.master.map((r) => r.name)).not.toContain("request_journal");
  });

  test("stamp-less legacy DB is still adopted as v1", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "gorouter-r3002-"));
    dirs.push(stateDir);
    const paths = resolvePaths(stateDir);
    ensureStateDirs(paths);
    const seed = new Database(paths.journalDb, { create: true });
    seed.exec("CREATE TABLE legacy_note (id INTEGER PRIMARY KEY);");
    seed.close();
    const journal = createJournal(paths.journalDb, 30, 100000);
    try {
      journal.begin({ ...BEGIN });
      expect(journal.stats().degraded).toBe(false);
    } finally {
      journal.close();
    }
  });
});
