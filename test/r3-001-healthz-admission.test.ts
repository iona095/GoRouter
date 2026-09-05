/**
 * R3-001 regression: public /healthz admission covers only bodyless GET
 * (and HEAD). A declared body on /healthz is rejected at framing cost
 * BEFORE aggregate-budget acquisition, so credentialless senders cannot
 * monopolize the body budget through the liveness endpoint.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import { createHmac } from "node:crypto";
import { createServer } from "../src/server.ts";
import { createStateStore } from "../src/state.ts";
import { createJournal } from "../src/journal.ts";
import { resolvePaths, ensureStateDirs } from "../src/paths.ts";
import { newRef } from "../src/secret-store.ts";
import {
  setInboundTotalBufferedLimitForTests,
  resetInboundTotalBufferedLimitForTests,
} from "../src/inbound-http.ts";
import { memSecrets } from "./harness.ts";

const LOCAL = "r3001-local-credential";
const dirs: string[] = [];
afterEach(() => {
  resetInboundTotalBufferedLimitForTests();
  for (const d of dirs.splice(0)) {
    for (let i = 0; i < 5; i++) {
      try { rmSync(d, { recursive: true, force: true }); break; } catch { Bun.sleepSync(50 * (i + 1)); }
    }
  }
});

async function freshRouter() {
  const stateDir = mkdtempSync(join(tmpdir(), "gorouter-r3001-"));
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
  await server.serve();
  return { server, journal };
}

interface RawResponse { status: number; body: string; closed: boolean }

/** Send ONLY head (headers), then read whatever arrives (idleMs cap). */
function headOnly(port: number, method: string, target: string, extraHeaders: string[] = [], idleMs = 8000): Promise<RawResponse> {
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
      resolve({ status: m ? Number(m[1]) : 0, body, closed });
    };
    const kill = setTimeout(() => finish(false), idleMs);
    sock.on("connect", () => {
      sock.write([method + " " + target + " HTTP/1.1", "Host: 127.0.0.1:" + port, ...extraHeaders, "Connection: close", "", ""].join("\r\n"));
    });
    sock.on("data", (d) => { data += d.toString("utf8"); });
    sock.on("close", () => finish(true));
    sock.on("error", () => finish(true));
  });
}

describe("R3-001 healthz admission", () => {
  test("GET /healthz remains public", async () => {
    const f = await freshRouter();
    try {
      const res = await fetch("http://127.0.0.1:" + f.server.port() + "/healthz");
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.status).toBe("ok");
    } finally {
      f.server.stop();
      f.journal.close();
    }
  }, 30000);

  test("supervisor challenge GET still verifies", async () => {
    const f = await freshRouter();
    try {
      const challenge = "r3001challenge01";
      const res = await fetch("http://127.0.0.1:" + f.server.port() + "/healthz", { headers: { "x-gorouter-challenge": challenge } });
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.challenge).toBe(challenge);
      const expected = createHmac("sha256", LOCAL).update(challenge, "utf8").digest("hex");
      expect(body.proof).toBe(expected);
    } finally {
      f.server.stop();
      f.journal.close();
    }
  }, 30000);

  test("POST /healthz is not part of the public surface (rejected pre-budget)", async () => {
    const f = await freshRouter();
    try {
      const r = await headOnly(f.server.port(), "POST", "/healthz", ["Content-Type: application/json", "Content-Length: 1048576"]);
      expect(r.status).toBe(404);
      expect(r.body).toMatch(/GoRouterRouteError/);
      expect(r.closed).toBe(true);
    } finally {
      f.server.stop();
      f.journal.close();
    }
  }, 30000);

  test("GET /healthz with Content-Length is rejected before body transmission", async () => {
    const f = await freshRouter();
    try {
      const r = await headOnly(f.server.port(), "GET", "/healthz", ["Content-Length: 1048576"]);
      expect(r.status).toBe(400);
      expect(r.body).toMatch(/GoRouterRouteError/);
      expect(r.closed).toBe(true);
    } finally {
      f.server.stop();
      f.journal.close();
    }
  }, 30000);

  test("rejected health requests do not consume aggregate budget", async () => {
    const f = await freshRouter();
    try {
      // Shrink the budget below the declared health body: a pre-budget
      // reject answers 400; a budget verdict would answer 503.
      setInboundTotalBufferedLimitForTests(1024);
      const post = await headOnly(f.server.port(), "POST", "/healthz", ["Content-Type: application/json", "Content-Length: 65536"]);
      expect(post.status).toBe(404);
      expect(post.body).not.toMatch(/GoRouterOverloadedError/);
      const get = await headOnly(f.server.port(), "GET", "/healthz", ["Content-Length: 65536"]);
      expect(get.status).toBe(400);
      expect(get.body).not.toMatch(/GoRouterOverloadedError/);
    } finally {
      f.server.stop();
      f.journal.close();
    }
  }, 30000);
});
