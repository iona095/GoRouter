/**
 * GR-007 regression: journalMaxRecords must be a bounded safe integer.
 *
 * Fractional values reach SQLite LIMIT/OFFSET and degrade the journal
 * (datatype mismatch) while routing continues. configSet and persisted
 * state must validate identically; the journal must prune at boundaries.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDomain } from "../src/domain.ts";
import { createStateStore, defaultState } from "../src/state.ts";
import { createJournal } from "../src/journal.ts";
import { resolvePaths, ensureStateDirs } from "../src/paths.ts";
import { memSecrets } from "./harness.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    for (let i = 0; i < 5; i++) {
      try {
        rmSync(d, { recursive: true, force: true });
        break;
      } catch {
        Bun.sleepSync(50 * (i + 1));
      }
    }
  }
});

function fresh() {
  const stateDir = mkdtempSync(join(tmpdir(), "gorouter-gr007-"));
  dirs.push(stateDir);
  const paths = resolvePaths(stateDir);
  ensureStateDirs(paths);
  return { domain: createDomain(paths, memSecrets()), paths, stateDir };
}

function beginRow(journal: ReturnType<typeof createJournal>) {
  return journal.begin({
    lane: "go",
    selectedAccountId: null,
    selectedAccountAliasSnapshot: null,
    method: "GET",
    endpointFamily: "models",
    terminalOutcome: "ok",
    httpStatus: null,
    upstreamRequestIds: [],
    model: null,
    clientCorrelationId: null,
  });
}

describe("GR-007 configSet rejects non-integer journalMaxRecords", () => {
  const bad = ["1.5", "0", "-3", String(Number.MAX_SAFE_INTEGER + 1), "10000001", "abc", "NaN", "Infinity"];
  for (const v of bad) {
    test("rejects " + v + " without changing state", () => {
      const f = fresh();
      f.domain.setup();
      expect(() => f.domain.configSet("journalMaxRecords", v)).toThrow(/invalid journalMaxRecords/);
      expect(f.domain.configShow().journalMaxRecords).toBe(100000);
    });
  }

  test("accepts integer boundaries 1 and 10000000", () => {
    const f = fresh();
    f.domain.setup();
    f.domain.configSet("journalMaxRecords", "1");
    expect(f.domain.configShow().journalMaxRecords).toBe(1);
    f.domain.configSet("journalMaxRecords", "10000000");
    expect(f.domain.configShow().journalMaxRecords).toBe(10000000);
  });

  test("fractional retention days stay allowed, non-positive rejected", () => {
    const f = fresh();
    f.domain.setup();
    f.domain.configSet("journalRetentionDays", "1.5");
    expect(f.domain.configShow().journalRetentionDays).toBe(1.5);
    const badR = ["0", "-1", "abc", "100000"];
    for (const v of badR) {
      expect(() => f.domain.configSet("journalRetentionDays", v)).toThrow(/invalid journalRetentionDays/);
    }
    expect(f.domain.configShow().journalRetentionDays).toBe(1.5);
  });
});

describe("GR-007 persisted state validates identically", () => {
  test("hand-edited fractional maxRecords fails closed to default, journal stays healthy", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "gorouter-gr007-"));
    dirs.push(stateDir);
    const paths = resolvePaths(stateDir);
    ensureStateDirs(paths);
    const store = createStateStore(paths, memSecrets());
    // W0: establish a valid lineage first so the ONLY invalidity under test
    // is the fractional maxRecords (a generation-less husk would fail closed
    // before settings validation by design).
    const { lockPathFor, withFileLock } = require("../src/lock.ts") as typeof import("../src/lock.ts");
    withFileLock(lockPathFor(paths.state), 10_000, () => store.ensureV2());
    const seed = store.read();
    (seed as unknown as Record<string, unknown>).settings = { ...seed.settings, journalMaxRecords: 1.5 };
    writeFileSync(paths.stateJson, JSON.stringify(seed));
    const loaded = store.read();
    expect(loaded.settings.journalMaxRecords).toBe(100000);
    const journal = createJournal(paths.journalDb, loaded.settings.journalRetentionDays, loaded.settings.journalMaxRecords);
    try {
      beginRow(journal);
      journal.prune();
      const stats = journal.stats();
      expect(stats.degraded).toBe(false);
      expect(stats.lastError).toBeNull();
    } finally {
      journal.close();
    }
    const raw = JSON.parse(readFileSync(paths.stateJson, "utf8"));
    expect(raw.settings.journalMaxRecords).toBe(1.5);
  });

  test("valid boundary maxRecords=1 prunes to exactly one row", () => {
    const f = fresh();
    const journal = createJournal(f.paths.journalDb, 30, 1);
    try {
      beginRow(journal);
      beginRow(journal);
      beginRow(journal);
      journal.prune();
      const stats = journal.stats();
      expect(stats.degraded).toBe(false);
      expect(stats.records).toBe(1);
    } finally {
      journal.close();
    }
  });
});
