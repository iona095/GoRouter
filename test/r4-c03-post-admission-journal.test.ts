/** R4-C03 validation matrix: app-level post-admission rejects need journal + request id. */
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePaths, ensureStateDirs } from "../src/paths.ts";
import { createStateStore, makeAccount, type StateStore } from "../src/state.ts";
import { createJournal, type Journal } from "../src/journal.ts";
import { createServer } from "../src/server.ts";
import { memSecrets, startMockUpstream, readJournalRows, LOCAL_KEY } from "./harness.ts";
import { newRef } from "../src/secret-store.ts";

const dirs: string[] = [];
const stops: Array<() => void> = [];
afterEach(async () => {
  for (const s of stops.splice(0)) try { s(); } catch {}
  for (const d of dirs.splice(0)) {
    for (let i = 0; i < 20; i++) {
      try { rmSync(d, { recursive: true, force: true }); break; }
      catch { await new Promise((r) => setTimeout(r, 200)); }
    }
  }
});

async function startRouter(opts: { failLocalCredentialOnCall?: number } = {}) {
  const upstream = await startMockUpstream(() => Response.json({ ok: true }));
  stops.push(() => upstream.stop());
  const stateDir = mkdtempSync(join(tmpdir(), "gorouter-c03-")); dirs.push(stateDir);
  const paths = resolvePaths(stateDir); ensureStateDirs(paths);
  const secrets = memSecrets();
  const localRef = newRef(); secrets.put(localRef, LOCAL_KEY);
  const base = createStateStore(paths, secrets);
  base.mutate((s) => { s.localCredentialRef = localRef; s.settings.port = 0; s.settings.upstreamGo = upstream.baseUrl; s.settings.upstreamZen = upstream.baseUrl; });
  let state: StateStore = base;
  if (opts.failLocalCredentialOnCall !== undefined) {
    const target = opts.failLocalCredentialOnCall;
    let n = 0;
    const orig = base.localCredential.bind(base);
    state = { ...base, localCredential: () => { n++; if (n === target) throw new Error("local client credential not configured; run `gorouter setup`"); return orig(); } };
  }
  const journal = createJournal(paths.journalDb, 30, 100000);
  const server = createServer({ state, journal, paths, startupRefresh: false });
  await server.serve();
  const baseUrl = "http://127.0.0.1:" + server.port();
  stops.push(() => { server.stop(); journal.close(); });
  return { upstream, paths, baseUrl };
}

async function checkRow(paths: ReturnType<typeof resolvePaths>, id: string | null, status: number) {
  expect(id).not.toBeNull();
  expect(id!.length).toBeGreaterThan(0);
  const rows = readJournalRows(paths.journalDb);
  expect(rows.filter((r) => r["router_request_id"] === id).length).toBe(1);
  const hit = rows.find((r) => r["router_request_id"] === id);
  expect(hit).toBeDefined();
  expect(hit!["terminal_outcome"]).toBe("local_error");
  expect(hit!["http_status"]).toBe(status);
  return hit;
}

describe("R4-C03 post-admission journal matrix", () => {
  test("empty lane suffix is journaled with request id", async () => {
    const { paths, baseUrl } = await startRouter();
    const res = await fetch(baseUrl + "/go/v1", { headers: { authorization: "Bearer " + LOCAL_KEY } });
    expect(res.status).toBe(404);
    await checkRow(paths, res.headers.get("x-gorouter-request-id"), 404);
  });

  test("double-slash suffix is journaled with request id", async () => {
    const { paths, baseUrl } = await startRouter();
    const res = await fetch(baseUrl + "/go/v1/a//b", { headers: { authorization: "Bearer " + LOCAL_KEY } });
    expect(res.status).toBe(400);
    await checkRow(paths, res.headers.get("x-gorouter-request-id"), 400);
  });

  test("malformed percent suffix is journaled with request id", async () => {
    const { paths, baseUrl } = await startRouter();
    const res = await fetch(baseUrl + "/go/v1/%zz", { headers: { authorization: "Bearer " + LOCAL_KEY } });
    expect(res.status).toBe(400);
    await checkRow(paths, res.headers.get("x-gorouter-request-id"), 400);
  });

  test("dispatch credential race is journaled with request id, zero upstream", async () => {
    const { upstream, paths, baseUrl } = await startRouter({ failLocalCredentialOnCall: 2 });
    const before = upstream.requests.length;
    const res = await fetch(baseUrl + "/go/v1/chat/completions", { method: "POST", headers: { authorization: "Bearer " + LOCAL_KEY, "content-type": "application/json" }, body: JSON.stringify({ model: "m", messages: [] }) });
    expect(res.status).toBe(503);
    await checkRow(paths, res.headers.get("x-gorouter-request-id"), 503);
    expect(upstream.requests.length).toBe(before);
  });

  test("unsupported path stays single-journaled via admission (not an app gap)", async () => {
    const { paths, baseUrl } = await startRouter();
    const res = await fetch(baseUrl + "/foo", { headers: { authorization: "Bearer " + LOCAL_KEY } });
    expect(res.status).toBe(404);
    await checkRow(paths, res.headers.get("x-gorouter-request-id"), 404);
    expect(readJournalRows(paths.journalDb).length).toBe(1);
  });

  test("models credential race is journaled with request id", async () => {
    const { paths, baseUrl } = await startRouter({ failLocalCredentialOnCall: 2 });
    const res = await fetch(baseUrl + "/go/v1/models", { headers: { authorization: "Bearer " + LOCAL_KEY } });
    expect(res.status).toBe(503);
    await checkRow(paths, res.headers.get("x-gorouter-request-id"), 503);
  });
});
