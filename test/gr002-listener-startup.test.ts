/**
 * GR-002 regression: listener startup is awaitable and fails fast.
 *
 * A bind collision must reject promptly (no "listening" log, no hung
 * process) and a successful ephemeral bind must expose its real port.
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
import { memSecrets, LOCAL_KEY } from "./harness.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    for (let i = 0; i < 5; i++) {
      try { rmSync(d, { recursive: true, force: true }); break; } catch { Bun.sleepSync(50 * (i + 1)); }
    }
  }
});

function freshWithPort(port: number) {
  const stateDir = mkdtempSync(join(tmpdir(), "gorouter-gr002-"));
  dirs.push(stateDir);
  const paths = resolvePaths(stateDir);
  ensureStateDirs(paths);
  const secrets = memSecrets();
  const localRef = newRef();
  secrets.put(localRef, LOCAL_KEY);
  const state = createStateStore(paths, secrets);
  state.mutate((s) => {
    s.localCredentialRef = localRef;
    s.settings.port = port;
    s.settings.upstreamGo = "http://127.0.0.1:1";
    s.settings.upstreamZen = "http://127.0.0.1:1";
  });
  const journal = createJournal(paths.journalDb, 30, 100000);
  const server = createServer({ state, journal, paths, startupRefresh: false });
  return { server, journal };
}

function listenBlocker(): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      resolve({ port, close: () => new Promise<void>((res) => srv.close(() => res())) });
    });
  });
}

describe("GR-002 listener startup lifecycle", () => {
  test("occupied port rejects promptly with no listening log", async () => {
    const blocker = await listenBlocker();
    const f = freshWithPort(blocker.port);
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
    const started = Date.now();
    let err: unknown = null;
    try {
      await f.server.serve();
    } catch (e) { err = e; } finally { console.log = origLog; }
    const elapsed = Date.now() - started;
    try {
      expect(err).not.toBeNull();
      expect(String((err as Error)?.message ?? err)).toMatch(/EADDRINUSE|in use/i);
      expect(elapsed).toBeLessThan(5000);
      expect(logs.some((l) => /listening on/.test(l))).toBe(false);
    } finally {
      f.server.stop();
      f.journal.close();
      await blocker.close();
    }
  }, 15000);

  test("ephemeral bind exposes the real port and serves", async () => {
    const f = freshWithPort(0);
    const port = await f.server.serve();
    try {
      expect(port).toBeGreaterThan(0);
      expect(f.server.port()).toBe(port);
      const res = await fetch("http://127.0.0.1:" + port + "/healthz");
      expect(res.status).toBe(200);
    } finally {
      f.server.stop();
      f.journal.close();
    }
  }, 15000);
});
