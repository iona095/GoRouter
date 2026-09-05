/**
 * CURRENT-005 — journal degraded fallback.
 *
 * Journal storage must NEVER block routing: when the SQLite file cannot be
 * opened (unwritable/missing parent, corrupt header at open, disk-full DDL)
 * createJournal falls back to a bounded in-memory journal that stays
 * observable (degraded=true + lastError evidence) and keeps recording.
 * The fast synchronous healthy path is unchanged.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJournal } from "../src/journal.ts";

const dirs: string[] = [];
afterEach(() => {
  // Fast best-effort cleanup (bun:sqlite defers handle release; see BL-001).
  for (const d of dirs.splice(0)) {
    for (let i = 0; i < 10; i++) {
      try { rmSync(d, { recursive: true, force: true }); break; }
      catch { if (i < 9) Bun.sleepSync(100); }
    }
  }
});

function row(lane: string) {
  return {
    lane, selectedAccountId: null, selectedAccountAliasSnapshot: null,
    method: "GET", endpointFamily: "models", terminalOutcome: "local_error" as const,
    httpStatus: null, upstreamRequestIds: [], model: null, clientCorrelationId: null,
  };
}

describe("CURRENT-005 degraded fallback", () => {
  test("unopenable path falls back to memory journal (degraded, recording, never throws)", () => {
    const dir = mkdtempSync(join(tmpdir(), "gorouter-jdeg-"));
    dirs.push(dir);
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "not a directory", "utf8");
    const dbPath = join(blocker, "journal.db"); // ENOTDIR at open
    let journal: ReturnType<typeof createJournal>;
    expect(() => { journal = createJournal(dbPath, 30, 100_000); }).not.toThrow();
    const st0 = journal!.stats();
    expect(st0.degraded).toBe(true);
    expect(st0.lastError).toBeTruthy();
    const e = journal!.begin(row("go"));
    expect(e.routerRequestId).toBeTruthy();
    expect(() => journal!.complete(e, {
      completedAtUtc: new Date().toISOString(), durationMs: 5,
      terminalOutcome: "ok", httpStatus: 200, upstreamRequestIds: ["up-1"],
    })).not.toThrow();
    const st1 = journal!.stats();
    expect(st1.degraded).toBe(true); // evidence preserved, not silently healthy
    expect(st1.lastError).toBeTruthy();
    expect(st1.records).toBeGreaterThanOrEqual(1);
    expect(() => journal!.prune()).not.toThrow();
    expect(() => journal!.close()).not.toThrow();
  });

  test("healthy path unchanged: fast sync success, not degraded", () => {
    const dir = mkdtempSync(join(tmpdir(), "gorouter-jdeg-"));
    dirs.push(dir);
    const journal = createJournal(join(dir, "journal.db"), 30, 100_000);
    const st = journal.stats();
    expect(st.degraded).toBe(false);
    expect(st.lastError).toBeNull();
    journal.close();
  });
});
