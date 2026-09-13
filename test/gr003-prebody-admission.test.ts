/**
 * GR-003 regression: authentication and route admission run BEFORE request
 * bodies are buffered. An unauthenticated (or unroutable) declared body is
 * rejected at framing cost; aggregate budgets and an absolute upload
 * deadline bound what admitted senders can jointly hold.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import { createServer } from "../src/server.ts";
import { createStateStore } from "../src/state.ts";
import { createJournal } from "../src/journal.ts";
import { resolvePaths, ensureStateDirs } from "../src/paths.ts";
import { newRef } from "../src/secret-store.ts";
import {
  setInboundTotalBufferedLimitForTests,
  resetInboundTotalBufferedLimitForTests,
  setInboundBodyAbsoluteTimeoutForTests,
  resetInboundBodyAbsoluteTimeoutForTests,
} from "../src/inbound-http.ts";
import { memSecrets, startMockUpstream, startTestRouter } from "./harness.ts";

const LOCAL = "gr003-local-credential";
const dirs: string[] = [];
afterEach(() => {
  resetInboundTotalBufferedLimitForTests();
  resetInboundBodyAbsoluteTimeoutForTests();
  for (const d of dirs.splice(0)) {
    for (let i = 0; i < 5; i++) {
      try { rmSync(d, { recursive: true, force: true }); break; } catch { Bun.sleepSync(50 * (i + 1)); }
    }
  }
});

function freshServer() {
  const stateDir = mkdtempSync(join(tmpdir(), "gorouter-gr003-"));
  dirs.push(stateDir);
  const paths = resolvePaths(stateDir);
  ensureStateDirs(paths);
  const secrets = memSecrets();
  const localRef = newRef();
  secrets.put(localRef, LOCAL);
  const state = createStateStore(paths, secrets);
  state.mutate((s) => {
    s.localCredentialRef = localRef;
    s.settings.port = 0;
    s.settings.upstreamGo = "http://127.0.0.1:1";
    s.settings.upstreamZen = "http://127.0.0.1:1";
  });
  const journal = createJournal(paths.journalDb, 30, 100000);
  const server = createServer({ state, journal, paths, startupRefresh: false });
  return { server, journal };
}

interface RawResponse { status: number; headers: string; body: string; closed: boolean; elapsedMs: number }

/** Send ONLY the head (headers) of a POST, then read whatever arrives. */
function postHeadOnly(port: number, target: string, auth: string | null, contentLength: number, idleMs = 10000): Promise<RawResponse> {
  const started = Date.now();
  return new Promise((resolve) => {
    const sock = net.connect({ host: "127.0.0.1", port });
    let data = "";
    let done = false;
    const finish = (closed: boolean): void => {
      if (done) return;
      done = true;
      const sep = data.indexOf("\r\n\r\n");
      const head = sep === -1 ? data : data.slice(0, sep);
      const body = sep === -1 ? "" : data.slice(sep + 4);
      const m = /^HTTP\/\d\.\d\s+(\d{3})/.exec(head);
      clearTimeout(kill);
      sock.destroy();
      resolve({ status: m ? Number(m[1]) : 0, headers: head, body, closed, elapsedMs: Date.now() - started });
    };
    const kill = setTimeout(() => finish(false), idleMs);
    sock.on("connect", () => {
      const lines = [
        "POST " + target + " HTTP/1.1",
        "Host: 127.0.0.1:" + port,
        ...(auth !== null ? ["Authorization: Bearer " + auth] : []),
        "Content-Type: application/json",
        "Content-Length: " + contentLength,
        "Connection: close",
        "",
        "",
      ];
      sock.write(lines.join("\r\n"));
    });
    sock.on("data", (d) => { data += d.toString("utf8"); });
    sock.on("close", () => finish(true));
    sock.on("error", () => finish(true));
  });
}

describe("GR-003 pre-body authentication and admission", () => {
  test("unauthenticated declared body is 401 before body bytes are sent", async () => {
    const f = await (async () => { const s = freshServer(); await s.server.serve(); return s; })();
    try {
      const port = f.server.port();
      const r = await postHeadOnly(port, "/go/v1/chat/completions", "wrong-credential", 1024 * 1024);
      expect(r.status).toBe(401);
      expect(r.body).toMatch(/GoRouterAuthError/);
      expect(r.elapsedMs).toBeLessThan(9000);
    } finally {
      f.server.stop();
      f.journal.close();
    }
  }, 30000);

  test("unsupported route is 404 before body bytes are sent", async () => {
    const f = await (async () => { const s = freshServer(); await s.server.serve(); return s; })();
    try {
      const port = f.server.port();
      const r = await postHeadOnly(port, "/nope/v1/chat/completions", LOCAL, 1024 * 1024);
      expect(r.status).toBe(404);
      expect(r.body).toMatch(/GoRouterRouteError/);
      expect(r.elapsedMs).toBeLessThan(9000);
    } finally {
      f.server.stop();
      f.journal.close();
    }
  }, 30000);

  test("aggregate budget rejects over-budget declared bodies with 503", async () => {
    setInboundTotalBufferedLimitForTests(1024);
    const f = await (async () => { const s = freshServer(); await s.server.serve(); return s; })();
    try {
      const port = f.server.port();
      const r = await postHeadOnly(port, "/go/v1/chat/completions", LOCAL, 4096);
      expect(r.status).toBe(503);
      expect(r.body).toMatch(/GoRouterOverloadedError/);
      // under-budget bodies are still admitted past the gate (auth ok; the
      // 502 below proves dispatch was reached, not the admission gate).

    } finally {
      f.server.stop();
      f.journal.close();
    }
  }, 30000);

  test("continuous dribble hits the absolute upload deadline", async () => {
    setInboundBodyAbsoluteTimeoutForTests(300);
    const f = await (async () => { const s = freshServer(); await s.server.serve(); return s; })();
    try {
      const port = f.server.port();
      const started = Date.now();
      const closed: boolean = await new Promise((resolve) => {
        const sock = net.connect({ host: "127.0.0.1", port });
        sock.on("connect", () => {
          sock.write(
            "POST /go/v1/chat/completions HTTP/1.1\r\n" +
            "Host: 127.0.0.1:" + port + "\r\n" +
            "Authorization: Bearer " + LOCAL + "\r\n" +
            "Content-Type: application/json\r\n" +
            "Content-Length: 1048576\r\n\r\n" +
            "{",
          );
        });
        sock.on("data", () => {});
        sock.on("close", () => resolve(true));
        sock.on("error", () => resolve(true));
        setTimeout(() => { sock.destroy(); resolve(false); }, 9000);
      });
      const elapsed = Date.now() - started;
      expect(closed).toBe(true);
      expect(elapsed).toBeLessThan(9000);
    } finally {
      f.server.stop();
      f.journal.close();
    }
  }, 30000);

  test("admitted traffic still proxies end to end", async () => {
    const upstream = await startMockUpstream((req) => Response.json({ ok: true }));
    const router = await startTestRouter({
      upstreamBase: upstream.baseUrl,
      accounts: [{ alias: "a1", key: "sk-test" }],
      routes: { go: "a1" },
    });
    try {
      const res = await fetch(router.baseUrl + "/go/v1/chat/completions", {
        method: "POST",
        // W0 (Amendment A5/A7): admitted traffic carries a session.
        headers: { authorization: "Bearer local-test-credential-0123456789abcdef", "content-type": "application/json", "x-opencode-session": "conv-w0-test-01" },
        body: JSON.stringify({ model: "m", messages: [] }),
      });
      expect(res.status).toBe(200);
      expect(upstream.requests.length).toBe(1);
    } finally {
      router.stop();
      upstream.stop();
    }
  }, 30000);
});
