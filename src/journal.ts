/**
 * GoRouter V1 — correlation-ready request journal (routing provenance only).
 *
 * Design intent (contract §13): preserve stable request ids, precise timing
 * and the exact immutable route snapshot used for each request so a later
 * Usage/Quota subsystem can correlate OMP telemetry -> GoRouter provenance.
 * The journal is NOT a quota estimator and never stores request/response
 * content, Authorization values, keys or arbitrary headers.
 *
 * Storage: SQLite (bun:sqlite), WAL mode, bounded by retention days and a
 * maximum record count. Journal faults degrade observably (health/status)
 * and NEVER block upstream routing.
 */
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { monotonicMs, utcNow, log, safeJsonStringify, extractUpstreamRequestIds } from "./util.ts";

export const JOURNAL_SCHEMA_VERSION = 1;

export type TerminalOutcome =
  | "ok" // upstream response dispatched to the client
  | "upstream_error" // upstream returned an error status (faithfully proxied)
  | "local_error" // router rejected before/without upstream success
  | "client_abort"; // client disconnected mid-stream, OR the router closed the
                    // connection mid-stream during shutdown: a server-initiated
                    // stop lands here too because the response stream is canceled
                    // from the router side with no live client abort to observe.
                    // This is the least-wrong label; a distinct outcome would be
                    // a schema change and is not warranted.

export interface JournalEntry {
  routerRequestId: string;
  startedAtUtc: string;
  completedAtUtc: string | null;
  durationMs: number | null;
  lane: string;
  selectedAccountId: string | null;
  selectedAccountAliasSnapshot: string | null;
  method: string;
  endpointFamily: string;
  terminalOutcome: TerminalOutcome;
  httpStatus: number | null;
  upstreamRequestIds: string[];
  model: string | null;
  clientCorrelationId: string | null;
}

export interface JournalStats {
  schemaVersion: number;
  records: number;
  oldestRecordAtUtc: string | null;
  newestRecordAtUtc: string | null;
  degraded: boolean;
  lastError: string | null;
  retentionDays: number;
  maxRecords: number;
}

export interface Journal {
  /** Assign an id and record the dispatch start. Returns the entry. */
  begin(init: Omit<JournalEntry, "routerRequestId" | "startedAtUtc" | "completedAtUtc" | "durationMs">): JournalEntry;
  /** Finalize an entry started with begin(). Never throws. */
  complete(entry: JournalEntry, finalize: {
    completedAtUtc: string;
    durationMs: number;
    terminalOutcome: TerminalOutcome;
    httpStatus: number | null;
    upstreamRequestIds: string[];
  }): void;
  stats(): JournalStats;
  /**
   * Prune records beyond retention/max; called on startup and periodically.
   * Slice D: `checkpoint=false` (the periodic in-request call) runs only the
   * indexed DELETEs and skips the synchronous TRUNCATE checkpoint — WAL reuse
   * plus SQLite's automatic checkpoint bound growth; the TRUNCATE runs at
   * startup and on last-close instead of on a request's critical path.
   */
  prune(checkpoint?: boolean): void;
  close(): void;
}

/**
 * CURRENT-005 — journal construction fallback. Storage must NEVER block
 * routing: when the SQLite file cannot be opened (missing/unwritable
 * parent, corrupt header at open, disk-full DDL), fall back to a bounded
 * in-memory journal that stays observable (degraded + lastError evidence)
 * and keeps recording. The healthy synchronous path is untouched.
 */
export function createJournal(dbPath: string, retentionDays: number, maxRecords: number): Journal {
  try {
    return openSqliteJournal(dbPath, retentionDays, maxRecords);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    log.error(`journal unavailable at ${dbPath} (${reason}); continuing with in-memory degraded journal (routing unaffected)`);
    return createMemoryJournal(`open failed: ${reason}`, retentionDays, maxRecords);
  }
}

/** Bounded in-memory evidence ring for the degraded fallback (never throws). */
const MEMORY_JOURNAL_MAX_ROWS = 1000;

/**
 * R3-002 read-only compatibility probe. Opens an existing DB without
 * `create` and read-only, so SQLite performs no writes: no journal-mode
 * change, no table/index creation. Throws the unsupported-version error
 * for a stamped future version; stamp-less legacy files (no journal_meta
 * table or no stamp row) pass and are adopted by the writable init.
 */
function probeJournalCompatibility(dbPath: string): void {
  const probe = new Database(dbPath, { create: false, readonly: true });
  try {
    const meta = probe.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'journal_meta'",
    ).get() as { name: string } | null | undefined;
    if (meta == null) return; // stamp-less legacy: adoption handled below
    const row = probe.prepare("SELECT value FROM journal_meta WHERE key = 'schema_version'").get() as { value: string } | null | undefined;
    if (row == null) return; // meta table without a stamp: legacy adoption
    if (Number(row.value) !== JOURNAL_SCHEMA_VERSION) {
      throw new Error(`unsupported journal schema version ${row.value} (this binary supports version ${JOURNAL_SCHEMA_VERSION}); journal file left untouched`);
    }
  } finally {
    try { probe.close(); } catch { /* best effort */ }
  }
}

function createMemoryJournal(openError: string, retentionDays: number, maxRecords: number): Journal {
  const rows = new Map<string, JournalEntry>();
  return {
    begin(init) {
      const entry: JournalEntry = {
        routerRequestId: randomUUID(),
        startedAtUtc: utcNow(),
        completedAtUtc: null,
        durationMs: null,
        ...init,
      };
      if (rows.size >= MEMORY_JOURNAL_MAX_ROWS) {
        const oldest = rows.keys().next();
        if (!oldest.done) rows.delete(oldest.value);
      }
      rows.set(entry.routerRequestId, entry);
      return entry;
    },
    complete(entry, finalize) {
      const cur = rows.get(entry.routerRequestId);
      if (cur) {
        cur.completedAtUtc = finalize.completedAtUtc;
        cur.durationMs = finalize.durationMs;
        cur.terminalOutcome = finalize.terminalOutcome;
        cur.httpStatus = finalize.httpStatus;
        cur.upstreamRequestIds = finalize.upstreamRequestIds.map(String);
      }
    },
    stats(): JournalStats {
      return {
        schemaVersion: JOURNAL_SCHEMA_VERSION,
        records: rows.size,
        oldestRecordAtUtc: null,
        newestRecordAtUtc: null,
        degraded: true,
        lastError: openError,
        retentionDays,
        maxRecords,
      };
    },
    prune() { /* nothing persisted */ },
    close() { /* nothing to release */ },
  };
}

function openSqliteJournal(dbPath: string, retentionDays: number, maxRecords: number): Journal {
  const fresh = !existsSync(dbPath);
  if (!fresh) {
    // R3-002: compatibility preflight BEFORE any mutating PRAGMA/DDL. The
    // read-only probe never creates tables/indexes and never changes the
    // journal mode, so a future-version file is refused byte-identical.
    // Stamp-less legacy files pass the probe and are adopted below.
    probeJournalCompatibility(dbPath);
  }
  const db = new Database(dbPath, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS journal_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS request_journal (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      schema_version INTEGER NOT NULL,
      router_request_id TEXT NOT NULL UNIQUE,
      started_at_utc TEXT NOT NULL,
      completed_at_utc TEXT,
      duration_ms INTEGER,
      lane TEXT NOT NULL,
      selected_account_id TEXT,
      selected_account_alias_snapshot TEXT,
      method TEXT NOT NULL,
      endpoint_family TEXT NOT NULL,
      terminal_outcome TEXT NOT NULL,
      http_status INTEGER,
      upstream_request_ids TEXT NOT NULL DEFAULT '[]',
      model TEXT,
      client_correlation_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_journal_started ON request_journal(started_at_utc);
    CREATE INDEX IF NOT EXISTS idx_journal_lane ON request_journal(lane);
  `);
  if (fresh) {
    const stmt = db.prepare("INSERT OR REPLACE INTO journal_meta (key, value) VALUES (?, ?)");
    stmt.run("schema_version", String(JOURNAL_SCHEMA_VERSION));
    stmt.run("created_at_utc", utcNow());
  } else {
    // GR-004: an existing journal carries its writer's version stamp. Adopt
    // a stamp-less legacy file as ours; refuse anything newer (or otherwise
    // not ours) WITHOUT restamping it — the throw below degrades to the
    // in-memory journal and the on-disk version is never rewritten.
    const row = db.prepare("SELECT value FROM journal_meta WHERE key = 'schema_version'").get() as { value: string } | null | undefined;
    if (row == null) {
      db.prepare("INSERT OR REPLACE INTO journal_meta (key, value) VALUES (?, ?)").run(
        "schema_version",
        String(JOURNAL_SCHEMA_VERSION),
      );
    } else if (Number(row.value) !== JOURNAL_SCHEMA_VERSION) {
      try { db.close(); } catch { /* best effort */ }
      throw new Error(`unsupported journal schema version ${row.value} (this binary supports version ${JOURNAL_SCHEMA_VERSION}); journal file left untouched`);
    }
  }

  let degraded = false;
  let lastError: string | null = null;
  let insertsSincePrune = 0;

  function runSafe(fn: () => void): boolean {
    try {
      fn();
      if (degraded) {
        degraded = false;
        lastError = null;
        log.info("journal recovered from degraded state");
      }
      return true;
    } catch (e) {
      degraded = true;
      lastError = e instanceof Error ? e.message : String(e);
      log.error(`journal degraded (routing continues): ${lastError}`);
      return false;
    }
  }

  const insertStmt = db.prepare(`
    INSERT INTO request_journal (
      schema_version, router_request_id, started_at_utc, lane,
      selected_account_id, selected_account_alias_snapshot, method,
      endpoint_family, terminal_outcome, model, client_correlation_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const updateStmt = db.prepare(`
    UPDATE request_journal SET
      completed_at_utc = ?, duration_ms = ?, terminal_outcome = ?,
      http_status = ?, upstream_request_ids = ?
    WHERE router_request_id = ?
  `);
  // Slice A.1: stats() ran 4 fresh prepares per call; hoisted next to the
  // insert/update statements so every statement in this module is compiled once.
  const statsMetaStmt = db.prepare("SELECT value FROM journal_meta WHERE key = ?");
  const statsCountStmt = db.prepare("SELECT COUNT(*) AS n FROM request_journal");
  const statsOldestStmt = db.prepare("SELECT MIN(started_at_utc) AS v FROM request_journal");
  const statsNewestStmt = db.prepare("SELECT MAX(started_at_utc) AS v FROM request_journal");

  const journal: Journal = {
    begin(init) {
      const entry: JournalEntry = {
        routerRequestId: randomUUID(),
        startedAtUtc: utcNow(),
        completedAtUtc: null,
        durationMs: null,
        ...init,
      };
      runSafe(() => {
        insertStmt.run(
          JOURNAL_SCHEMA_VERSION,
          entry.routerRequestId,
          entry.startedAtUtc,
          entry.lane,
          entry.selectedAccountId,
          entry.selectedAccountAliasSnapshot,
          entry.method,
          entry.endpointFamily,
          "in_flight",
          entry.model,
          entry.clientCorrelationId,
        );
        insertsSincePrune++;
        if (insertsSincePrune >= 64) {
          insertsSincePrune = 0;
          // Slice D: in-request maintenance skips the TRUNCATE checkpoint
          // (p99 fsync off the critical path); startup prune + last-close
          // still checkpoint, and WAL space is reused between them.
          journal.prune(false);
        }
      });
      return entry;
    },
    complete(entry, finalize) {
      runSafe(() => {
        updateStmt.run(
          finalize.completedAtUtc,
          Math.max(0, Math.round(finalize.durationMs)),
          finalize.terminalOutcome,
          finalize.httpStatus,
          // CURRENT-004: cycle-safe (byte-identical for plain id arrays).
          safeJsonStringify(finalize.upstreamRequestIds),
          entry.routerRequestId,
        );
      });
    },
    stats() {
      try {
        const meta = statsMetaStmt.get("schema_version") as { value: string } | undefined;
        const count = statsCountStmt.get() as { n: number };
        const oldest = statsOldestStmt.get() as { v: string | null };
        const newest = statsNewestStmt.get() as { v: string | null };
        return {
          schemaVersion: meta ? Number(meta.value) : JOURNAL_SCHEMA_VERSION,
          records: count.n,
          oldestRecordAtUtc: oldest.v,
          newestRecordAtUtc: newest.v,
          degraded,
          lastError,
          retentionDays,
          maxRecords,
        };
      } catch (e) {
        // journal storage fault: report degraded state instead of crashing health
        return {
          schemaVersion: JOURNAL_SCHEMA_VERSION,
          records: 0,
          oldestRecordAtUtc: null,
          newestRecordAtUtc: null,
          degraded: true,
          lastError: e instanceof Error ? e.message : String(e),
          retentionDays,
          maxRecords,
        };
      }
    },
    prune(checkpoint = true) {
      runSafe(() => {
        // GR-007 backstop: construction args are validated at the config and
        // state boundaries, but never trust them here — a fractional OFFSET
        // would degrade the journal, so clamp to the valid domain instead.
        const retention = Number.isFinite(retentionDays) && retentionDays > 0 ? retentionDays : 0;
        const max = Number.isSafeInteger(maxRecords) && maxRecords > 0 ? maxRecords : 0;
        if (retention > 0) {
          const cutoff = new Date(Date.now() - retention * 86_400_000).toISOString();
          db.prepare("DELETE FROM request_journal WHERE started_at_utc < ?").run(cutoff);
        }
        if (max > 0) {
          db.prepare(`
            DELETE FROM request_journal WHERE id IN (
              SELECT id FROM request_journal
              ORDER BY started_at_utc DESC
              LIMIT -1 OFFSET ?
            )
          `).run(max);
        }
        // keep the WAL bounded between checkpoints (retention is row-based)
        if (checkpoint) db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
      });
    },
    close() {
      // BL-001: finalize compiled statements BEFORE db.close(). Unfinalized
      // statements keep the Windows file handle alive until GC finalizes
      // them, which under parallel worker load stretched past a minute and
      // flaked cleanup (T-D04). Deterministic finalize reduces post-close
      // release to milliseconds; the retry loops absorb the remainder.
      for (const s of [insertStmt, updateStmt, statsMetaStmt, statsCountStmt, statsOldestStmt, statsNewestStmt]) {
        try { s.finalize(); } catch { /* already finalized */ }
      }
      db.close();
    },
  };

  // reconcile stale in_flight rows from a prior process that died before finalizing
  runSafe(() => {
    const stale = db.prepare("SELECT COUNT(*) AS n FROM request_journal WHERE terminal_outcome = ?").get("in_flight") as { n: number };
    if (stale.n > 0) {
      db.prepare("UPDATE request_journal SET terminal_outcome = ?, completed_at_utc = ?, duration_ms = 0, http_status = NULL WHERE terminal_outcome = ?").run(
        "local_error",
        utcNow(),
        "in_flight",
      );
      log.warn(`reconciled ${stale.n} stale in_flight journal row(s) from prior process`);
    }
  });
  journal.prune();
  return journal;
}

export { monotonicMs };
