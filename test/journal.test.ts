/**
 * Request-journal tests: id uniqueness under concurrency, route-snapshot
 * truth, rename preservation, UTC timing, persistence across reopen,
 * bounded retention, degradation without routing impact, correlation id
 * validation, and response-header exposure.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJournal, JOURNAL_SCHEMA_VERSION } from "../src/journal.ts";
import { startMockUpstream, startTestRouter, authHeaders, readJournalRows, type TestRouter } from "./harness.ts";

const routers: TestRouter[] = [];
afterEach(() => {
  for (const r of routers.splice(0)) r.stop();
});

async function newRouter(opts: Parameters<typeof startTestRouter>[0]) {
  const r = await startTestRouter(opts);
  routers.push(r);
  return r;
}

describe("journal basics", () => {
  test("every accepted request gets a unique router_request_id before dispatch", async () => {
    const upstream = await startMockUpstream();
    const router = await newRouter({ upstreamBase: upstream.baseUrl, accounts: [{ alias: "a1", key: "k" }], routes: { go: "a1" } });
    const ids = new Set<string>();
    const results = await Promise.all(
      Array.from({ length: 25 }, () =>
        fetch(`${router.baseUrl}/go/v1/models`, { headers: authHeaders() }).then(async (r) => {
          const id = r.headers.get("x-gorouter-request-id")!;
          ids.add(id);
          return id;
        }),
      ),
    );
    expect(results.length).toBe(25);
    expect(ids.size).toBe(25);
    const rows = readJournalRows(router.paths.journalDb);
    expect(rows.length).toBe(25);
    const rowIds = new Set(rows.map((r) => r.router_request_id as string));
    expect(rowIds.size).toBe(25);
    // ids assigned before dispatch: journal row exists for the same id the client saw
    for (const id of ids) expect(rowIds.has(id)).toBe(true);
    upstream.stop();
  });

  test("record carries lane, method, endpoint family, timing, status, outcome", async () => {
    const upstream = await startMockUpstream(() => Response.json({ ok: true }, { status: 200, headers: { "x-request-id": "up-id-42" } }));
    const router = await newRouter({ upstreamBase: upstream.baseUrl, accounts: [{ alias: "a1", key: "k" }], routes: { go: "a1" } });
    const res = await fetch(`${router.baseUrl}/go/v1/chat/completions?q=1`, { method: "POST", headers: authHeaders(), body: "{}" });
    expect(res.status).toBe(200);
    const rows = readJournalRows(router.paths.journalDb);
    expect(rows.length).toBe(1);
    const row = rows[0]!;
    expect(row.schema_version).toBe(JOURNAL_SCHEMA_VERSION);
    expect(row.lane).toBe("go");
    expect(row.method).toBe("POST");
    expect(row.endpoint_family).toBe("chat/completions");
    expect(row.terminal_outcome).toBe("ok");
    expect(row.http_status).toBe(200);
    expect(String(row.started_at_utc)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(String(row.completed_at_utc)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(typeof row.duration_ms).toBe("number");
    expect(Number(row.duration_ms)).toBeGreaterThanOrEqual(0);
    // allowlisted upstream request id captured
    expect(JSON.parse(row.upstream_request_ids as string)).toContain("x-request-id: up-id-42");
    // model unknown (no body parsing for telemetry)
    expect(row.model).toBeNull();
    expect(row.selected_account_alias_snapshot).toBe("a1");
    upstream.stop();
  });

  test("model stays unknown; correlation id captured only when valid", async () => {
    const upstream = await startMockUpstream();
    const router = await newRouter({ upstreamBase: upstream.baseUrl, accounts: [{ alias: "a1", key: "k" }], routes: { go: "a1" } });
    await fetch(`${router.baseUrl}/go/v1/chat/completions`, {
      method: "POST",
      headers: authHeaders({ "x-gorouter-correlation-id": "valid-correlation-1" }),
      body: JSON.stringify({ model: "secret-model-name" }),
    });
    await fetch(`${router.baseUrl}/go/v1/chat/completions`, {
      method: "POST",
      headers: authHeaders({ "x-gorouter-correlation-id": "bad id with spaces!!" }),
      body: "{}",
    });
    await fetch(`${router.baseUrl}/go/v1/chat/completions`, { method: "POST", headers: authHeaders(), body: "{}" });
    const rows = readJournalRows(router.paths.journalDb);
    expect(rows[0]!.client_correlation_id).toBe("valid-correlation-1");
    expect(rows[1]!.client_correlation_id).toBeNull();
    expect(rows[2]!.client_correlation_id).toBeNull();
    // body model id never journaled
    for (const r of rows) expect(r.model).toBeNull();
    upstream.stop();
  });

  test("rename preserves stable account id with alias-at-time snapshot", async () => {
    const upstream = await startMockUpstream();
    const router = await newRouter({ upstreamBase: upstream.baseUrl, accounts: [{ alias: "alpha", key: "k" }], routes: { go: "alpha" } });
    const before = router.state.read().accounts[0]!;
    await fetch(`${router.baseUrl}/go/v1/models`, { headers: authHeaders() });
    router.state.mutate((s) => {
      const a = s.accounts.find((x) => x.id === before.id)!;
      a.alias = "beta";
    });
    await fetch(`${router.baseUrl}/go/v1/models`, { headers: authHeaders() });
    const rows = readJournalRows(router.paths.journalDb);
    expect(rows.length).toBe(2);
    expect(rows[0]!.selected_account_id).toBe(before.id);
    expect(rows[0]!.selected_account_alias_snapshot).toBe("alpha");
    expect(rows[1]!.selected_account_id).toBe(before.id);
    expect(rows[1]!.selected_account_alias_snapshot).toBe("beta");
    upstream.stop();
  });
});

describe("journal persistence and retention", () => {
  test("records survive journal reopen (router restart)", async () => {
    const upstream = await startMockUpstream();
    const router = await newRouter({ upstreamBase: upstream.baseUrl, accounts: [{ alias: "a1", key: "k" }], routes: { go: "a1" } });
    await fetch(`${router.baseUrl}/go/v1/models`, { headers: authHeaders() });
    expect(readJournalRows(router.paths.journalDb).length).toBe(1);
    router.journal.close();
    const reopened = createJournal(router.paths.journalDb, 30, 100_000);
    expect(reopened.stats().records).toBe(1);
    reopened.close();
    upstream.stop();
  });

  test("retention prunes by age and max records", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gorouter-journal-"));
    try {
      const dbPath = join(dir, "j.db");
      const j = createJournal(dbPath, 7, 10);
      // backfill old rows directly (raw connection stays open; closed after the journal)
      const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");
      const db = new Database(dbPath);
      const old = new Date(Date.now() - 8 * 86_400_000).toISOString();
      const fresh = new Date().toISOString();
      const ins = db.prepare(`INSERT INTO request_journal
        (schema_version, router_request_id, started_at_utc, lane, method, endpoint_family, terminal_outcome)
        VALUES (?, ?, ?, 'go', 'GET', 'models', 'ok')`);
      for (let i = 0; i < 5; i++) ins.run(1, `old-${i}`, old);
      for (let i = 0; i < 8; i++) ins.run(1, `new-${i}`, fresh);
      j.prune();
      const st = j.stats();
      expect(st.records).toBe(8); // 5 old pruned by age
      j.close();
      // BL-001: finalize before close — no GC-dependent handle linger.
      try { ins.finalize(); } catch { /* already finalized */ }
      db.close();

      const j2 = createJournal(dbPath, 7, 3);
      j2.prune();
      expect(j2.stats().records).toBe(3); // capped by maxRecords
      j2.close();
    } finally {
      // WAL cleanup can lag the close; retry briefly before failing
      for (let attempt = 0; attempt < 10; attempt++) {
        try {
          rmSync(dir, { recursive: true, force: true });
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 100));
        }
      }
    }
  });

  test("journal failure degrades observably but routing continues (no fallback)", async () => {
    const upstream = await startMockUpstream();
    const router = await newRouter({ upstreamBase: upstream.baseUrl, accounts: [{ alias: "a1", key: "k" }], routes: { go: "a1" } });
    // simulate a storage fault: close the journal db underneath the server
    router.journal.close();
    const res = await fetch(`${router.baseUrl}/go/v1/models`, { headers: authHeaders() });
    expect(res.status).toBe(200); // routing must not be blocked
    // CURRENT-007: degraded evidence moved off the unauthenticated surface;
    // the same journal handle reports it (control pipe journal.stats agrees).
    const stats = router.journal.stats();
    expect(stats.degraded).toBe(true);
    expect(stats.lastError).toBeTruthy();
    upstream.stop();
  });
});

describe("local response metadata", () => {
  test("x-gorouter-request-id header does not alter response body; not sent upstream", async () => {
    const upstream = await startMockUpstream(() => Response.json({ hello: "world" }));
    const router = await newRouter({ upstreamBase: upstream.baseUrl, accounts: [{ alias: "a1", key: "k" }], routes: { go: "a1" } });
    const res = await fetch(`${router.baseUrl}/go/v1/echo`, { headers: authHeaders() });
    expect(await res.json()).toEqual({ hello: "world" });
    expect(upstream.requests[0]!.headers.get("x-gorouter-request-id")).toBeNull();
    upstream.stop();
  });
});
