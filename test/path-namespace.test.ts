/**
 * F-01 regression: path-traversal payloads must never escape the pinned
 * lane-base namespace on the upstream URL, and every rejection must be
 * journaled as a local_error/400 with zero upstream calls.
 *
 * The node:http inbound transport (src/inbound-http.ts) preserves the raw
 * request-target verbatim and validates it BEFORE WHATWG URL normalization:
 * encoded traversal (%2e%2e / %2f / %5c) is rejected pre-dispatch, and
 * literal dot-segment escapes from the raw lane prefix (e.g.
 * /go/v1/../../../zen/v1/x) are rejected before normalization can move the
 * target into another lane. In-namespace dot segments (e.g. /go/v1/x/..)
 * remain allowed and normalize within the lane.
 */
import { describe, test, expect, afterEach } from "bun:test";
import {
  startMockUpstream,
  startTestRouter,
  authHeaders,
  readJournalRows,
  rawGet,
  type TestRouter,
} from "./harness.ts";

const routers: TestRouter[] = [];
afterEach(() => {
  for (const r of routers.splice(0)) r.stop();
});

async function newRouter(opts: Parameters<typeof startTestRouter>[0]) {
  const r = await startTestRouter(opts);
  routers.push(r);
  return r;
}

describe("lane path namespace enforcement (F-01)", () => {
  test("control: in-namespace paths reach the pinned lane base with one mock hit each", async () => {
    const upstream = await startMockUpstream();
    const router = await newRouter({
      upstreamBase: upstream.baseUrl,
      upstreamGo: `${upstream.baseUrl}/zen/go/v1`,
      upstreamZen: `${upstream.baseUrl}/zen/v1`,
      accounts: [{ alias: "a1", key: "key-a1" }],
      routes: { go: "a1", zen: "a1" },
    });
    const go = await fetch(`${router.baseUrl}/go/v1/models`, { headers: authHeaders() });
    expect(go.status).toBe(200);
    const zen = await fetch(`${router.baseUrl}/zen/v1/models`, { headers: authHeaders() });
    expect(zen.status).toBe(200);
    expect(upstream.requests.length).toBe(2);
    expect(upstream.requests[0]!.path).toBe("/zen/go/v1/models");
    expect(upstream.requests[1]!.path).toBe("/zen/v1/models");
    const rows = readJournalRows(router.paths.journalDb);
    expect(rows.length).toBe(2);
    for (const row of rows) {
      expect(row.terminal_outcome).toBe("ok");
      expect(row.http_status).toBe(200);
      expect(row.completed_at_utc).not.toBeNull();
    }
    upstream.stop();
  });

  test("encoded traversal escapes are rejected 400 + journal local_error, zero upstream", async () => {
    const upstream = await startMockUpstream();
    const router = await newRouter({
      upstreamBase: upstream.baseUrl,
      upstreamGo: `${upstream.baseUrl}/zen/go/v1`,
      upstreamZen: `${upstream.baseUrl}/zen/v1`,
      accounts: [{ alias: "a1", key: "key-a1" }],
      routes: { go: "a1", zen: "a1" },
    });
    const cases = [
      "/go/v1/%252e%252e/x",
      "/go/v1/..%2fzen%2fv1%2fx",
      "/go/v1/%2e%2e%2fzen%2fv1%2fx",
      "/go/v1/..%5cx",
      "/go/v1/%2f%2f/x",
      "/go/v1/%2f..%2f",
      "/zen/v1/%252e%252e/x",
      "/zen/v1/..%2fgo%2fv1%2fx",
    ];
    for (const p of cases) {
      const upstreamBefore = upstream.requests.length;
      const rowsBefore = readJournalRows(router.paths.journalDb).length;
      const res = await rawGet(router.server.port(), p);
      expect(res.status, `${p} -> ${res.status}`).toBe(400);
      expect(res.error, `${p} socket error`).toBeUndefined();
      expect(upstream.requests.length, `${p} hit upstream`).toBe(upstreamBefore);
      const rows = readJournalRows(router.paths.journalDb);
      expect(rows.length, `${p} journal rows`).toBe(rowsBefore + 1);
      const last = rows[rows.length - 1]!;
      expect(last.terminal_outcome, p).toBe("local_error");
      expect(last.http_status, p).toBe(400);
      expect(last.completed_at_utc, p).not.toBeNull();
    }
    upstream.stop();
  });

  test("in-namespace dot segments are URL-normalized and still allowed", async () => {
    const upstream = await startMockUpstream();
    const router = await newRouter({
      upstreamBase: upstream.baseUrl,
      upstreamGo: `${upstream.baseUrl}/zen/go/v1`,
      upstreamZen: `${upstream.baseUrl}/zen/v1`,
      accounts: [{ alias: "a1", key: "key-a1" }],
      routes: { go: "a1", zen: "a1" },
    });
    const dot = await rawGet(router.server.port(), "/go/v1/./x");
    expect(dot.status).toBe(200);
    expect(upstream.requests.length).toBe(1);
    expect(upstream.requests[0]!.path).toBe("/zen/go/v1/x");
    const dotdot = await rawGet(router.server.port(), "/go/v1/x/..");
    expect(dotdot.status).toBe(200);
    expect(upstream.requests.length).toBe(2);
    expect(upstream.requests[1]!.path).toBe("/zen/go/v1/");
    const rows = readJournalRows(router.paths.journalDb);
    expect(rows.length).toBe(2);
    for (const row of rows) {
      expect(row.terminal_outcome).toBe("ok");
      expect(row.http_status).toBe(200);
    }
    upstream.stop();
  });

  test("cross-lane literal dot-segment traversal is rejected 400 before dispatch (F-01)", async () => {
    const upstream = await startMockUpstream();
    const router = await newRouter({
      upstreamBase: upstream.baseUrl,
      upstreamGo: `${upstream.baseUrl}/zen/go/v1`,
      upstreamZen: `${upstream.baseUrl}/zen/v1`,
      accounts: [{ alias: "a1", key: "key-a1" }],
      routes: { go: "a1", zen: "a1" },
    });
    const res = await rawGet(router.server.port(), "/go/v1/../../../zen/v1/x");
    // The node:http transport preserves the raw request-target verbatim and
    // the inbound validator rejects literal dot-segment escapes from the raw
    // lane prefix BEFORE WHATWG URL normalization could move the target into
    // another lane (F-01 external lane integrity).
    expect(res.status).toBe(400);
    expect(upstream.requests.length).toBe(0);
    const rows = readJournalRows(router.paths.journalDb);
    expect(rows.length).toBe(1);
    expect(rows[0]!.terminal_outcome).toBe("local_error");
    expect(rows[0]!.http_status).toBe(400);
    upstream.stop();
  });

  test("no-lane-prefix dot segments are rejected 400 (cannot enter a lane via normalization)", async () => {
    const upstream = await startMockUpstream();
    const router = await newRouter({
      upstreamBase: upstream.baseUrl,
      upstreamGo: `${upstream.baseUrl}/zen/go/v1`,
      upstreamZen: `${upstream.baseUrl}/zen/v1`,
      accounts: [{ alias: "a1", key: "key-a1" }],
      routes: { go: "a1", zen: "a1" },
    });
    // A raw path with no lane prefix that contains dot segments could, after
    // WHATWG normalization, land inside a lane (e.g. /./go/v1/models ->
    // /go/v1/models). Reject conservatively so lane selection is determined
    // only by the raw lane prefix, never by normalization.
    const cases = ["/./go/v1/models", "/%2e/go/v1/models", "/foo/../go/v1/models"];
    for (const p of cases) {
      const res = await rawGet(router.server.port(), p);
      expect(res.status, p).toBe(400);
    }
    expect(upstream.requests.length).toBe(0);
    const rows = readJournalRows(router.paths.journalDb);
    expect(rows.length).toBe(3);
    for (const row of rows) {
      expect(row.terminal_outcome).toBe("local_error");
      expect(row.http_status).toBe(400);
    }
    upstream.stop();
  });

  test("literal double-slash suffix is rejected before dispatch (journaled R4-C03, no upstream)", async () => {
    const upstream = await startMockUpstream();
    const router = await newRouter({
      upstreamBase: upstream.baseUrl,
      upstreamGo: `${upstream.baseUrl}/zen/go/v1`,
      upstreamZen: `${upstream.baseUrl}/zen/v1`,
      accounts: [{ alias: "a1", key: "key-a1" }],
      routes: { go: "a1", zen: "a1" },
    });
    const res = await rawGet(router.server.port(), "/go/v1//x");
    expect(res.status).toBe(400);
    expect(upstream.requests.length).toBe(0);
    // R4-C03: post-admission local rejects carry the journal/request-id
    // contract (exactly one local_error row), still with zero upstream.
    const rows = readJournalRows(router.paths.journalDb);
    expect(rows.length).toBe(1);
    expect(rows[0]!.terminal_outcome).toBe("local_error");
    expect(rows[0]!.http_status).toBe(400);
    upstream.stop();
  });

  test("malformed percent-escape fails closed (no upstream)", async () => {
    const upstream = await startMockUpstream();
    const router = await newRouter({
      upstreamBase: upstream.baseUrl,
      upstreamGo: `${upstream.baseUrl}/zen/go/v1`,
      upstreamZen: `${upstream.baseUrl}/zen/v1`,
      accounts: [{ alias: "a1", key: "key-a1" }],
      routes: { go: "a1", zen: "a1" },
    });
    const res = await rawGet(router.server.port(), "/go/v1/%zz");
    expect(res.status).toBe(400);
    expect(upstream.requests.length).toBe(0);
    upstream.stop();
  });
});
