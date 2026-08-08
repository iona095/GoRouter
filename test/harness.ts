/**
 * Test harness: in-memory secret store, mock upstream, and an in-process
 * router on an ephemeral port. Keeps the suite fast and deterministic while
 * exercising the real server/state/journal code paths.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SecretStore } from "../src/secret-store.ts";
import { resolvePaths, ensureStateDirs } from "../src/paths.ts";
import { createStateStore, makeAccount, type StateStore, type Lane } from "../src/state.ts";
import { createJournal, type Journal } from "../src/journal.ts";
import { createServer } from "../src/server.ts";

export const LOCAL_KEY = "local-test-credential-0123456789abcdef";

export function memSecrets(initial?: Record<string, string>): SecretStore {
  const map = new Map<string, string>(Object.entries(initial ?? {}));
  return {
    put(ref, value) { map.set(ref, value); },
    get(ref) {
      const v = map.get(ref);
      if (v === undefined) throw new Error(`secret missing: ${ref}`);
      return v;
    },
    delete(ref) { map.delete(ref); },
    exists(ref) { return map.has(ref); },
  };
}

export interface MockRequest {
  method: string;
  url: string;
  path: string;
  headers: Headers;
  bodyText: string;
  aborted: boolean;
}

export interface MockUpstream {
  port: number;
  baseUrl: string;
  requests: MockRequest[];
  handler: (req: Request) => Promise<Response> | Response;
  stop: () => void;
}

export async function startMockUpstream(
  handler?: (req: Request) => Promise<Response> | Response,
): Promise<MockUpstream> {
  const requests: MockRequest[] = [];
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req) => {
      const clone = req.clone();
      const bodyText = await clone.text();
      const record: MockRequest = {
        method: req.method,
        url: req.url,
        path: new URL(req.url).pathname,
        headers: req.headers,
        bodyText,
        aborted: false,
      };
      requests.push(record);
      if (handler) return handler(req);
      return Response.json({ ok: true, echo: bodyText });
    },
  });
  return {
    port: upstream.port ?? 0,
    baseUrl: `http://127.0.0.1:${upstream.port ?? 0}`,
    requests,
    handler: handler ?? (() => Response.json({ ok: true })),
    stop: () => upstream.stop(true),
  };
}

export interface TestRouter {
  stateDir: string;
  paths: ReturnType<typeof resolvePaths>;
  secrets: SecretStore;
  state: StateStore;
  journal: Journal;
  server: ReturnType<typeof createServer>;
  baseUrl: string;
  stop: () => void;
}

export async function startTestRouter(opts: {
  upstreamBase: string;
  upstreamHandler?: (req: Request) => Promise<Response> | Response;
  accounts?: Array<{ alias: string; key: string }>;
  routes?: Partial<Record<Lane, string>>;
  retentionDays?: number;
  maxRecords?: number;
}): Promise<TestRouter> {
  const stateDir = mkdtempSync(join(tmpdir(), "gorouter-test-"));
  const paths = resolvePaths(stateDir);
  ensureStateDirs(paths);
  const secrets = memSecrets();
  secrets.put("sec_local", LOCAL_KEY);
  const state = createStateStore(paths, secrets);
  state.mutate((s) => {
    s.localCredentialRef = "sec_local";
    s.settings.port = 0;
    s.settings.upstreamGo = opts.upstreamBase;
    s.settings.upstreamZen = opts.upstreamBase;
    if (opts.retentionDays !== undefined) s.settings.journalRetentionDays = opts.retentionDays;
    if (opts.maxRecords !== undefined) s.settings.journalMaxRecords = opts.maxRecords;
  });
  for (const a of opts.accounts ?? []) {
    state.mutate((s) => {
      const ref = `sec_${a.alias}`;
      secrets.put(ref, a.key);
      s.accounts.push(makeAccount(a.alias, ref));
    });
  }
  for (const [lane, alias] of Object.entries(opts.routes ?? {})) {
    const s = state.read();
    const account = s.accounts.find((x) => x.alias === alias);
    if (!account) throw new Error(`route account '${alias}' not found`);
    state.mutate((st) => {
      st.routes[lane as Lane].accountId = account.id;
    });
  }
  const journal = createJournal(paths.journalDb, state.read().settings.journalRetentionDays, state.read().settings.journalMaxRecords);
  const server = createServer({ state, journal });
  server.serve();
  const baseUrl = `http://127.0.0.1:${server.port()}`;
  return {
    stateDir,
    paths,
    secrets,
    state,
    journal,
    server,
    baseUrl,
    stop: () => {
      server.stop();
      journal.close();
      try { rmSync(stateDir, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}

export function authHeaders(extra?: Record<string, string>): Headers {
  const h = new Headers({ authorization: `Bearer ${LOCAL_KEY}` });
  for (const [k, v] of Object.entries(extra ?? {})) h.set(k, v);
  return h;
}

/** Read journal rows directly from the journal sqlite db. */
export function readJournalRows(dbPath: string): Array<Record<string, unknown>> {
  const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.query("SELECT * FROM request_journal ORDER BY id").all() as Array<Record<string, unknown>>;
  } finally {
    db.close();
  }
}

/** SSE stream with progressive chunk emission for streaming tests. */
export function sseStream(chunks: string[], delayMs = 20): Response {
  const encoder = new TextEncoder();
  let i = 0;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      await new Promise((r) => setTimeout(r, delayMs));
      controller.enqueue(encoder.encode(chunks[i]!));
      i++;
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "x-request-id": "upstream-req-123" },
  });
}
