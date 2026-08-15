/**
 * F-03 regression: Bun.serve's default 10s idle timeout must not kill
 * long-lived LLM streams (long inter-chunk gaps, slow pre-TTFT, slow request
 * bodies). Long cases live in isolated describe blocks; every test lets the
 * client stream fully settle before the router is stopped (force-stopping a
 * server with an in-flight stream segfaulted Bun 1.3.14 in probes).
 */
import { describe, test, expect, afterEach } from "bun:test";
import {
  startMockUpstream,
  startTestRouter,
  authHeaders,
  readJournalRows,
  LOCAL_KEY,
  type TestRouter,
} from "./harness.ts";

const routers: TestRouter[] = [];
afterEach(() => {
  for (const r of routers.splice(0)) {
    try { r.stop(); } catch { /* ignore */ }
  }
});

async function newRouter(opts: Parameters<typeof startTestRouter>[0]) {
  const r = await startTestRouter(opts);
  routers.push(r);
  return r;
}

async function waitForRows(dbPath: string, min: number, timeoutMs = 8000): Promise<Array<Record<string, unknown>>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = readJournalRows(dbPath);
    // a row is only terminal once completed_at_utc is set (begin() writes
    // in_flight first); waiting on completion avoids racing the terminal write
    const completed = rows.filter((r) => r.completed_at_utc !== null).length;
    if (completed >= min || Date.now() > deadline) return rows;
    await new Promise((r) => setTimeout(r, 50));
  }
}

interface ChunkStep {
  text: string;
  delayMs: number;
}

/** SSE response whose chunks are emitted with real delays between them. */
function delayedSse(steps: ChunkStep[]): Response {
  const encoder = new TextEncoder();
  let i = 0;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (i >= steps.length) {
        try { controller.close(); } catch { /* canceled */ }
        return;
      }
      const step = steps[i]!;
      if (step.delayMs > 0) await new Promise((r) => setTimeout(r, step.delayMs));
      try {
        controller.enqueue(encoder.encode(step.text));
        i++;
      } catch { /* canceled */ }
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream" } });
}

describe("long inter-chunk gap (isolated)", () => {
  test("14s inter-chunk gap survives the router idle timeout", async () => {
    const upstream = await startMockUpstream(
      () => delayedSse([
        { text: "data: one\n\n", delayMs: 0 },
        { text: "data: two\n\n", delayMs: 14000 },
      ]),
      { idleTimeout: 0 },
    );
    const router = await newRouter({
      upstreamBase: upstream.baseUrl,
      accounts: [{ alias: "a1", key: "key-a1" }],
      routes: { go: "a1" },
    });
    const res = await fetch(`${router.baseUrl}/go/v1/chat/completions`, {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: "{}",
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toBe("data: one\n\ndata: two\n\n");
    const rows = await waitForRows(router.paths.journalDb, 1);
    expect(rows[0]!.terminal_outcome).toBe("ok");
    expect(rows[0]!.http_status).toBe(200);
    upstream.stop();
  }, { timeout: 25000 });
});

describe("pre-TTFT delay (isolated)", () => {
  test("13s pre-TTFT delay completes (not killed before headers)", async () => {
    const upstream = await startMockUpstream(async () => {
      await new Promise((r) => setTimeout(r, 13000));
      return Response.json({ ok: true });
    }, { idleTimeout: 0 });
    const router = await newRouter({
      upstreamBase: upstream.baseUrl,
      accounts: [{ alias: "a1", key: "key-a1" }],
      routes: { go: "a1" },
    });
    const res = await fetch(`${router.baseUrl}/go/v1/models`, { headers: authHeaders() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const rows = await waitForRows(router.paths.journalDb, 1);
    expect(rows[0]!.terminal_outcome).toBe("ok");
    expect(rows[0]!.http_status).toBe(200);
    upstream.stop();
  }, { timeout: 25000 });
});

describe("chunked request body (isolated)", () => {
  test("chunked-framed request body is rejected 400 before consumption (unsafe framing)", async () => {
    const upstream = await startMockUpstream(async (req) => {
      const body = await req.text();
      return Response.json({ ok: true, len: body.length });
    }, { idleTimeout: 0 });
    const router = await newRouter({
      upstreamBase: upstream.baseUrl,
      accounts: [{ alias: "a1", key: "key-a1" }],
      routes: { go: "a1" },
    });
    const encoder = new TextEncoder();
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (sent >= 5) {
          controller.close();
          return;
        }
        await new Promise((r) => setTimeout(r, 2600));
        controller.enqueue(encoder.encode(`chunk-${sent};`));
        sent++;
      },
    });
    const res = await fetch(`${router.baseUrl}/go/v1/chat/completions`, {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body,
      duplex: "half",
    });
    // Bun fetch sends a ReadableStream body with Transfer-Encoding: chunked.
    // The transport rejects unsafe framing before consumption (400 + journal
    // local_error/400, zero upstream, Connection: close) — the client-abort
    // invariant is preserved by never admitting chunked request bodies.
    expect(res.status).toBe(400);
    // wire-level proof of the Connection: close termination (narrowing #3)
    expect(res.headers.get("connection")).toBe("close");
    const rows = await waitForRows(router.paths.journalDb, 1);
    expect(rows[0]!.terminal_outcome).toBe("local_error");
    expect(rows[0]!.http_status).toBe(400);
    expect(upstream.requests.length).toBe(0);
    upstream.stop();
  }, { timeout: 15000 });

  test("parser-level unsupported Transfer-Encoding (gzip) -> bare 400, no journal row, zero upstream", async () => {
    const upstream = await startMockUpstream();
    const router = await newRouter({
      upstreamBase: upstream.baseUrl,
      accounts: [{ alias: "a1", key: "key-a1" }],
      routes: { go: "a1" },
    });
    const port = router.server.port();
    const { connect } = await import("node:net");
    const sock = connect(port, "127.0.0.1", () => {
      sock.write(
        `POST /go/v1/models HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer ${LOCAL_KEY}\r\nTransfer-Encoding: gzip\r\n\r\n`,
      );
    });
    sock.setEncoding("utf8");
    let buf = "";
    sock.on("data", (d) => { buf += d; });
    await new Promise((r) => setTimeout(r, 1200));
    sock.destroy();
    // Bun's parser rejects the unsupported coding BEFORE the application
    // (PRE_APPLICATION_REJECTION, narrowing #3): bare 400 + Connection:
    // close, zero journal rows, zero upstream calls, zero credential handling.
    expect(buf.startsWith("HTTP/1.1 400")).toBe(true);
    expect(buf.includes("Connection: close")).toBe(true);
    const rows = readJournalRows(router.paths.journalDb);
    expect(rows.length).toBe(0);
    expect(upstream.requests.length).toBe(0);
    upstream.stop();
  }, { timeout: 15000 });

  test("no-lane rejected target journals lane 'unknown' (not a fabricated 'go')", async () => {
    const upstream = await startMockUpstream();
    const router = await newRouter({
      upstreamBase: upstream.baseUrl,
      accounts: [{ alias: "a1", key: "key-a1" }],
      routes: { go: "a1" },
    });
    const port = router.server.port();
    const { connect } = await import("node:net");
    const sock = connect(port, "127.0.0.1", () => {
      // a chunked POST to a target with NO lane prefix: the TE rejection
      // journals BEFORE lane classification — the row must carry the honest
      // "unknown" lane, never a fabricated "go"
      sock.write(
        `POST /foo HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer ${LOCAL_KEY}\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n`,
      );
    });
    sock.setEncoding("utf8");
    let buf = "";
    sock.on("data", (d) => { buf += d; });
    await new Promise((r) => setTimeout(r, 1200));
    sock.destroy();
    expect(buf.startsWith("HTTP/1.1 400")).toBe(true);
    const rows = readJournalRows(router.paths.journalDb);
    expect(rows.length).toBe(1);
    expect(rows[0]!.terminal_outcome).toBe("local_error");
    expect(rows[0]!.http_status).toBe(400);
    expect(rows[0]!.lane).toBe("unknown");
    expect(upstream.requests.length).toBe(0);
    upstream.stop();
  }, { timeout: 15000 });

  test("invalid-raw-target 400 keeps the connection alive (pipelined valid GET is served)", async () => {
    const upstream = await startMockUpstream();
    const router = await newRouter({
      upstreamBase: upstream.baseUrl,
      accounts: [{ alias: "a1", key: "key-a1" }],
      routes: { go: "a1" },
    });
    const port = router.server.port();
    const { connect } = await import("node:net");
    const sock = connect(port, "127.0.0.1", () => {
      // an invalid raw target 400 must NOT terminate the connection
      // (narrowing #4): the pipelined valid GET on the same connection is
      // served — only TE/GET-body rejections terminate.
      sock.write(
        `GET /go/v1/%zz HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer ${LOCAL_KEY}\r\n\r\n` +
          `GET /go/v1/models HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer ${LOCAL_KEY}\r\n\r\n`,
      );
    });
    sock.setEncoding("utf8");
    let buf = "";
    sock.on("data", (d) => { buf += d; });
    await new Promise((r) => setTimeout(r, 1200));
    sock.destroy();
    const statuses = [...buf.matchAll(/HTTP\/1\.1 (\d{3})/g)].map((m) => m[1]);
    expect(statuses).toContain("400"); // the invalid-target rejection
    expect(statuses).toContain("200"); // the pipelined follow-up WAS served
    const rows = readJournalRows(router.paths.journalDb);
    expect(rows.length).toBe(2); // rejection row + dispatched GET row
    expect(rows[0]!.terminal_outcome).toBe("local_error");
    expect(rows[0]!.http_status).toBe(400);
    expect(rows[1]!.terminal_outcome).toBe("ok");
    expect(rows[1]!.http_status).toBe(200);
    expect(upstream.requests.length).toBe(1);
    upstream.stop();
  }, { timeout: 15000 });

  test("pipelined request after a chunked rejection is refused (connection terminated)", async () => {
    const upstream = await startMockUpstream();
    const router = await newRouter({
      upstreamBase: upstream.baseUrl,
      accounts: [{ alias: "a1", key: "key-a1" }],
      routes: { go: "a1" },
    });
    const port = router.server.port();
    const { connect } = await import("node:net");
    const sock = connect(port, "127.0.0.1", () => {
      // chunked POST (rejected) immediately followed by a pipelined valid GET
      // in the same write: the parser may dispatch the second request, but the
      // terminated-socket gate must refuse it — never a 200/upstream hit.
      sock.write(
        `POST /go/v1/chat/completions HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer ${LOCAL_KEY}\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n` +
          `GET /go/v1/models HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer ${LOCAL_KEY}\r\n\r\n`,
      );
    });
    sock.setEncoding("utf8");
    let buf = "";
    sock.on("data", (d) => { buf += d; });
    await new Promise((r) => setTimeout(r, 1200));
    sock.destroy();
    const statuses = [...buf.matchAll(/HTTP\/1\.1 (\d{3})/g)].map((m) => m[1]);
    expect(statuses).not.toContain("200"); // the pipelined GET must never dispatch
    const rows = readJournalRows(router.paths.journalDb);
    expect(rows.length).toBe(1); // exactly the chunked rejection row
    expect(rows[0]!.terminal_outcome).toBe("local_error");
    expect(rows[0]!.http_status).toBe(400);
    expect(upstream.requests.length).toBe(0);
    upstream.stop();
  }, { timeout: 15000 });

  test("Transfer-Encoding rejection precedes raw-target validation (connection terminated)", async () => {
    const upstream = await startMockUpstream();
    const router = await newRouter({
      upstreamBase: upstream.baseUrl,
      accounts: [{ alias: "a1", key: "key-a1" }],
      routes: { go: "a1" },
    });
    const port = router.server.port();
    const { connect } = await import("node:net");
    const sock = connect(port, "127.0.0.1", () => {
      // an invalid-target POST carrying Transfer-Encoding: chunked, pipelined
      // with a valid GET: the TE rejection must run FIRST and terminate the
      // connection so the pipelined GET is refused, never dispatched
      sock.write(
        `POST /go/v1/%zz HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer ${LOCAL_KEY}\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n` +
          `GET /go/v1/models HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer ${LOCAL_KEY}\r\n\r\n`,
      );
    });
    sock.setEncoding("utf8");
    let buf = "";
    sock.on("data", (d) => { buf += d; });
    await new Promise((r) => setTimeout(r, 1200));
    sock.destroy();
    const statuses = [...buf.matchAll(/HTTP\/1\.1 (\d{3})/g)].map((m) => m[1]);
    expect(statuses).not.toContain("200");
    const rows = readJournalRows(router.paths.journalDb);
    expect(rows.length).toBe(1); // exactly the TE rejection row
    expect(rows[0]!.terminal_outcome).toBe("local_error");
    expect(rows[0]!.http_status).toBe(400);
    expect(upstream.requests.length).toBe(0);
    upstream.stop();
  }, { timeout: 15000 });
});

describe("control and client abort (isolated)", () => {
  test("control: 2s inter-chunk gaps complete normally", async () => {
    const upstream = await startMockUpstream(
      () => delayedSse([
        { text: "data: a\n\n", delayMs: 0 },
        { text: "data: b\n\n", delayMs: 2000 },
      ]),
      { idleTimeout: 0 },
    );
    const router = await newRouter({
      upstreamBase: upstream.baseUrl,
      accounts: [{ alias: "a1", key: "key-a1" }],
      routes: { go: "a1" },
    });
    const res = await fetch(`${router.baseUrl}/go/v1/chat/completions`, {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: "{}",
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("data: a\n\ndata: b\n\n");
    const rows = await waitForRows(router.paths.journalDb, 1);
    expect(rows[0]!.terminal_outcome).toBe("ok");
    expect(rows[0]!.http_status).toBe(200);
    upstream.stop();
  }, { timeout: 15000 });
  // NOTE: the "client abort after first chunk" scenario is covered by
  // socket-failure.test.ts's CLIENT_ABORT test (identical assertions: 200 +
  // first chunk, journal client_abort, upstream observes the abort). A
  // mid-stream client abort through the router leaks a Bun 1.3.14 connection
  // handle (bun#32585); a third abort transaction in this suite (this file
  // sorts before proxy.test.ts and would poison its streaming tests)
  // deterministically segfaults the process at teardown.
});

describe("keep-alive idle (isolated)", () => {
  test("connection survives 14s idle between requests", async () => {
    const upstream = await startMockUpstream(() => Response.json({ ok: true }), { idleTimeout: 0 });
    const router = await newRouter({
      upstreamBase: upstream.baseUrl,
      accounts: [{ alias: "a1", key: "key-a1" }],
      routes: { go: "a1" },
    });
    const { connect } = await import("node:net");
    const port = router.server.port();
    const sock = connect(port, "127.0.0.1");
    sock.setEncoding("utf8");
    await new Promise<void>((r, rej) => {
      sock.once("connect", r);
      sock.once("error", rej);
    });
    let buf = "";
    const readResponse = () =>
      new Promise<{ status: number }>((resolve, reject) => {
        const onData = (d: string) => {
          buf += d;
          const sep = buf.indexOf("\r\n\r\n");
          if (sep === -1) return;
          const head = buf.slice(0, sep);
          const m = /^HTTP\/\d\.\d\s+(\d{3})/.exec(head);
          const status = m ? Number(m[1]) : 0;
          const headerLen = sep + 4;
          const cl = /content-length:\s*(\d+)/i.exec(head);
          if (cl) {
            const total = headerLen + Number(cl[1]);
            if (buf.length >= total) {
              sock.off("data", onData);
              buf = buf.slice(total);
              resolve({ status });
            }
            return;
          }
          // The node:http adapter emits responses with Transfer-Encoding:
          // chunked (the router strips content-length and streams), so the
          // decoder must also parse chunked framing: <hex-size>\r\n<data>\r\n
          // ... 0\r\n\r\n
          const isChunked = /transfer-encoding:\s*chunked/i.test(head);
          if (!isChunked) return; // unsupported framing; wait for more data
          const body = buf.slice(headerLen);
          let offset = 0;
          for (;;) {
            const lineEnd = body.indexOf("\r\n", offset);
            if (lineEnd === -1) break; // size line incomplete
            const sizeText = body.slice(offset, lineEnd).split(";")[0] ?? "";
            const size = parseInt(sizeText, 16);
            if (Number.isNaN(size)) break;
            const nextOffset = lineEnd + 2 + size + 2; // size line + data + CRLF
            if (body.length < nextOffset) break; // chunk data incomplete
            offset = nextOffset;
            if (size === 0) {
              sock.off("data", onData);
              buf = buf.slice(headerLen + offset);
              resolve({ status });
              return;
            }
          }
        };
        sock.on("data", onData);
        sock.once("error", reject);
      });
    const send = (p: string) => {
      sock.write(
        `GET ${p} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer ${LOCAL_KEY}\r\nConnection: keep-alive\r\n\r\n`,
      );
    };
    send("/go/v1/models");
    const r1 = await readResponse();
    expect(r1.status).toBe(200);
    // idle well past the 10s default; the per-request disable must persist
    await new Promise((r) => setTimeout(r, 14000));
    send("/go/v1/models");
    const r2 = await readResponse();
    expect(r2.status).toBe(200);
    sock.end();
    upstream.stop();
  }, { timeout: 25000 });
});
