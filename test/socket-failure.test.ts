/**
 * §11 socket-failure classification: genuine upstream mid-stream failures
 * must be upstream_error (not client_abort), client aborts before headers
 * must be client_abort (not upstream_error), the proxied stream must not
 * dangle until the idle timeout, and the wrapper must not read the upstream
 * body ahead of consumer demand.
 */
import { describe, test, expect, afterEach } from "bun:test";
import net from "node:net";
import {
  startMockUpstream,
  startTestRouter,
  authHeaders,
  readJournalRows,
  LOCAL_KEY,
  type TestRouter,
} from "./harness.ts";
import { wrapBodyWithFinalize } from "../src/server.ts";
import { MAX_REQUEST_BODY_BYTES, setInboundBodyIdleTimeoutForTests, resetInboundBodyIdleTimeoutForTests } from "../src/inbound-http.ts";

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

/**
 * Raw TCP upstream that writes a canned response then drops the connection.
 * The destroy is deferred ~150ms so Bun's fetch resolves the response first
 * and the premature close surfaces deterministically instead of racing
 * between fetch-level and body-level failure.
 */
async function rawUpstream(
  respond: (sock: net.Socket) => void,
): Promise<{ port: number; close: () => void }> {
  const srv = net.createServer((sock) => {
    sock.on("error", () => { /* peer may RST after our destroy */ });
    sock.once("data", () => {
      respond(sock);
      setTimeout(() => { if (!sock.destroyed) sock.destroy(); }, 150);
    });
  });
  await new Promise<void>((resolve, reject) => {
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", resolve);
  });
  const port = (srv.address() as net.AddressInfo).port;
  return { port, close: () => { srv.close(); } };
}

describe("socket failure classification (§11)", () => {
  test("BEFORE_HEADERS: upstream at a closed port -> 502 GoRouterUpstreamError, journal upstream_error/502", async () => {
    const upstream = await startMockUpstream();
    const port = upstream.port;
    upstream.stop();
    const router = await newRouter({
      upstreamBase: `http://127.0.0.1:${port}`,
      accounts: [{ alias: "a1", key: "k" }],
      routes: { go: "a1" },
    });
    const res = await fetch(`${router.baseUrl}/go/v1/models`, { headers: authHeaders() });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { type: string } };
    expect(body.error.type).toBe("GoRouterUpstreamError");
    expect(res.headers.get("x-gorouter-request-id")).toBeTruthy();
    const rows = readJournalRows(router.paths.journalDb);
    expect(rows.length).toBe(1);
    expect(rows[0]!.terminal_outcome).toBe("upstream_error");
    expect(rows[0]!.http_status).toBe(502);
  });

  test("AFTER_HEADERS_BEFORE_BODY: zero-body CL violation completes promptly, journal upstream_error (not client_abort)", async () => {
    const raw = await rawUpstream((sock) => {
      sock.write("HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n"); // headers, zero body bytes
    });
    const router = await newRouter({
      upstreamBase: `http://127.0.0.1:${raw.port}`,
      accounts: [{ alias: "a1", key: "k" }],
      routes: { go: "a1" },
    });
    const res = await fetch(`${router.baseUrl}/go/v1/models`, { headers: authHeaders() });
    expect(res.status).toBe(200);
    const t0 = Date.now();
    try {
      await res.text(); // resolves or rejects — either way it must be prompt
    } catch { /* upstream error surfaced by Bun */ }
    const elapsed = Date.now() - t0;
    // prompt completion, never a ~10s dangle on a stalled body (old code
    // misclassified this as client_abort and left the stream dangling)
    expect(elapsed, `client stalled ${elapsed}ms on a violated body`).toBeLessThan(8000);
    const rows = await waitForRows(router.paths.journalDb, 1);
    expect(rows[0]!.terminal_outcome).toBe("upstream_error");
    expect(rows[0]!.terminal_outcome).not.toBe("client_abort");
    expect(rows[0]!.completed_at_utc).not.toBeNull();
    raw.close();
  }, { timeout: 15000 });

  test("MID_STREAM CL-violation: truncation after a chunk completes promptly, journal upstream_error exactly once", async () => {
    const raw = await rawUpstream((sock) => {
      sock.write("HTTP/1.1 200 OK\r\nContent-Length: 100\r\ncontent-type: text/event-stream\r\n\r\ndata: one\n\n");
    });
    const router = await newRouter({
      upstreamBase: `http://127.0.0.1:${raw.port}`,
      accounts: [{ alias: "a1", key: "k" }],
      routes: { go: "a1" },
    });
    const res = await fetch(`${router.baseUrl}/go/v1/chat/completions`, { headers: authHeaders() });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(decoder.decode(first.value)).toBe("data: one\n\n");
    const t0 = Date.now();
    try {
      for (;;) {
        const { done } = await reader.read();
        if (done) break;
      }
    } catch { /* upstream error surfaced by Bun */ }
    const elapsed = Date.now() - t0;
    // prompt completion after the truncation, never a silent ~10s hang; the
    // journal must say upstream_error (the error text mentions "closed" but
    // the failure is upstream's — never inferred as a client abort)
    expect(elapsed, `client stalled ${elapsed}ms after mid-stream truncation`).toBeLessThan(8000);
    const rows = await waitForRows(router.paths.journalDb, 1);
    expect(rows.length).toBe(1);
    expect(rows[0]!.terminal_outcome).toBe("upstream_error");
    expect(rows[0]!.terminal_outcome).not.toBe("client_abort");
    expect(rows[0]!.completed_at_utc).not.toBeNull();
    raw.close();
  }, { timeout: 15000 });

  test("CLIENT_ABORT mid-stream: abort after first chunk -> journal client_abort/200, upstream sees abort", async () => {
    // The mock leg is a raw TCP server (not Bun.serve): a Bun.serve mock's
    // response-stream cancellation racing the router's fetch abort segfaults
    // Bun 1.3.14 when other streams are in flight in the same process. The
    // raw socket sees the same abort through its connection close.
    let mockSawClose = false;
    const rawSrv = net.createServer((sock) => {
      sock.on("error", () => { /* peer aborts mid-stream */ });
      sock.on("close", () => { mockSawClose = true; });
      sock.once("data", () => {
        sock.write("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\ndata: one\n\n");
      });
    });
    await new Promise<void>((resolve, reject) => {
      rawSrv.once("error", reject);
      rawSrv.listen(0, "127.0.0.1", resolve);
    });
    const rawPort = (rawSrv.address() as net.AddressInfo).port;
    const router = await newRouter({
      upstreamBase: `http://127.0.0.1:${rawPort}`,
      accounts: [{ alias: "a1", key: "k" }],
      routes: { go: "a1" },
    });
    const ac = new AbortController();
    const res = await fetch(`${router.baseUrl}/go/v1/chat/completions`, {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: "{}",
      signal: ac.signal,
    });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(first.value).toBeTruthy();
    ac.abort();
    await new Promise((r) => setTimeout(r, 500));
    const rows = await waitForRows(router.paths.journalDb, 1);
    expect(rows[0]!.terminal_outcome).toBe("client_abort");
    expect(rows[0]!.http_status).toBe(200);
    expect(mockSawClose).toBe(true);
    rawSrv.close();
  }, { timeout: 15000 });

  test("graceful request-side FIN (half-close) after a complete CL POST is not a client abort", async () => {
    // A client that sends the complete request then half-closes its write side
    // (Connection: close + FIN) has NOT aborted: the server must process the
    // request normally (journal ok/200, upstream hit). Bun 1.3.14 cannot
    // deliver the response bytes to a half-closed client (transport defect,
    // documented), but the server-side processing and journal must stay
    // truthful — never a false client_abort.
    const upstream = await startMockUpstream();
    const router = await newRouter({
      upstreamBase: upstream.baseUrl,
      accounts: [{ alias: "a1", key: "k" }],
      routes: { go: "a1" },
    });
    const port = router.server.port();
    const sock = net.connect(port, "127.0.0.1", () => {
      sock.end(
        `POST /go/v1/chat/completions HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer ${LOCAL_KEY}\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}`,
      );
    });
    sock.setEncoding("utf8");
    sock.on("data", () => {});
    await new Promise((r) => setTimeout(r, 1200));
    const rows = await waitForRows(router.paths.journalDb, 1);
    expect(rows[0]!.terminal_outcome).toBe("ok");
    expect(rows[0]!.terminal_outcome).not.toBe("client_abort");
    expect(rows[0]!.http_status).toBe(200);
    expect(upstream.requests.length).toBe(1);
    upstream.stop();
  }, { timeout: 15000 });

  test("bodyless GET with Connection: close + request-side FIN is not a client abort", async () => {
    // The narrowing applies to every Connection: close request: a client that
    // declared close and then FINs its write side has not aborted — the
    // request processes normally (journal ok), even without a body.
    const upstream = await startMockUpstream();
    const router = await newRouter({
      upstreamBase: upstream.baseUrl,
      accounts: [{ alias: "a1", key: "k" }],
      routes: { go: "a1" },
    });
    const port = router.server.port();
    const sock = net.connect(port, "127.0.0.1", () => {
      sock.end(
        `GET /go/v1/models HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer ${LOCAL_KEY}\r\nConnection: close\r\n\r\n`,
      );
    });
    sock.setEncoding("utf8");
    sock.on("data", () => {});
    await new Promise((r) => setTimeout(r, 1200));
    const rows = await waitForRows(router.paths.journalDb, 1);
    expect(rows[0]!.terminal_outcome).toBe("ok");
    expect(rows[0]!.terminal_outcome).not.toBe("client_abort");
    expect(rows[0]!.http_status).toBe(200);
    expect(upstream.requests.length).toBe(1);
    upstream.stop();
  }, { timeout: 15000 });

  test("ABORT_BEFORE_HEADERS: client abort while upstream delays headers -> journal client_abort (not upstream_error/502)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const upstream = await startMockUpstream(async () => {
      await gate;
      return Response.json({ ok: true });
    }, { idleTimeout: 0 });
    const router = await newRouter({
      upstreamBase: upstream.baseUrl,
      accounts: [{ alias: "a1", key: "k" }],
      routes: { go: "a1" },
    });
    const ac = new AbortController();
    const fetchPromise = fetch(`${router.baseUrl}/go/v1/models`, { headers: authHeaders(), signal: ac.signal });
    await new Promise((r) => setTimeout(r, 300));
    ac.abort();
    let fetchRejected = false;
    try {
      await fetchPromise;
    } catch {
      fetchRejected = true;
    }
    expect(fetchRejected).toBe(true);
    const rows = await waitForRows(router.paths.journalDb, 1);
    expect(rows[0]!.terminal_outcome).toBe("client_abort");
    expect(rows[0]!.terminal_outcome).not.toBe("upstream_error");
    expect(rows[0]!.http_status).toBeNull(); // pending abort has no upstream status (claim 5)
    expect(upstream.requests.length).toBe(1);
    release();
    upstream.stop();
  }, { timeout: 15000 });

  test("stop() with an in-flight request finalizes the journal synchronously (client_abort/null)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const upstream = await startMockUpstream(async () => {
      await gate;
      return Response.json({ ok: true });
    }, { idleTimeout: 0 });
    const router = await newRouter({
      upstreamBase: upstream.baseUrl,
      accounts: [{ alias: "a1", key: "k" }],
      routes: { go: "a1" },
    });
    const fetchPromise = fetch(`${router.baseUrl}/go/v1/models`, { headers: authHeaders() }).catch(() => null);
    await new Promise((r) => setTimeout(r, 300));
    // stop() aborts the active controllers FIRST and the abort listeners fire
    // SYNCHRONOUSLY: the journal row must already be finalized the moment
    // stop() returns (claim 5) — a caller that closes the journal immediately
    // after stop() must not race the finalization.
    router.server.stop();
    const rows = readJournalRows(router.paths.journalDb);
    expect(rows.length).toBe(1);
    expect(rows[0]!.terminal_outcome).toBe("client_abort");
    expect(rows[0]!.http_status).toBeNull();
    expect(upstream.requests.length).toBe(1);
    release();
    await fetchPromise;
    upstream.stop();
  }, { timeout: 15000 });

  test("client aborts mid-body before dispatch -> no journal row (narrowing #7)", async () => {
    const upstream = await startMockUpstream();
    const router = await newRouter({
      upstreamBase: upstream.baseUrl,
      accounts: [{ alias: "a1", key: "k" }],
      routes: { go: "a1" },
    });
    const port = router.server.port();
    const sock = net.connect(port, "127.0.0.1", () => {
      // declared length 100, only 2 bytes sent, then the client disconnects:
      // the body never completed and dispatch never began
      sock.write(
        `POST /go/v1/chat/completions HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer ${LOCAL_KEY}\r\nContent-Length: 100\r\n\r\n{}`,
      );
    });
    sock.setEncoding("utf8");
    sock.on("data", () => {});
    await new Promise((r) => setTimeout(r, 250));
    sock.destroy();
    await new Promise((r) => setTimeout(r, 500));
    // pre-dispatch mid-body abort: no journal entry was begun (narrowing #7)
    const rows = readJournalRows(router.paths.journalDb);
    expect(rows.length).toBe(0);
    expect(upstream.requests.length).toBe(0);
    upstream.stop();
  }, { timeout: 15000 });

  test("BACKPRESSURE: pull-driven wrapper reads one upstream chunk per consumer pull", async () => {
    // Bun's transport eagerly drains a response body regardless of consumer
    // demand (verified: a bare fetch with a slow reader still makes the mock
    // produce the entire 60MB stream), so the mock pull count cannot observe
    // the router's read-ahead over the network. The wrapper is therefore
    // exercised directly with a pull-gated source: the old start()-based
    // implementation read the whole source into its queue before the consumer
    // read a byte; the pull-driven rewrite must never read ahead by more than
    // one chunk.
    const { wrapBodyWithFinalize } = await import("../src/server.ts");
    let upstreamPulls = 0;
    const CHUNK = new Uint8Array(1024).fill(0x61);
    const N = 2000;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        upstreamPulls++;
        if (upstreamPulls > N) {
          controller.close();
          return;
        }
        controller.enqueue(CHUNK);
      },
    });
    let mode: string | null = null;
    const wrapped = wrapBodyWithFinalize(source, (m) => { mode = m; }, null);
    expect(wrapped).not.toBeNull();
    const reader = wrapped!.getReader();
    const k = 10;
    let clientReads = 0;
    for (let i = 0; i < k; i++) {
      const { done } = await reader.read();
      if (done) break;
      clientReads++;
      await new Promise((r) => setTimeout(r, 10));
    }
    // the wrapper must not have drained the 2000-chunk source ahead of the
    // consumer; production tracks consumption within a tiny slack
    expect(upstreamPulls).toBeLessThanOrEqual(clientReads + 2);
    await reader.cancel();
    expect(mode === "aborted", "wrapper must finish aborted on client cancel").toBe(true);
  }, { timeout: 15000 });
});

describe("wrapBodyWithFinalize in-process unit (F-05)", () => {
  test("AbortError-named upstream read failure with a live client settles the consumer", async () => {
    // In-process unit test (no network, no bun#32585 teardown-handle budget).
    let upstreamPulls = 0;
    const upstream = new ReadableStream<Uint8Array>({
      pull() {
        upstreamPulls++;
        // upstream body read fails with an AbortError-NAMED error while the
        // client is still connected (no client signal is passed below)
        const err = new Error("upstream body failed mid-stream");
        err.name = "AbortError";
        throw err;
      },
    });

    const onEnd: Array<"completed" | "aborted" | "error"> = [];
    // NO client signal: the client is alive, so the abort classification rests
    // solely on the error name. The fix must close() the controller so this
    // surviving consumer settles instead of hanging forever.
    const wrapped = wrapBodyWithFinalize(upstream, (m) => onEnd.push(m), null);
    expect(wrapped).not.toBeNull();

    const reader = wrapped!.getReader();
    // Real-time hang guard: fake timers cannot drive this race, because the
    // buggy behavior under test is the ABSENCE of any settlement event — there
    // is no signal to await and nothing advanceTimersByTime could reveal.
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    const hangGuard = new Promise<{ settled: false }>((resolve) => {
      settleTimer = setTimeout(() => resolve({ settled: false }), 1000);
    });
    const settled = await Promise.race([
      reader.read().then((result) => ({ settled: true as const, result })),
      hangGuard,
    ]);
    clearTimeout(settleTimer);
    // F-05 regression: pre-fix the branch did reader.cancel()+finish('aborted')
    // without controller.close()/error(), leaving this read() pending forever.
    expect(settled.settled, "wrapped stream must settle promptly (not hang)").toBe(true);
    if (settled.settled) {
      // the guarded close() settles the surviving consumer as a clean end
      expect(settled.result.done).toBe(true);
    }
    // exactly once, with the abort classification
    expect(onEnd).toEqual(["aborted"]);
    // The wrapper canceled its upstream reader instead of resuming: the source
    // was pulled exactly once and never read again. source.cancel() itself is
    // not directly observable here because reader.cancel() on the already
    // errored source rejects (swallowed by the wrapper) without invoking the
    // source cancel() in Bun.
    expect(upstreamPulls).toBe(1);
  });
});

describe("inbound body limits (F-13)", () => {
  test("oversized declared body -> 413 before buffering, journaled, no upstream call", async () => {
    const upstream = await startMockUpstream();
    const router = await newRouter({
      upstreamBase: upstream.baseUrl,
      accounts: [{ alias: "a1", key: "k" }],
      routes: { go: "a1" },
    });
    const port = router.server.port();
    const raw = await new Promise<string>((resolve) => {
      const sock = net.connect(port, "127.0.0.1", () => {
        // Declare a body past the cap but send none: the rejection must come
        // from headers alone, before a single body byte is buffered.
        sock.write(
          `POST /go/v1/chat/completions HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer ${LOCAL_KEY}\r\nContent-Type: application/json\r\nContent-Length: ${MAX_REQUEST_BODY_BYTES + 1}\r\nConnection: close\r\n\r\n`,
        );
      });
      let acc = "";
      sock.setEncoding("utf8");
      sock.on("data", (d) => { acc += d; });
      sock.on("close", () => resolve(acc));
      setTimeout(() => { sock.destroy(); resolve(acc); }, 5000);
    });
    expect(raw).toMatch(/^HTTP\/1\.1 413/);
    expect(raw).toMatch(/too large/);
    expect(upstream.requests.length).toBe(0);
    const rows = await waitForRows(router.paths.journalDb, 1);
    expect(rows[rows.length - 1]!.http_status).toBe(413);
    expect(rows[rows.length - 1]!.terminal_outcome).toBe("local_error");
    upstream.stop();
  }, { timeout: 15000 });

  test("trickling body past the idle window -> connection destroyed, no upstream call", async () => {
    setInboundBodyIdleTimeoutForTests(300);
    try {
      const upstream = await startMockUpstream();
      const router = await newRouter({
        upstreamBase: upstream.baseUrl,
        accounts: [{ alias: "a1", key: "k" }],
        routes: { go: "a1" },
      });
      const port = router.server.port();
      const started = Date.now();
      const closed = await new Promise<boolean>((resolve) => {
        const sock = net.connect(port, "127.0.0.1", () => {
          // Keep-alive (no Connection: close) so the held-body path is used:
          // declare 100 bytes, deliver 10, then stall forever.
          sock.write(
            `POST /go/v1/chat/completions HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer ${LOCAL_KEY}\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n0123456789`,
          );
        });
        sock.setEncoding("utf8");
        sock.on("data", () => {});
        sock.on("close", () => resolve(true));
        setTimeout(() => { sock.destroy(); resolve(false); }, 5000);
      });
      const elapsed = Date.now() - started;
      // Server-side idle kill (~300ms), not the 5s guard: the stall cannot
      // hold the connection indefinitely.
      expect(closed).toBe(true);
      expect(elapsed).toBeLessThan(5000);
      expect(upstream.requests.length).toBe(0);
      // Destroyed pre-dispatch: no handler ran, so no journal row exists.
      expect(readJournalRows(router.paths.journalDb).length).toBe(0);
      upstream.stop();
    } finally {
      resetInboundBodyIdleTimeoutForTests();
    }
  }, { timeout: 15000 });
});
