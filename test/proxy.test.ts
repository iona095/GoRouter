/**
 * Proxy/transport tests: local auth boundary, path routing, transparency,
 * streaming, cancellation, upstream error passthrough, route snapshot
 * coherence, and no-restart route switching.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMockUpstream, startTestRouter, authHeaders, readJournalRows, LOCAL_KEY, sseStream, type TestRouter } from "./harness.ts";
import { createSecretStore } from "../src/secret-store.ts";
import { redact } from "../src/util.ts";

const routers: TestRouter[] = [];
const scratchDirs: string[] = [];
afterEach(() => {
  for (const r of routers.splice(0)) r.stop();
  for (const d of scratchDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function newRouter(opts: Parameters<typeof startTestRouter>[0]) {
  const r = await startTestRouter(opts);
  routers.push(r);
  return r;
}

describe("local auth boundary", () => {
  test("missing local credential -> 401, no upstream call", async () => {
    const upstream = await startMockUpstream();
    const router = await newRouter({ upstreamBase: upstream.baseUrl, accounts: [{ alias: "a1", key: "key-a1" }], routes: { go: "a1" } });
    const res = await fetch(`${router.baseUrl}/go/v1/models`);
    expect(res.status).toBe(401);
    expect(upstream.requests.length).toBe(0);
    upstream.stop();
  });

  test("invalid local credential -> 401, no upstream call", async () => {
    const upstream = await startMockUpstream();
    const router = await newRouter({ upstreamBase: upstream.baseUrl, accounts: [{ alias: "a1", key: "key-a1" }], routes: { go: "a1" } });
    const res = await fetch(`${router.baseUrl}/go/v1/models`, { headers: { authorization: "Bearer wrong" } });
    expect(res.status).toBe(401);
    expect(upstream.requests.length).toBe(0);
    upstream.stop();
  });

  test("dispatch-path 401 leaves a journal row and carries a request id", async () => {
    const upstream = await startMockUpstream();
    const router = await newRouter({ upstreamBase: upstream.baseUrl, accounts: [{ alias: "a1", key: "key-a1" }], routes: { go: "a1" } });
    const res = await fetch(`${router.baseUrl}/go/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer wrong", "content-type": "application/json" },
      body: JSON.stringify({ model: "m", messages: [] }),
    });
    expect(res.status).toBe(401);
    expect(upstream.requests.length).toBe(0);
    const requestId = res.headers.get("x-gorouter-request-id");
    expect(requestId).toBeTruthy();
    const rows = readJournalRows(router.paths.journalDb);
    expect(rows.length).toBe(1);
    expect(rows[0]!.terminal_outcome).toBe("local_error");
    expect(rows[0]!.http_status).toBe(401);
    expect(rows[0]!.router_request_id).toBe(requestId);
    upstream.stop();
  });

  test("local credential never forwarded upstream; account key injected", async () => {
    const upstream = await startMockUpstream();
    const router = await newRouter({ upstreamBase: upstream.baseUrl, accounts: [{ alias: "a1", key: "key-a1" }], routes: { go: "a1" } });
    const res = await fetch(`${router.baseUrl}/go/v1/models`, { headers: authHeaders({ "x-opencode-session": "conv-h0-1" }) });
    expect(res.status).toBe(200);
    expect(upstream.requests.length).toBe(1);
    expect(upstream.requests[0]!.headers.get("authorization")).toBe("Bearer key-a1");
    expect(upstream.requests[0]!.headers.get("authorization")).not.toContain(LOCAL_KEY);
    upstream.stop();
  });
});

describe("local path routing", () => {
  test("unsupported local path -> 404 local", async () => {
    const upstream = await startMockUpstream();
    const router = await newRouter({ upstreamBase: upstream.baseUrl, accounts: [{ alias: "a1", key: "k" }], routes: { go: "a1" } });
    for (const p of ["/foo/v1/models", "/go/v2/models", "/go/v1", "/"]) {
      const res = await fetch(`${router.baseUrl}${p}`, { headers: authHeaders({ "x-opencode-session": "conv-h0-1" }) });
      expect(res.status, p).toBe(404);
    }
    expect(upstream.requests.length).toBe(0);
    upstream.stop();
  });

  test("malformed suffix -> 400 local", async () => {
    const upstream = await startMockUpstream();
    const router = await newRouter({ upstreamBase: upstream.baseUrl, accounts: [{ alias: "a1", key: "k" }], routes: { go: "a1" } });
    const res = await fetch(`${router.baseUrl}/go/v1//double`, { headers: authHeaders({ "x-opencode-session": "conv-h0-1" }) });
    expect(res.status).toBe(400);
    upstream.stop();
  });

  // CURRENT-007: unauthenticated /healthz is exactly the supervisor probe
  // signature — routes/aliases/journal never leave the box unauthenticated.
  test("healthz exposes only status and version (minimal surface)", async () => {
    const upstream = await startMockUpstream();
    const router = await newRouter({ upstreamBase: upstream.baseUrl, accounts: [{ alias: "a1", key: "sk-health-secret-1" }], routes: { go: "a1", zen: "a1" } });
    const res = await fetch(`${router.baseUrl}/healthz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("ok");
    expect(typeof body.version).toBe("string");
    expect(Object.keys(body).sort()).toEqual(["status", "version"]);
    expect(JSON.stringify(body)).not.toContain("sk-health-secret-1");
    expect(JSON.stringify(body)).not.toContain("a1");
    upstream.stop();
  });
});

describe("route resolution failures fail closed", () => {
  test("no route selected -> 503, no upstream", async () => {
    const upstream = await startMockUpstream();
    const router = await newRouter({ upstreamBase: upstream.baseUrl, accounts: [{ alias: "a1", key: "k" }] });
    const res = await fetch(`${router.baseUrl}/go/v1/chat/completions`, { method: "POST", headers: authHeaders({ "x-opencode-session": "conv-h0-1" }), body: "{}" });
    expect(res.status).toBe(503);
    expect(upstream.requests.length).toBe(0);
    upstream.stop();
  });

  test("dangling route -> 503, no upstream", async () => {
    const upstream = await startMockUpstream();
    const router = await newRouter({ upstreamBase: upstream.baseUrl, accounts: [{ alias: "a1", key: "k" }], routes: { go: "a1" } });
    // remove the account behind the route (simulating state corruption)
    router.state.mutate((s) => {
      s.accounts = [];
    });
    const res = await fetch(`${router.baseUrl}/go/v1/models`, { headers: authHeaders({ "x-opencode-session": "conv-h0-1" }) });
    expect(res.status).toBe(503);
    expect(upstream.requests.length).toBe(0);
    upstream.stop();
  });

  test("missing secret -> 500, no upstream", async () => {
    const upstream = await startMockUpstream();
    const router = await newRouter({ upstreamBase: upstream.baseUrl, accounts: [{ alias: "a1", key: "k" }], routes: { go: "a1" } });
    // CURRENT-001: refs are canonical newRef values; resolve the live one from state.
    router.secrets.delete(router.state.read().accounts[0]!.secretRef);
    const res = await fetch(`${router.baseUrl}/go/v1/models`, { headers: authHeaders({ "x-opencode-session": "conv-h0-1" }) });
    expect(res.status).toBe(500);
    expect(upstream.requests.length).toBe(0);
    upstream.stop();
  });
});

describe("protocol transparency", () => {
  test("method, path suffix, query, body bytes, content-type forwarded verbatim", async () => {
    const upstream = await startMockUpstream();
    const router = await newRouter({ upstreamBase: upstream.baseUrl, accounts: [{ alias: "a1", key: "k" }], routes: { go: "a1" } });
    const body = JSON.stringify({ model: "m1", messages: [{ role: "user", content: "hello" }] });
    const res = await fetch(`${router.baseUrl}/go/v1/chat/completions?stream=true&x=1`, {
      method: "POST",
      headers: authHeaders({ "x-opencode-session": "conv-h0-1", "content-type": "application/json", "x-custom": "abc" }),
      body,
    });
    expect(res.status).toBe(200);
    const req = upstream.requests[0]!;
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/chat/completions");
    expect(new URL(req.url).search).toBe("?stream=true&x=1");
    expect(req.bodyText).toBe(body);
    expect(req.headers.get("content-type")).toBe("application/json");
    expect(req.headers.get("x-custom")).toBe("abc");
    expect(req.headers.get("authorization")).toBe("Bearer k");
    expect(req.headers.get("host")).toBe(`127.0.0.1:${upstream.port}`);
    upstream.stop();
  });

  test("malformed percent-encoding in the query is transparent (no 400, forwarded)", async () => {
    const upstream = await startMockUpstream();
    const router = await newRouter({ upstreamBase: upstream.baseUrl, accounts: [{ alias: "a1", key: "k" }], routes: { go: "a1" } });
    const { rawGet } = await import("./harness.ts");
    const res = await rawGet(router.server.port(), "/go/v1/models?x=%zz", { "x-opencode-session": "conv-h0-1" });
    // path-only validation: a malformed percent-escape in the QUERY is not
    // rejected (narrowing #6) — the request dispatches normally
    expect(res.status).toBe(200);
    const req = upstream.requests[0]!;
    // GR-008: the raw query is byte-preserved (no parse-and-reserialize, so
    // a malformed escape is forwarded verbatim, never canonicalized).
    expect(new URL(req.url).search).toBe("?x=%zz");
    upstream.stop();
  });

  test("hop-by-hop and local headers stripped from upstream", async () => {
    const upstream = await startMockUpstream();
    const router = await newRouter({ upstreamBase: upstream.baseUrl, accounts: [{ alias: "a1", key: "k" }], routes: { go: "a1" } });
    await fetch(`${router.baseUrl}/go/v1/models`, {
      headers: authHeaders({ "x-opencode-session": "conv-h0-1", connection: "keep-alive", "x-gorouter-correlation-id": "corr-1" }),
    });
    const req = upstream.requests[0]!;
    expect(req.headers.get("x-gorouter-correlation-id")).toBeNull();
    upstream.stop();
  });

  test("upstream status/headers/body pass through; router request id header added locally", async () => {
    const upstream = await startMockUpstream((req) => {
      if (new URL(req.url).pathname === "/models") {
        return new Response(JSON.stringify({ data: [{ id: "m" }] }), {
          status: 200,
          headers: { "content-type": "application/json", "x-upstream-mark": "yes" },
        });
      }
      return new Response("nope", { status: 418, headers: { "x-teapot": "1" } });
    });
    const router = await newRouter({ upstreamBase: upstream.baseUrl, accounts: [{ alias: "a1", key: "k" }], routes: { go: "a1" } });
    const ok = await fetch(`${router.baseUrl}/go/v1/models`, { headers: authHeaders({ "x-opencode-session": "conv-h0-1" }) });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("x-upstream-mark")).toBe("yes");
    expect((await ok.json()) as { data: Array<{ id: string }> }).toEqual({ data: [{ id: "m" }] });
    const rid = ok.headers.get("x-gorouter-request-id");
    expect(rid).toBeTruthy();

    const teapot = await fetch(`${router.baseUrl}/go/v1/teapot`, { headers: authHeaders({ "x-opencode-session": "conv-h0-1" }) });
    expect(teapot.status).toBe(418);
    expect(teapot.headers.get("x-teapot")).toBe("1");
    expect(await teapot.text()).toBe("nope");
    upstream.stop();
  });

  test("upstream 401/429 propagated faithfully, no account switch, no retry", async () => {
    let calls = 0;
    const upstream = await startMockUpstream(() => {
      calls++;
      return Response.json({ error: { type: "AuthError", message: "Invalid API key." } }, { status: 401 });
    });
    const router = await newRouter({ upstreamBase: upstream.baseUrl, accounts: [{ alias: "a1", key: "k" }], routes: { go: "a1" } });
    const res = await fetch(`${router.baseUrl}/go/v1/chat/completions`, { method: "POST", headers: authHeaders({ "x-opencode-session": "conv-h0-1" }), body: "{}" });
    expect(res.status).toBe(401);
    expect(calls).toBe(1);
    const body = (await res.json()) as { error: { type: string } };
    expect(body.error.type).toBe("AuthError");
    upstream.stop();
  });

  test("upstream network failure -> 502 local, journal upstream_error", async () => {
    const upstream = await startMockUpstream();
    const port = upstream.port;
    upstream.stop();
    const router = await newRouter({ upstreamBase: `http://127.0.0.1:${port}`, accounts: [{ alias: "a1", key: "k" }], routes: { go: "a1" } });
    const res = await fetch(`${router.baseUrl}/go/v1/models`, { headers: authHeaders({ "x-opencode-session": "conv-h0-1" }) });
    expect(res.status).toBe(502);
    const rows = readJournalRows(router.paths.journalDb);
    expect(rows.length).toBe(1);
    expect(rows[0]!.terminal_outcome).toBe("upstream_error");
    expect(rows[0]!.http_status).toBe(502);
  });

  test("redirects are not followed (3xx passed through)", async () => {
    const upstream = await startMockUpstream(() => new Response(null, { status: 302, headers: { location: "https://evil.example.com/steal" } }));
    const router = await newRouter({ upstreamBase: upstream.baseUrl, accounts: [{ alias: "a1", key: "k" }], routes: { go: "a1" } });
    const res = await fetch(`${router.baseUrl}/go/v1/redirect-me`, { headers: authHeaders({ "x-opencode-session": "conv-h0-1" }), redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://evil.example.com/steal");
    upstream.stop();
  });

  test("hostile path suffixes cannot select an arbitrary upstream host", async () => {
    const upstream = await startMockUpstream(() => Response.json({ ok: true }));
    const router = await newRouter({ upstreamBase: upstream.baseUrl, accounts: [{ alias: "a1", key: "k" }], routes: { go: "a1" } });
    for (const suffix of ["/..%2f..%2f..", "/%2f%2fevil.example.com%2fx", "/..%5cevil.example.com", "/x/../../../../etc/passwd", "/%2e%2e/%2e%2e/"]) {
      const res = await fetch(`${router.baseUrl}/go/v1${suffix}`, { headers: authHeaders({ "x-opencode-session": "conv-h0-1" }) });
      // locally rejected (404/400) or proxied (200) are both acceptable;
      // the invariant is that nothing can leave the fixed authority
      expect([200, 400, 404].includes(res.status), `${suffix} -> ${res.status}`).toBe(true);
    }
    // F-01 lane-namespace enforcement: every hostile traversal suffix is
    // rejected before dispatch, so nothing reaches the upstream at all (the
    // pinned-host proxying invariant for in-namespace paths is covered by
    // path-namespace.test.ts's control cases).
    expect(upstream.requests.length).toBe(0);
    upstream.stop();
  });
});

describe("streaming", () => {
  test("progressive chunks observable before stream completion; bytes unchanged", async () => {
    const chunks = ["data: {", '"chunk1"}\n\n', "data: {", '"chunk2"}\n\n', "data: [DONE]\n\n"];
    const upstream = await startMockUpstream(() => sseStream(chunks, 60));
    const router = await newRouter({ upstreamBase: upstream.baseUrl, accounts: [{ alias: "a1", key: "k" }], routes: { go: "a1" } });
    const res = await fetch(`${router.baseUrl}/go/v1/chat/completions`, {
      method: "POST",
      headers: authHeaders({ "x-opencode-session": "conv-h0-1", "content-type": "application/json" }),
      body: "{}",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const seen: string[] = [];
    const t0 = Date.now();
    let firstChunkAt = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (firstChunkAt === 0) firstChunkAt = Date.now() - t0;
      seen.push(decoder.decode(value));
    }
    // progressive: first chunk observed well before the stream ends
    expect(firstChunkAt).toBeLessThan(200);
    expect(seen.join("")).toBe(chunks.join(""));
    upstream.stop();
  });

  test("normal POST completes with journal ok (message completion is not a client abort)", async () => {
    const upstream = await startMockUpstream();
    const router = await newRouter({ upstreamBase: upstream.baseUrl, accounts: [{ alias: "a1", key: "k" }], routes: { go: "a1" } });
    const res = await fetch(`${router.baseUrl}/go/v1/chat/completions`, {
      method: "POST",
      headers: authHeaders({ "x-opencode-session": "conv-h0-1", "content-type": "application/json" }),
      body: "{}",
    });
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 500));
    const rows = readJournalRows(router.paths.journalDb);
    expect(rows.length).toBe(1);
    expect(rows[0]!.terminal_outcome).toBe("ok");
    expect(rows[0]!.terminal_outcome).not.toBe("client_abort");
    expect(rows[0]!.http_status).toBe(200);
    upstream.stop();
  });

  test("GET with a declared request body is rejected 400 (not forwarded with a dangling length)", async () => {
    const upstream = await startMockUpstream();
    const router = await newRouter({ upstreamBase: upstream.baseUrl, accounts: [{ alias: "a1", key: "k" }], routes: { go: "a1" } });
    const { connect } = await import("node:net");
    const port = router.server.port();
    const sock = connect(port, "127.0.0.1", () => {
      sock.write(
        `GET /go/v1/models HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer ${LOCAL_KEY}\r\nContent-Length: 3\r\n\r\nabc`,
      );
    });
    sock.setEncoding("utf8");
    let buf = "";
    sock.on("data", (d) => { buf += d; });
    await new Promise((r) => setTimeout(r, 800));
    sock.destroy();
    // The web Request model forbids GET/HEAD bodies; a declared length with a
    // body is rejected pre-dispatch rather than forwarded (forwarding the
    // length without the bytes would hang the upstream).
    expect(buf.startsWith("HTTP/1.1 400")).toBe(true);
    const rows = readJournalRows(router.paths.journalDb);
    expect(rows.length).toBe(1);
    expect(rows[0]!.terminal_outcome).toBe("local_error");
    expect(rows[0]!.http_status).toBe(400);
    expect(upstream.requests.length).toBe(0);
    upstream.stop();
  });

  test("HEAD with a declared request body is rejected 400 (not forwarded)", async () => {
    const upstream = await startMockUpstream();
    const router = await newRouter({ upstreamBase: upstream.baseUrl, accounts: [{ alias: "a1", key: "k" }], routes: { go: "a1" } });
    const { connect } = await import("node:net");
    const port = router.server.port();
    const sock = connect(port, "127.0.0.1", () => {
      sock.write(
        `HEAD /go/v1/models HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer ${LOCAL_KEY}\r\nContent-Length: 3\r\n\r\nabc`,
      );
    });
    sock.setEncoding("utf8");
    let buf = "";
    sock.on("data", (d) => { buf += d; });
    await new Promise((r) => setTimeout(r, 800));
    sock.destroy();
    // The web Request model forbids GET/HEAD bodies; the HEAD variant shares
    // the GET/HEAD rejection branch (claim 3) and must journal local_error/400.
    expect(buf.startsWith("HTTP/1.1 400")).toBe(true);
    const rows = readJournalRows(router.paths.journalDb);
    expect(rows.length).toBe(1);
    expect(rows[0]!.terminal_outcome).toBe("local_error");
    expect(rows[0]!.http_status).toBe(400);
    expect(rows[0]!.lane).toBe("go");
    expect(upstream.requests.length).toBe(0);
    upstream.stop();
  });

  test("client disconnect mid-stream -> journal client_abort, upstream cancellation observed", async () => {
    // Note: fetch() body reader.cancel() is buffered by Bun's connection pool;
    // a real client abort is a TCP-level disconnect, reproduced here with a
    // raw socket that is destroyed mid-stream.
    let upstreamAborted = false;
    const upstream = await startMockUpstream((req) => {
      const signal = req.signal;
      signal?.addEventListener("abort", () => { upstreamAborted = true; });
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("data: start\n\n"));
          const timer = setInterval(() => {
            try {
              controller.enqueue(new TextEncoder().encode("data: tick\n\n"));
            } catch { /* closed */ }
          }, 25);
          signal?.addEventListener("abort", () => clearInterval(timer));
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    });
    const router = await newRouter({ upstreamBase: upstream.baseUrl, accounts: [{ alias: "a1", key: "k" }], routes: { go: "a1" } });
    const { connect } = await import("node:net");
    const sock = connect(router.server.port(), "127.0.0.1");
    sock.write(`GET /go/v1/chat/completions HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${LOCAL_KEY}\r\nx-opencode-session: conv-h0-1\r\n\r\n`);
    let received = 0;
    await new Promise<void>((resolve) => {
      sock.on("data", (d) => {
        received += d.length;
        if (received > 64) {
          sock.destroy();
          resolve();
        }
      });
    });
    await new Promise((r) => setTimeout(r, 500));
    const rows = readJournalRows(router.paths.journalDb);
    expect(rows.length).toBe(1);
    expect(rows[0]!.terminal_outcome).toBe("client_abort");
    expect(upstreamAborted).toBe(true);
    upstream.stop();
  });
});

describe("endpoint-family authentication (current OpenCode gateway surfaces)", () => {
  test("anthropic family: local credential via x-api-key; account key injected as x-api-key", async () => {
    const upstream = await startMockUpstream();
    const router = await newRouter({ upstreamBase: upstream.baseUrl, accounts: [{ alias: "a1", key: "key-a1" }], routes: { go: "a1" } });
    const body = JSON.stringify({ model: "qwen3.7-max", messages: [{ role: "user", content: "hi" }], max_tokens: 8 });
    const res = await fetch(`${router.baseUrl}/go/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": LOCAL_KEY, "content-type": "application/json", "anthropic-version": "2023-06-01", "x-opencode-session": "conv-h0-1" },
      body,
    });
    expect(res.status).toBe(200);
    const req = upstream.requests[0]!;
    expect(req.path).toBe("/messages");
    expect(req.bodyText).toBe(body);
    expect(req.headers.get("x-api-key")).toBe("key-a1");
    expect(req.headers.get("authorization")).toBeNull();
    expect(req.headers.get("anthropic-version")).toBe("2023-06-01");
    upstream.stop();
  });

  test("google family: local credential via x-goog-api-key; account key injected as x-goog-api-key", async () => {
    const upstream = await startMockUpstream();
    const router = await newRouter({ upstreamBase: upstream.baseUrl, accounts: [{ alias: "a1", key: "key-a1" }], routes: { zen: "a1" } });
    const res = await fetch(`${router.baseUrl}/zen/v1/models/gemini-3.6-flash:generateContent`, {
      method: "POST",
      headers: { "x-goog-api-key": LOCAL_KEY, "content-type": "application/json", "x-opencode-session": "conv-h0-1" },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }] }),
    });
    expect(res.status).toBe(200);
    const req = upstream.requests[0]!;
    expect(req.path).toBe("/models/gemini-3.6-flash:generateContent");
    expect(req.headers.get("x-goog-api-key")).toBe("key-a1");
    expect(req.headers.get("authorization")).toBeNull();
    expect(req.headers.get("x-api-key")).toBeNull();
    upstream.stop();
  });

  test("wrong local credential in any family header -> 401, no upstream", async () => {
    const upstream = await startMockUpstream();
    const router = await newRouter({ upstreamBase: upstream.baseUrl, accounts: [{ alias: "a1", key: "k" }], routes: { go: "a1" } });
    const cases: Array<Record<string, string>> = [
      { "x-api-key": "wrong" },
      { "x-goog-api-key": "wrong" },
      { authorization: "Bearer wrong" },
      {},
    ];
    for (const headers of cases) {
      const res = await fetch(`${router.baseUrl}/go/v1/messages`, { method: "POST", headers, body: "{}" });
      expect(res.status).toBe(401);
    }
    expect(upstream.requests.length).toBe(0);
    upstream.stop();
  });

  test("local credential never reaches upstream in any auth header", async () => {
    const upstream = await startMockUpstream();
    const router = await newRouter({ upstreamBase: upstream.baseUrl, accounts: [{ alias: "a1", key: "key-a1" }], routes: { go: "a1" } });
    await fetch(`${router.baseUrl}/go/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": LOCAL_KEY, authorization: `Bearer ${LOCAL_KEY}`, "x-goog-api-key": LOCAL_KEY, "x-opencode-session": "conv-h0-1" },
      body: "{}",
    });
    const req = upstream.requests[0]!;
    expect(req.headers.get("authorization")).toBeNull();
    expect(req.headers.get("x-api-key")).toBe("key-a1"); // family injection
    expect(req.headers.get("x-goog-api-key")).toBeNull(); // other family headers stripped
    upstream.stop();
  });
});

describe("credential containment (F-09/F-10/F-11)", () => {
  // Canaries shaped to match every SECRET_SCAN family (positive controls
  // below prove the scanners see them, so absence assertions are non-vacuous).
  const LOCAL_CANARY = `Bearer ${LOCAL_KEY}`;
  const ACCOUNT_CANARY = "sk-live-canary-0123456789abcdef";

  test("F-10: seeded canaries reach no sink (logs, journal, error bodies)", async () => {
    // Positive control: the raw canaries ARE visible pre-redaction…
    expect(LOCAL_CANARY).toContain(LOCAL_KEY);
    expect(ACCOUNT_CANARY).toContain("sk-live-canary");
    // …and the production redactor removes them.
    expect(redact(`hdr ${LOCAL_CANARY} key ${ACCOUNT_CANARY}`)).not.toContain(LOCAL_KEY);
    expect(redact(`hdr ${LOCAL_CANARY} key ${ACCOUNT_CANARY}`)).not.toContain(ACCOUNT_CANARY);

    const lines: string[] = [];
    const origLog = console.log;
    const origErr = console.error;
    console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
    console.error = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
    try {
      const upstream = await startMockUpstream();
      const router = await newRouter({ upstreamBase: upstream.baseUrl, accounts: [{ alias: "a1", key: ACCOUNT_CANARY }], routes: { go: "a1" } });
      // Canary in every inbound carrier at once. The contaminated session
      // carrier is refused locally (H0 5.5): nothing reaches any sink.
      const res = await fetch(`${router.baseUrl}/go/v1/models?api_key=${LOCAL_KEY}&x=1`, {
        headers: authHeaders({ "x-custom-echo": ACCOUNT_CANARY, "x-opencode-session": `conv-${LOCAL_KEY}` }),
      });
      expect(res.status).toBe(400);
      expect(upstream.requests.length).toBe(0);
      // Error surfaces must not echo the carriers either.
      const bad = await fetch(`${router.baseUrl}/go/v1//${LOCAL_KEY}?k=${ACCOUNT_CANARY}`, { headers: authHeaders({ "x-opencode-session": "conv-h0-1" }) });
      expect(bad.status).toBe(400);
      const badBody = await bad.text();
      expect(badBody).not.toContain(LOCAL_KEY);
      expect(badBody).not.toContain(ACCOUNT_CANARY);
      const rows = readJournalRows(router.paths.journalDb);
      const serialized = JSON.stringify(rows);
      expect(serialized).not.toContain(LOCAL_KEY);
      expect(serialized).not.toContain(ACCOUNT_CANARY);
      upstream.stop();
    } finally {
      console.log = origLog;
      console.error = origErr;
    }
    const dumped = lines.join("\n");
    expect(dumped).not.toContain(LOCAL_KEY);
    expect(dumped).not.toContain(ACCOUNT_CANARY);
  });

  test("F-11: local credential in the query string never reaches upstream", async () => {
    const upstream = await startMockUpstream();
    const router = await newRouter({ upstreamBase: upstream.baseUrl, accounts: [{ alias: "a1", key: "key-a1" }], routes: { go: "a1" } });
    // Exact value, substring value, and encoded value in three positions.
    for (const q of [`api_key=${LOCAL_KEY}`, `x=1&tok=Bearer-${LOCAL_KEY}-tail&y=2`, `q=${encodeURIComponent(LOCAL_KEY)}`]) {
      const res = await fetch(`${router.baseUrl}/go/v1/models?${q}`, { headers: authHeaders({ "x-opencode-session": "conv-h0-1" }) });
      expect(res.status, q).toBe(200);
    }
    expect(upstream.requests.length).toBe(3);
    for (const req of upstream.requests) {
      expect(req.url).not.toContain(LOCAL_KEY);
      expect(new URL(req.url).search).not.toContain(LOCAL_KEY);
    }
    // Empty-query control still proxies (the framing fast path is unaffected).
    const plain = await fetch(`${router.baseUrl}/go/v1/models`, { headers: authHeaders({ "x-opencode-session": "conv-h0-1" }) });
    expect(plain.status).toBe(200);
    upstream.stop();
  });

  // Windows-DPAPI-backed by construction (createSecretStore spawns powershell.exe):
  // skipped outside Windows; the documented Linux-contained subset excludes it.
  const testF09 = process.platform === "win32" ? test : test.skip;
  testF09("F-09: cached-path injection uses the live secret across rotation (real store)", async () => {
    const upstream = await startMockUpstream();
    const secretsDir = mkdtempSync(join(tmpdir(), "gorouter-f09-"));
    scratchDirs.push(secretsDir);
    const secrets = createSecretStore(secretsDir);
    const router = await newRouter({ upstreamBase: upstream.baseUrl, accounts: [{ alias: "a1", key: "key-one" }], routes: { go: "a1" }, secrets });
    const get = () => fetch(`${router.baseUrl}/go/v1/models`, { headers: authHeaders({ "x-opencode-session": "conv-h0-1" }) });
    // Cold (DPAPI decrypt) then warm (stat-cache hit): same live secret.
    expect((await get()).status).toBe(200);
    expect((await get()).status).toBe(200);
    expect(upstream.requests.length).toBe(2);
    for (const req of upstream.requests) {
      expect(req.headers.get("authorization")).toBe("Bearer key-one");
    }
    // Rotate out-of-band via the same atomic-rename writer product code uses.
    const ref = router.state.read().accounts.find((a) => a.alias === "a1")!.secretRef;
    secrets.put(ref, "key-two");
    expect((await get()).status).toBe(200);
    expect(upstream.requests[2]!.headers.get("authorization")).toBe("Bearer key-two");
    upstream.stop();
  }, 120000);
});

describe("bodyless responses and journal terminalization", () => {
  test("204 bodyless response terminalizes the journal and exposes the request id", async () => {
    const upstream = await startMockUpstream(() => new Response(null, { status: 204 }));
    const router = await newRouter({ upstreamBase: upstream.baseUrl, accounts: [{ alias: "a1", key: "k" }], routes: { go: "a1" } });
    const res = await fetch(`${router.baseUrl}/go/v1/noop`, { headers: authHeaders({ "x-opencode-session": "conv-h0-1" }) });
    expect(res.status).toBe(204);
    expect(res.headers.get("x-gorouter-request-id")).toBeTruthy();
    const rows = readJournalRows(router.paths.journalDb);
    expect(rows.length).toBe(1);
    expect(rows[0]!.terminal_outcome).toBe("ok");
    expect(rows[0]!.http_status).toBe(204);
    expect(rows[0]!.completed_at_utc).not.toBeNull();
    expect(Number(rows[0]!.duration_ms)).toBeGreaterThanOrEqual(0);
    upstream.stop();
  });

  test("302 bodyless redirect terminalizes the journal (no permanent in_flight)", async () => {
    const upstream = await startMockUpstream(() => new Response(null, { status: 302, headers: { location: "https://elsewhere.example.com" } }));
    const router = await newRouter({ upstreamBase: upstream.baseUrl, accounts: [{ alias: "a1", key: "k" }], routes: { go: "a1" } });
    const res = await fetch(`${router.baseUrl}/go/v1/redirect-me`, { headers: authHeaders({ "x-opencode-session": "conv-h0-1" }), redirect: "manual" });
    expect(res.status).toBe(302);
    const rows = readJournalRows(router.paths.journalDb);
    expect(rows.length).toBe(1);
    expect(rows[0]!.terminal_outcome).toBe("ok"); // 3xx < 400: faithfully proxied, terminal
    expect(rows[0]!.http_status).toBe(302);
    expect(rows[0]!.completed_at_utc).not.toBeNull();
    upstream.stop();
  });

  test("502 local error carries x-gorouter-request-id on the response", async () => {
    const upstream = await startMockUpstream();
    const port = upstream.port;
    upstream.stop();
    const router = await newRouter({ upstreamBase: `http://127.0.0.1:${port}`, accounts: [{ alias: "a1", key: "k" }], routes: { go: "a1" } });
    const res = await fetch(`${router.baseUrl}/go/v1/models`, { headers: authHeaders({ "x-opencode-session": "conv-h0-1" }) });
    expect(res.status).toBe(502);
    expect(res.headers.get("x-gorouter-request-id")).toBeTruthy();
    const rows = readJournalRows(router.paths.journalDb);
    expect(rows[0]!.terminal_outcome).toBe("upstream_error");
    expect(rows[0]!.http_status).toBe(502);
    upstream.stop();
  });

  test("pre-begin local failures (no-route) get a journal row and request id", async () => {
    const upstream = await startMockUpstream();
    const router = await newRouter({ upstreamBase: upstream.baseUrl, accounts: [{ alias: "a1", key: "k" }] }); // no routes
    const res = await fetch(`${router.baseUrl}/go/v1/chat/completions`, { method: "POST", headers: authHeaders({ "x-opencode-session": "conv-h0-1" }), body: "{}" });
    expect(res.status).toBe(503);
    const rid = res.headers.get("x-gorouter-request-id");
    expect(rid).toBeTruthy();
    const rows = readJournalRows(router.paths.journalDb);
    expect(rows.length).toBe(1);
    expect(rows[0]!.router_request_id).toBe(rid);
    expect(rows[0]!.terminal_outcome).toBe("local_error");
    expect(rows[0]!.http_status).toBe(503);
    expect(rows[0]!.completed_at_utc).not.toBeNull();
    expect(upstream.requests.length).toBe(0);
    upstream.stop();
  });

  test("dangling-route and missing-secret failures also journal with request id", async () => {
    const upstream = await startMockUpstream();
    const router = await newRouter({ upstreamBase: upstream.baseUrl, accounts: [{ alias: "a1", key: "k" }], routes: { go: "a1" } });
    // dangling: remove the account behind the route
    const originalId = router.state.read().accounts[0]!.id;
    // CURRENT-001: canonical ref captured before the dangling wipe.
    const originalRef = router.state.read().accounts[0]!.secretRef;
    router.state.mutate((s) => { s.accounts = []; });
    const dangling = await fetch(`${router.baseUrl}/go/v1/models`, { headers: authHeaders({ "x-opencode-session": "conv-h0-1" }) });
    expect(dangling.status).toBe(503);
    expect(dangling.headers.get("x-gorouter-request-id")).toBeTruthy();
    // restore the account under its original id, then delete its secret -> missing-secret 500
    router.state.mutate((s) => {
      router.secrets.put(originalRef, "k");
      s.accounts = [{ id: originalId, alias: "a1", secretRef: originalRef, createdAtUtc: new Date().toISOString(), updatedAtUtc: new Date().toISOString(), version: 1 }];
    });
    router.secrets.delete(originalRef);
    const missing = await fetch(`${router.baseUrl}/go/v1/models`, { headers: authHeaders({ "x-opencode-session": "conv-h0-1" }) });
    expect(missing.status).toBe(500);
    expect(missing.headers.get("x-gorouter-request-id")).toBeTruthy();
    const rows = readJournalRows(router.paths.journalDb);
    expect(rows.length).toBe(2);
    expect(rows.map((r) => r.terminal_outcome)).toEqual(["local_error", "local_error"]);
    expect(upstream.requests.length).toBe(0);
    upstream.stop();
  });
});

describe("route switching and snapshot coherence", () => {
  test("route change applies to next request without restart; other lane untouched", async () => {
    const upstream = await startMockUpstream();
    const router = await newRouter({
      upstreamBase: upstream.baseUrl,
      accounts: [
        { alias: "go1", key: "key-go1" },
        { alias: "go2", key: "key-go2" },
        { alias: "zen1", key: "key-zen1" },
      ],
      routes: { go: "go1", zen: "zen1" },
    });
    const go = async (path: string) => {
      await fetch(`${router.baseUrl}${path}`, { headers: authHeaders({ "x-opencode-session": "conv-h0-1" }) });
    };
    await go("/go/v1/models");
    expect(upstream.requests[0]!.headers.get("authorization")).toBe("Bearer key-go1");

    // switch GO only
    router.state.mutate((s) => {
      const a = s.accounts.find((x) => x.alias === "go2")!;
      s.routes.go.accountId = a.id;
    });
    await go("/go/v1/models");
    expect(upstream.requests[1]!.headers.get("authorization")).toBe("Bearer key-go2");
    // zen unchanged
    await go("/zen/v1/models");
    expect(upstream.requests[2]!.headers.get("authorization")).toBe("Bearer key-zen1");
    upstream.stop();
  });

  test("in-flight request keeps its original route snapshot across a route switch", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const upstream = await startMockUpstream(async () => {
      await gate;
      return Response.json({ ok: true });
    });
    const router = await newRouter({
      upstreamBase: upstream.baseUrl,
      accounts: [
        { alias: "a1", key: "key-a1" },
        { alias: "a2", key: "key-a2" },
      ],
      routes: { go: "a1" },
    });
    const inflight = fetch(`${router.baseUrl}/go/v1/held`, { headers: authHeaders({ "x-opencode-session": "conv-h0-1" }) });
    await new Promise((r) => setTimeout(r, 150)); // let the request reach upstream
    expect(upstream.requests.length).toBe(1);
    expect(upstream.requests[0]!.headers.get("authorization")).toBe("Bearer key-a1");
    // switch route while the request is in flight
    router.state.mutate((s) => {
      const a = s.accounts.find((x) => x.alias === "a2")!;
      s.routes.go.accountId = a.id;
    });
    release();
    const res = await inflight;
    expect(res.status).toBe(200);
    const rows = readJournalRows(router.paths.journalDb);
    expect(rows.length).toBe(1);
    // the journal must record the snapshot actually used: a1's id + alias
    const a1 = router.state.read().accounts.find((x) => x.alias === "a1")!;
    expect(rows[0]!.selected_account_id).toBe(a1.id);
    expect(rows[0]!.selected_account_alias_snapshot).toBe("a1");
    upstream.stop();
  });

  test("concurrent go+zen traffic uses each lane's own account", async () => {
    const upstream = await startMockUpstream();
    const router = await newRouter({
      upstreamBase: upstream.baseUrl,
      accounts: [
        { alias: "ga", key: "key-ga" },
        { alias: "za", key: "key-za" },
      ],
      routes: { go: "ga", zen: "za" },
    });
    await Promise.all([
      fetch(`${router.baseUrl}/go/v1/models`, { headers: authHeaders({ "x-opencode-session": "conv-h0-1" }) }),
      fetch(`${router.baseUrl}/zen/v1/models`, { headers: authHeaders({ "x-opencode-session": "conv-h0-1" }) }),
      fetch(`${router.baseUrl}/go/v1/models`, { headers: authHeaders({ "x-opencode-session": "conv-h0-1" }) }),
      fetch(`${router.baseUrl}/zen/v1/models`, { headers: authHeaders({ "x-opencode-session": "conv-h0-1" }) }),
    ]);
    expect(upstream.requests.length).toBe(4);
    const auths = upstream.requests.map((r) => r.headers.get("authorization"));
    expect(auths.filter((a) => a === "Bearer key-ga").length).toBe(2);
    expect(auths.filter((a) => a === "Bearer key-za").length).toBe(2);
    upstream.stop();
  });
});

describe("opencode session header", () => {
  test("inbound x-opencode-session forwarded untouched", async () => {
    const upstream = await startMockUpstream();
    const router = await newRouter({ upstreamBase: upstream.baseUrl, accounts: [{ alias: "a1", key: "key-a1" }], routes: { go: "a1" } });
    const res = await fetch(`${router.baseUrl}/go/v1/models`, { headers: authHeaders({ "x-opencode-session": "conv-abc-123" }) });
    expect(res.status).toBe(200);
    expect(upstream.requests.length).toBe(1);
    expect(upstream.requests[0]!.headers.get("x-opencode-session")).toBe("conv-abc-123");
    upstream.stop();
  });

  test("missing header is refused locally with zero upstream dispatch (H0 5.4)", async () => {
    const upstream = await startMockUpstream();
    const router = await newRouter({ upstreamBase: upstream.baseUrl, accounts: [{ alias: "a1", key: "key-a1" }], routes: { go: "a1" } });
    const res = await fetch(`${router.baseUrl}/go/v1/models`, { headers: authHeaders() });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { type: string; message: string } };
    expect(body.error.type).toBe("GoRouterSessionError");
    expect(upstream.requests.length).toBe(0);
    expect(res.headers.get("x-gorouter-request-id")).toBeTruthy();
    upstream.stop();
  });

  test("correlation id is never mapped to session; missing explicit is refused (H0 5.3)", async () => {
    const upstream = await startMockUpstream();
    const router = await newRouter({ upstreamBase: upstream.baseUrl, accounts: [{ alias: "a1", key: "key-a1" }], routes: { go: "a1" } });
    const res = await fetch(`${router.baseUrl}/go/v1/models`, { headers: authHeaders({ "x-gorouter-correlation-id": "myconv-1" }) });
    expect(res.status).toBe(400);
    expect(upstream.requests.length).toBe(0);
    upstream.stop();
  });

  test("oversized inbound session refused locally, zero dispatch (H0 5.2)", async () => {
    const upstream = await startMockUpstream();
    const router = await newRouter({ upstreamBase: upstream.baseUrl, accounts: [{ alias: "a1", key: "key-a1" }], routes: { go: "a1" } });
    const bad = "x".repeat(300);
    const res = await fetch(`${router.baseUrl}/go/v1/models`, { headers: authHeaders({ "x-opencode-session": bad }) });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { type: string } };
    expect(body.error.type).toBe("GoRouterSessionError");
    expect(upstream.requests.length).toBe(0);
    upstream.stop();
  });

  test("credential-bearing inbound session refused locally, never forwarded or echoed (H0 5.5)", async () => {
    const upstream = await startMockUpstream();
    const router = await newRouter({ upstreamBase: upstream.baseUrl, accounts: [{ alias: "a1", key: "key-a1" }], routes: { go: "a1" } });
    const bad = "conv-" + LOCAL_KEY;
    const res = await fetch(`${router.baseUrl}/go/v1/models`, { headers: authHeaders({ "x-opencode-session": bad }) });
    expect(res.status).toBe(400);
    expect(upstream.requests.length).toBe(0);
    const text = await res.text();
    expect(text).not.toContain(LOCAL_KEY);
    expect(text).not.toContain(bad);
    upstream.stop();
  });

  test("multi-value / off-grammar inbound session refused, never forwards garbage (H0 5.2)", async () => {
    const upstream = await startMockUpstream();
    const router = await newRouter({ upstreamBase: upstream.baseUrl, accounts: [{ alias: "a1", key: "key-a1" }], routes: { go: "a1" } });
    // ByteString-safe offenders go through fetch (duplicate headers arrive
    // comma-joined; spaces/semicolons are outside the shared id grammar).
    for (const bad of ["a, b", "has space", "semi;colon"]) {
      const res = await fetch(`${router.baseUrl}/go/v1/models`, { headers: authHeaders({ "x-opencode-session": bad }) });
      expect(res.status).toBe(400);
    }
    // Non-ByteString values (control chars, emoji) cannot be sent via fetch
    // at all — raw socket. Framing/parser layer may close without dispatch;
    // the H0 property is: nothing off-grammar reaches upstream.
    const { connect } = await import("node:net");
    const port = router.server.port();
    for (const raw of ["tab\there", "emoji-\u{1F600}"]) {
      await new Promise<void>((resolve) => {
        const sock = connect(port, "127.0.0.1", () => {
          sock.write(
            `GET /go/v1/models HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer ${LOCAL_KEY}\r\nx-opencode-session: ${raw}\r\nConnection: close\r\n\r\n`,
            "latin1",
          );
        });
        sock.on("data", () => {});
        sock.on("close", () => resolve());
        sock.on("error", () => resolve());
        setTimeout(() => { sock.destroy(); resolve(); }, 5000);
      });
    }
    expect(upstream.requests.length).toBe(0);
    upstream.stop();
  });

  test("same explicit conversation is byte-identical upstream across turns", async () => {
    const upstream = await startMockUpstream();
    const router = await newRouter({ upstreamBase: upstream.baseUrl, accounts: [{ alias: "a1", key: "key-a1" }], routes: { go: "a1" } });
    for (let i = 0; i < 3; i++) {
      const res = await fetch(`${router.baseUrl}/go/v1/models`, { headers: authHeaders({ "x-opencode-session": "stable-conv-9" }) });
      expect(res.status).toBe(200);
    }
    const seen = upstream.requests.map((r) => r.headers.get("x-opencode-session"));
    expect(seen).toEqual(["stable-conv-9", "stable-conv-9", "stable-conv-9"]);
    upstream.stop();
  });

  test("distinct conversations stay distinct upstream", async () => {
    const upstream = await startMockUpstream();
    const router = await newRouter({ upstreamBase: upstream.baseUrl, accounts: [{ alias: "a1", key: "key-a1" }], routes: { go: "a1" } });
    for (const conv of ["conv-alpha-1", "conv-beta-2"]) {
      const res = await fetch(`${router.baseUrl}/go/v1/models`, { headers: authHeaders({ "x-opencode-session": conv }) });
      expect(res.status).toBe(200);
    }
    const seen = upstream.requests.map((r) => r.headers.get("x-opencode-session"));
    expect(seen).toEqual(["conv-alpha-1", "conv-beta-2"]);
    upstream.stop();
  });

  test("explicit session wins over coexisting correlation id (H0 precedence)", async () => {
    const upstream = await startMockUpstream();
    const router = await newRouter({ upstreamBase: upstream.baseUrl, accounts: [{ alias: "a1", key: "key-a1" }], routes: { go: "a1" } });
    const res = await fetch(`${router.baseUrl}/go/v1/models`, {
      headers: authHeaders({ "x-opencode-session": "conv-explicit-7", "x-gorouter-correlation-id": "other-corr" }),
    });
    expect(res.status).toBe(200);
    expect(upstream.requests[0]!.headers.get("x-opencode-session")).toBe("conv-explicit-7");
    upstream.stop();
  });

  test("short credential strips on exact match only (F3 floor fallback)", async () => {
    const upstream = await startMockUpstream();
    const router = await newRouter({ upstreamBase: upstream.baseUrl, localKey: "short", accounts: [{ alias: "a1", key: "key-a1" }], routes: { go: "a1" } });
    const auth = (extra?: Record<string, string>) => new Headers({ authorization: "Bearer short", ...extra });
    // Exact match on the session id: refused locally, never forwarded (H0 5.5).
    const r1 = await fetch(`${router.baseUrl}/go/v1/models`, { headers: auth({ "x-opencode-session": "short" }) });
    expect(r1.status).toBe(400);
    expect(upstream.requests.length).toBe(0);
    // Exact match on a generic forwarded header: stripped.
    const r2 = await fetch(`${router.baseUrl}/go/v1/models`, { headers: auth({ "x-opencode-session": "conv-h0-1", "x-custom-echo": "short" }) });
    expect(r2.status).toBe(200);
    expect(upstream.requests[0]!.headers.get("x-custom-echo")).toBeNull();
    // Substring below the floor still forwards (documented tradeoff: a
    // short secret would otherwise rotate innocent ids per request).
    const r3 = await fetch(`${router.baseUrl}/go/v1/models`, { headers: auth({ "x-opencode-session": "conv-short-suffix" }) });
    expect(r3.status).toBe(200);
    expect(upstream.requests[1]!.headers.get("x-opencode-session")).toBe("conv-short-suffix");
    upstream.stop();
  });

  test("valid explicit session wins with contaminated correlation present (correlation never mapped)", async () => {
    const upstream = await startMockUpstream();
    const router = await newRouter({ upstreamBase: upstream.baseUrl, accounts: [{ alias: "a1", key: "key-a1" }], routes: { go: "a1" } });
    const res = await fetch(`${router.baseUrl}/go/v1/models`, {
      headers: authHeaders({ "x-opencode-session": "conv-clean-3", "x-gorouter-correlation-id": LOCAL_KEY }),
    });
    expect(res.status).toBe(200);
    expect(upstream.requests.length).toBe(1);
    expect(upstream.requests[0]!.headers.get("x-opencode-session")).toBe("conv-clean-3");
    upstream.stop();
  });

  test("missing explicit with contaminated correlation is refused as missing (H0 5.4)", async () => {
    const upstream = await startMockUpstream();
    const router = await newRouter({ upstreamBase: upstream.baseUrl, accounts: [{ alias: "a1", key: "key-a1" }], routes: { go: "a1" } });
    const res = await fetch(`${router.baseUrl}/go/v1/models`, { headers: authHeaders({ "x-gorouter-correlation-id": LOCAL_KEY }) });
    expect(res.status).toBe(400);
    expect(upstream.requests.length).toBe(0);
    upstream.stop();
  });
});

describe("h0 request-contract matrix (GO/ZEN parity, families, streaming, switch, UA)", () => {
  test("ZEN valid session forwarded; ZEN missing refused with zero dispatch", async () => {
    const upstream = await startMockUpstream();
    const router = await newRouter({ upstreamBase: upstream.baseUrl, accounts: [{ alias: "a1", key: "key-a1" }], routes: { zen: "a1" } });
    const ok = await fetch(`${router.baseUrl}/zen/v1/models`, { headers: authHeaders({ "x-opencode-session": "zen-conv-1" }) });
    expect(ok.status).toBe(200);
    expect(upstream.requests[0]!.headers.get("x-opencode-session")).toBe("zen-conv-1");
    const bad = await fetch(`${router.baseUrl}/zen/v1/models`, { headers: authHeaders() });
    expect(bad.status).toBe(400);
    expect(upstream.requests.length).toBe(1);
    upstream.stop();
  });

  test("endpoint families carry the same explicit session (chat/responses/messages)", async () => {
    const upstream = await startMockUpstream();
    const router = await newRouter({ upstreamBase: upstream.baseUrl, accounts: [{ alias: "a1", key: "key-a1" }], routes: { go: "a1" } });
    const paths = ["/go/v1/chat/completions", "/go/v1/responses", "/go/v1/messages"];
    for (const p of paths) {
      const res = await fetch(`${router.baseUrl}${p}`, {
        method: "POST",
        headers: authHeaders({ "x-opencode-session": "fam-conv-5", "content-type": "application/json" }),
        body: JSON.stringify({ model: "m" }),
      });
      expect(res.status).toBe(200);
    }
    expect(upstream.requests.map((r) => r.headers.get("x-opencode-session"))).toEqual(["fam-conv-5", "fam-conv-5", "fam-conv-5"]);
    upstream.stop();
  });

  test("streaming request forms preserve the explicit session", async () => {
    const upstream = await startMockUpstream();
    const router = await newRouter({ upstreamBase: upstream.baseUrl, accounts: [{ alias: "a1", key: "key-a1" }], routes: { go: "a1" } });
    for (const p of ["/go/v1/chat/completions", "/go/v1/responses"]) {
      const res = await fetch(`${router.baseUrl}${p}`, {
        method: "POST",
        headers: authHeaders({ "x-opencode-session": "stream-conv-2", "content-type": "application/json" }),
        body: JSON.stringify({ model: "m", stream: true }),
      });
      expect(res.status).toBe(200);
      await res.text();
    }
    expect(upstream.requests.map((r) => r.headers.get("x-opencode-session"))).toEqual(["stream-conv-2", "stream-conv-2"]);
    upstream.stop();
  });

  test("route/account switch does not rewrite a valid session id", async () => {
    const upstream = await startMockUpstream();
    const router = await newRouter({
      upstreamBase: upstream.baseUrl,
      accounts: [{ alias: "a1", key: "key-a1" }, { alias: "a2", key: "key-a2" }],
      routes: { go: "a1" },
    });
    const r1 = await fetch(`${router.baseUrl}/go/v1/models`, { headers: authHeaders({ "x-opencode-session": "switch-conv-4" }) });
    expect(r1.status).toBe(200);
    router.state.mutate((s) => {
      const next = s.accounts.find((a) => a.alias === "a2")!;
      s.routes.go.accountId = next.id;
    });
    const r2 = await fetch(`${router.baseUrl}/go/v1/models`, { headers: authHeaders({ "x-opencode-session": "switch-conv-4" }) });
    expect(r2.status).toBe(200);
    expect(upstream.requests.map((r) => r.headers.get("x-opencode-session"))).toEqual(["switch-conv-4", "switch-conv-4"]);
    expect(upstream.requests.map((r) => r.headers.get("authorization"))).toEqual(["Bearer key-a1", "Bearer key-a2"]);
    upstream.stop();
  });

  test("truthful caller User-Agent preserved; generic UA never relabeled (H0 section 6)", async () => {
    const upstream = await startMockUpstream();
    const router = await newRouter({ upstreamBase: upstream.baseUrl, accounts: [{ alias: "a1", key: "key-a1" }], routes: { go: "a1" } });
    const r1 = await fetch(`${router.baseUrl}/go/v1/models`, {
      headers: authHeaders({ "x-opencode-session": "ua-conv-6", "user-agent": "TestHarness/9.9" }),
    });
    expect(r1.status).toBe(200);
    expect(upstream.requests[0]!.headers.get("user-agent")).toBe("TestHarness/9.9");
    const r2 = await fetch(`${router.baseUrl}/go/v1/models`, { headers: authHeaders({ "x-opencode-session": "ua-conv-7" }) });
    expect(r2.status).toBe(200);
    const generic = upstream.requests[1]!.headers.get("user-agent") ?? "";
    expect(generic.length).toBeGreaterThan(0);
    expect(generic).not.toContain("GoRouter");
    upstream.stop();
  });

  test("refusal carries deterministic local error + request id + journal row, zero dispatch", async () => {
    const upstream = await startMockUpstream();
    const router = await newRouter({ upstreamBase: upstream.baseUrl, accounts: [{ alias: "a1", key: "key-a1" }], routes: { go: "a1" } });
    const res = await fetch(`${router.baseUrl}/go/v1/chat/completions`, {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ model: "m" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { type: string; message: string } };
    expect(body.error.type).toBe("GoRouterSessionError");
    expect(upstream.requests.length).toBe(0);
    const requestId = res.headers.get("x-gorouter-request-id");
    expect(requestId).toBeTruthy();
    const rows = readJournalRows(router.paths.journalDb);
    expect(rows.length).toBe(1);
    expect(rows[0]!.terminal_outcome).toBe("local_error");
    expect(rows[0]!.http_status).toBe(400);
    expect(rows[0]!.router_request_id).toBe(requestId);
    upstream.stop();
  });
});

describe("CURRENT-008 pre-header (TTFB) deadline", () => {
  test("hung upstream fails fast with 504 and journals upstream_error", async () => {
    const { setUpstreamHeaderTimeoutMsForTests } = await import("../src/server.ts");
    const upstream = await startMockUpstream(() => new Promise<Response>(() => {})); // never responds
    const router = await newRouter({ upstreamBase: upstream.baseUrl, accounts: [{ alias: "a1", key: "k" }], routes: { go: "a1" } });
    setUpstreamHeaderTimeoutMsForTests(300);
    try {
      const t0 = Date.now();
      const res = await fetch(`${router.baseUrl}/go/v1/models`, { headers: authHeaders({ "x-opencode-session": "conv-h0-1" }) });
      expect(Date.now() - t0).toBeLessThan(30_000); // fails fast, never hangs
      expect(res.status).toBe(504);
      expect(res.headers.get("x-gorouter-request-id")).toBeTruthy();
      await res.text();
      const rows = readJournalRows(router.paths.journalDb);
      expect(rows.length).toBe(1);
      expect(rows[0]!.terminal_outcome).toBe("upstream_error");
      expect(rows[0]!.http_status).toBe(504);
    } finally {
      setUpstreamHeaderTimeoutMsForTests(60_000);
    }
    upstream.stop();
  });

  test("slow body chunks after fast headers stream fully (deadline cleared at headers)", async () => {
    const { setUpstreamHeaderTimeoutMsForTests } = await import("../src/server.ts");
    // Headers + first chunk flush immediately; later chunks gap 400ms each
    // (past the 300ms header deadline) — streaming must be unaffected.
    const upstream = await startMockUpstream(() => {
      const enc = new TextEncoder();
      let i = 0;
      const rest = ["b", "c"];
      const stream = new ReadableStream<Uint8Array>({
        start(c) { c.enqueue(enc.encode("a")); },
        async pull(c) {
          if (i >= rest.length) { try { c.close(); } catch { /* canceled */ } return; }
          await new Promise((r) => setTimeout(r, 400));
          try { c.enqueue(enc.encode(rest[i]!)); i++; } catch { /* canceled */ }
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    });
    const router = await newRouter({ upstreamBase: upstream.baseUrl, accounts: [{ alias: "a1", key: "k" }], routes: { go: "a1" } });
    setUpstreamHeaderTimeoutMsForTests(300);
    try {
      const res = await fetch(`${router.baseUrl}/go/v1/chat/completions`, { headers: authHeaders({ "x-opencode-session": "conv-h0-1" }) });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("abc"); // 800ms of gaps sailed through
    } finally {
      setUpstreamHeaderTimeoutMsForTests(60_000);
    }
    upstream.stop();
  });
});
