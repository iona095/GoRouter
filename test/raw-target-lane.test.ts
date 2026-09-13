/**
 * Raw-target regression tests for the inbound HTTP transport adapter.
 *
 * The adapter validates the raw HTTP request-target BEFORE WHATWG URL
 * normalization, blocking path traversal attacks that would cross lane
 * boundaries. These tests send raw TCP requests with hostile paths and
 * assert 4xx responses + zero upstream calls.
 *
 * Unlike fetch/undici (which normalizes dot segments), raw TCP preserves
 * the exact request-target bytes, allowing us to verify the adapter's
 * pre-normalization validation.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { connect } from "node:net";
import {
  startMockUpstream,
  startTestRouter,
  readJournalRows,
  LOCAL_KEY,
  type TestRouter,
  type MockUpstream,
} from "./harness.ts";

const routers: TestRouter[] = [];
const upstreams: MockUpstream[] = [];

afterEach(() => {
  for (const r of routers.splice(0)) r.stop();
  for (const u of upstreams.splice(0)) u.stop();
});

async function newRouter(opts: Parameters<typeof startTestRouter>[0]) {
  const r = await startTestRouter(opts);
  routers.push(r);
  return r;
}

async function newUpstream() {
  const u = await startMockUpstream();
  upstreams.push(u);
  return u;
}

/**
 * Raw HTTP/1.1 GET with exact request-line bytes preserved.
 * Sends the full request line (not just path) to test adapter validation.
 */
async function rawGet(
  port: number,
  requestLine: string,
): Promise<{ status: number; body: string }> {
  const { promise, resolve, reject } = Promise.withResolvers<{
    status: number;
    body: string;
  }>();
  const sock = connect(port, "127.0.0.1");
  let data = "";
  sock.setEncoding("utf8");
  sock.on("connect", () => {
    sock.write(
      requestLine +
        "\r\nHost: 127.0.0.1:" +
        port +
        "\r\nAuthorization: Bearer " +
        LOCAL_KEY +
        // W0 (Amendment A5/A7): success-path dispatches carry a session; refusal
        // gates (path-namespace, framing) fire before session validation.
        "\r\nX-OpenCode-Session: conv-w0-test-01" +
        "\r\nConnection: close\r\n\r\n",
    );
  });
  sock.on("data", (d) => (data += d));
  sock.on("close", () => {
    const lines = data.split("\r\n");
    const statusLine = lines[0] ?? "";
    const status = parseInt(statusLine.split(" ")[1] ?? "0", 10);
    const bodyStart = data.indexOf("\r\n\r\n");
    const body = bodyStart >= 0 ? data.slice(bodyStart + 4) : "";
    resolve({ status, body });
  });
  sock.on("error", reject);
  // Integration test: genuine network I/O timeout; deterministic control not applicable.
  sock.setTimeout(10_000, () => {
    sock.destroy();
    reject(new Error("timeout"));
  });
  return promise;
}

describe("raw-target validation (inbound HTTP adapter)", () => {
  test("literal dot-segment traversal is rejected", async () => {
    const upstream = await newUpstream();
    const router = await newRouter({ upstreamBase: upstream.baseUrl });

    const res = await rawGet(
      router.server.port(),
      "GET /go/v1/../../../zen/v1/x HTTP/1.1",
    );

    expect(res.status).toBe(400);
    expect(upstream.requests.length).toBe(0);

    const rows = readJournalRows(router.paths.journalDb);
    expect(rows.length).toBe(1);
    const last = rows[rows.length - 1]!;
    expect(last.terminal_outcome).toBe("local_error");
    expect(last.http_status).toBe(400);
  });

  test("reverse traversal is rejected", async () => {
    const upstream = await newUpstream();
    const router = await newRouter({ upstreamBase: upstream.baseUrl });

    const res = await rawGet(
      router.server.port(),
      "GET /zen/v1/../../../go/v1/x HTTP/1.1",
    );

    expect(res.status).toBe(400);
    expect(upstream.requests.length).toBe(0);

    const rows = readJournalRows(router.paths.journalDb);
    expect(rows.length).toBe(1);
    const last = rows[rows.length - 1]!;
    expect(last.terminal_outcome).toBe("local_error");
    expect(last.http_status).toBe(400);
  });

  test("half-encoded dots (lowercase) are rejected", async () => {
    const upstream = await newUpstream();
    const router = await newRouter({ upstreamBase: upstream.baseUrl });

    const res = await rawGet(
      router.server.port(),
      "GET /go/v1/%2e%2e/%2e%2e/zen/v1/x HTTP/1.1",
    );

    expect(res.status).toBe(400);
    expect(upstream.requests.length).toBe(0);

    const rows = readJournalRows(router.paths.journalDb);
    expect(rows.length).toBe(1);
    const last = rows[rows.length - 1]!;
    expect(last.terminal_outcome).toBe("local_error");
    expect(last.http_status).toBe(400);
  });

  test("case-preserved encoded dots (uppercase) are rejected", async () => {
    const upstream = await newUpstream();
    const router = await newRouter({ upstreamBase: upstream.baseUrl });

    const res = await rawGet(
      router.server.port(),
      "GET /go/v1/%2E%2E/%2E%2E/zen/v1/x HTTP/1.1",
    );

    expect(res.status).toBe(400);
    expect(upstream.requests.length).toBe(0);

    const rows = readJournalRows(router.paths.journalDb);
    expect(rows.length).toBe(1);
    const last = rows[rows.length - 1]!;
    expect(last.terminal_outcome).toBe("local_error");
    expect(last.http_status).toBe(400);
  });

  test("literal cross-lane dot-dot traversal is rejected", async () => {
    const upstream = await newUpstream();
    const router = await newRouter({ upstreamBase: upstream.baseUrl });

    const res = await rawGet(
      router.server.port(),
      "GET /go/v1/foo/../../zen/v1/x HTTP/1.1",
    );

    expect(res.status).toBe(400);
    expect(upstream.requests.length).toBe(0);

    const rows = readJournalRows(router.paths.journalDb);
    expect(rows.length).toBe(1);
    const last = rows[rows.length - 1]!;
    expect(last.terminal_outcome).toBe("local_error");
    expect(last.http_status).toBe(400);
  });

  test("double-encoded traversal is rejected", async () => {
    const upstream = await newUpstream();
    const router = await newRouter({ upstreamBase: upstream.baseUrl });

    const res = await rawGet(
      router.server.port(),
      "GET /go/v1/%252e%252e%252f%252e%252e%252f HTTP/1.1",
    );

    expect(res.status).toBe(400);
    expect(upstream.requests.length).toBe(0);

    const rows = readJournalRows(router.paths.journalDb);
    expect(rows.length).toBe(1);
    const last = rows[rows.length - 1]!;
    expect(last.terminal_outcome).toBe("local_error");
    expect(last.http_status).toBe(400);
  });

  test("absolute-form request-target is rejected", async () => {
    const upstream = await newUpstream();
    const router = await newRouter({ upstreamBase: upstream.baseUrl });

    const res = await rawGet(
      router.server.port(),
      "GET http://example.com/go/v1/x HTTP/1.1",
    );

    expect(res.status).toBe(400);
    expect(upstream.requests.length).toBe(0);

    const rows = readJournalRows(router.paths.journalDb);
    expect(rows.length).toBe(1);
    const last = rows[rows.length - 1]!;
    expect(last.terminal_outcome).toBe("local_error");
    expect(last.http_status).toBe(400);
  });

  test("malformed percent-escape is rejected", async () => {
    const upstream = await newUpstream();
    const router = await newRouter({ upstreamBase: upstream.baseUrl });

    const res = await rawGet(
      router.server.port(),
      "GET /go/v1/%zz HTTP/1.1",
    );

    expect(res.status).toBe(400);
    expect(upstream.requests.length).toBe(0);

    const rows = readJournalRows(router.paths.journalDb);
    expect(rows.length).toBe(1);
    const last = rows[rows.length - 1]!;
    expect(last.terminal_outcome).toBe("local_error");
    expect(last.http_status).toBe(400);
  });

  test("control: legitimate Go lane path reaches upstream", async () => {
    const upstream = await newUpstream();
    const router = await newRouter({
      upstreamBase: upstream.baseUrl,
      upstreamGo: `${upstream.baseUrl}/zen/go/v1`,
      upstreamZen: `${upstream.baseUrl}/zen/v1`,
      accounts: [{ alias: "test-account", key: "test-key-123" }],
      routes: { go: "test-account" },
    });

    const res = await rawGet(
      router.server.port(),
      "GET /go/v1/models HTTP/1.1",
    );

    expect(res.status).toBe(200);
    expect(upstream.requests.length).toBe(1);
    expect(upstream.requests[0]!.path).toBe("/zen/go/v1/models");

    const rows = readJournalRows(router.paths.journalDb);
    expect(rows.length).toBe(1);
    const last = rows[rows.length - 1]!;
    expect(last.terminal_outcome).toBe("ok");
    expect(last.http_status).toBe(200);
  });

  test("control: legitimate Zen lane path reaches upstream", async () => {
    const upstream = await newUpstream();
    const router = await newRouter({
      upstreamBase: upstream.baseUrl,
      upstreamGo: `${upstream.baseUrl}/zen/go/v1`,
      upstreamZen: `${upstream.baseUrl}/zen/v1`,
      accounts: [{ alias: "test-account", key: "test-key-123" }],
      routes: { zen: "test-account" },
    });

    const res = await rawGet(
      router.server.port(),
      "GET /zen/v1/models HTTP/1.1",
    );

    expect(res.status).toBe(200);
    expect(upstream.requests.length).toBe(1);
    expect(upstream.requests[0]!.path).toBe("/zen/v1/models");

    const rows = readJournalRows(router.paths.journalDb);
    expect(rows.length).toBe(1);
    const last = rows[rows.length - 1]!;
    expect(last.terminal_outcome).toBe("ok");
    expect(last.http_status).toBe(200);
  });

  test("deep-nested encoding, uppercase absolute-form, and semicolon-param dot segments are rejected", async () => {
    const upstream = await newUpstream();
    const router = await newRouter({ upstreamBase: upstream.baseUrl });

    const cases = [
      // 4-level nested percent-encoding survives a 3-pass decode loop; the
      // residual %2e-family encodings must be rejected, not forwarded.
      "GET /go/v1/%2525252e%2525252e%2525252fzen%2525252fv1%2525252fx HTTP/1.1",
      // 5/6-level nesting leaves deeper residuals (%252e / %25252e) — any
      // residual percent-encoding beyond the loop bound must be rejected.
      "GET /go/v1/%252525252e%252525252e/x HTTP/1.1",
      "GET /go/v1/%25252525252e%25252525252e/x HTTP/1.1",
      // uppercase absolute-form must be rejected case-insensitively
      "GET HTTP://example.com/go/v1/x HTTP/1.1",
      // semicolon-parameter dot segments (matrix-param traversal): a
      // param-aware backend could resolve `..;` as `..` and escape the lane
      "GET /go/v1/..;/zen/v1/x HTTP/1.1",
      "GET /go/v1/..;/..;/v1/x HTTP/1.1",
      "GET /go/v1/%2e%2e%3b/zen/v1/x HTTP/1.1",
      // mixed literal + encoded dot-dot: an encoded `..` must be rejected even
      // when a literal `..` is also present elsewhere
      "GET /go/v1/a/../b/%2e%2e/c HTTP/1.1",
    ];
    for (const line of cases) {
      const res = await rawGet(router.server.port(), line);
      expect(res.status, line).toBe(400);
    }
    expect(upstream.requests.length).toBe(0);
    const rows = readJournalRows(router.paths.journalDb);
    expect(rows.length).toBe(cases.length);
    for (const row of rows) {
      expect(row.terminal_outcome).toBe("local_error");
      expect(row.http_status).toBe(400);
    }
  });

  test("encoded literal percent and dot-like literals are transparent", async () => {
    // A literal '%' (encoded as %25) and encoded dot-like literals are legal
    // path content: the decode loops must stop when no valid percent-encoding
    // remains instead of re-decoding the bare '%' (which would throw and
    // wrongly 400 the request).
    const upstream = await newUpstream();
    const router = await newRouter({
      upstreamBase: upstream.baseUrl,
      accounts: [{ alias: "test-account", key: "test-key-123" }],
      routes: { go: "test-account" },
    });
    const cases = ["/go/v1/a%25b", "/go/v1/x%2e%2eXYZ", "/go/v1/file%2ename"];
    for (const p of cases) {
      const res = await rawGet(router.server.port(), `GET ${p} HTTP/1.1`);
      expect(res.status, p).toBe(200);
    }
    expect(upstream.requests.length).toBe(cases.length);
  });
});
