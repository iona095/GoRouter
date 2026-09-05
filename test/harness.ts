/**
 * Test harness: in-memory secret store, mock upstream, and an in-process
 * router on an ephemeral port. Keeps the suite fast and deterministic while
 * exercising the real server/state/journal code paths.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newRef, type SecretStore } from "../src/secret-store.ts";
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

export interface MockUpstreamOpts {
  /** idleTimeout in seconds for the mock server; 0 disables (default 10). */
  idleTimeout?: number;
}

export async function startMockUpstream(
  handler?: (req: Request) => Promise<Response> | Response,
  opts?: MockUpstreamOpts,
): Promise<MockUpstream> {
  const requests: MockRequest[] = [];
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: opts?.idleTimeout ?? 10,
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
      req.signal?.addEventListener("abort", () => { record.aborted = true; });
      if (handler) return handler(req);
      return Response.json({ ok: true, echo: bodyText });
    },
  });
  let stopped = false;
  return {
    port: upstream.port ?? 0,
    baseUrl: `http://127.0.0.1:${upstream.port ?? 0}`,
    requests,
    handler: handler ?? (() => Response.json({ ok: true })),
    stop: () => {
      if (stopped) return;
      stopped = true;
      upstream.stop(true);
    },
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
  upstreamGo?: string;
  upstreamZen?: string;
  upstreamHandler?: (req: Request) => Promise<Response> | Response;
  accounts?: Array<{ alias: string; key: string }>;
  /** Override the local control credential (default LOCAL_KEY): short values pin the exact-match containment floor. */
  localKey?: string;
  routes?: Partial<Record<Lane, string>>;
  retentionDays?: number;
  maxRecords?: number;
}): Promise<TestRouter> {
  const stateDir = mkdtempSync(join(tmpdir(), "gorouter-test-"));
  const paths = resolvePaths(stateDir);
  ensureStateDirs(paths);
  const secrets = memSecrets();
  // CURRENT-001: the harness mints canonical refs exactly like production
  // (newRef), so state-load containment filtering exercises the real path.
  const localRef = newRef();
  secrets.put(localRef, opts.localKey ?? LOCAL_KEY);
  const state = createStateStore(paths, secrets);
  state.mutate((s) => {
    s.localCredentialRef = localRef;
    s.settings.port = 0;
    s.settings.upstreamGo = opts.upstreamGo ?? opts.upstreamBase;
    s.settings.upstreamZen = opts.upstreamZen ?? opts.upstreamBase;
    if (opts.retentionDays !== undefined) s.settings.journalRetentionDays = opts.retentionDays;
    if (opts.maxRecords !== undefined) s.settings.journalMaxRecords = opts.maxRecords;
  });
  for (const a of opts.accounts ?? []) {
    state.mutate((s) => {
      const ref = newRef();
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
  const server = createServer({ state, journal, paths, startupRefresh: false });
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

/**
 * Read a settings.yaml written by FileDshClient (block-style YAML since M5
 * fidelity — JSON.parse no longer reads it back).
 */
export async function readYamlFile<T = unknown>(p: string): Promise<T> {
  const { readFileSync } = await import("node:fs");
  const { parse } = await import("yaml");
  return parse(readFileSync(p, "utf8")) as T;
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
  // BL-001: finalize before close — no GC-dependent handle linger.
  const stmt = db.query("SELECT * FROM request_journal ORDER BY id");
  try {
    return stmt.all() as Array<Record<string, unknown>>;
  } finally {
    try { stmt.finalize(); } catch { /* already finalized */ }
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
        try { controller.close(); } catch { /* canceled */ }
        return;
      }
      await new Promise((r) => setTimeout(r, delayMs));
      try {
        controller.enqueue(encoder.encode(chunks[i]!));
        i++;
      } catch { /* canceled mid-pull (mock stopped while streaming) */ }
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "x-request-id": "upstream-req-123" },
  });
}

export interface RawGetResult {
  status: number;
  bodyText: string;
  elapsedMs: number;
  error?: string;
}

function parseRawResponse(data: string, elapsedMs: number): RawGetResult {
  const sep = data.indexOf("\r\n\r\n");
  const head = sep === -1 ? data : data.slice(0, sep);
  const bodyText = sep === -1 ? "" : data.slice(sep + 4);
  const m = /^HTTP\/\d\.\d\s+(\d{3})/.exec(head);
  return { status: m ? Number(m[1]) : 0, bodyText, elapsedMs };
}

/**
 * Raw HTTP/1.1 GET over a fresh TCP connection with the exact request-path
 * bytes preserved (fetch/undici would normalize dot segments and escapes).
 * Reads until the connection closes, then parses the status line + body.
 */
export async function rawGet(port: number, rawPath: string): Promise<RawGetResult> {
  const { connect } = await import("node:net");
  const started = Date.now();
  return new Promise((resolve) => {
    const sock = connect(port, "127.0.0.1");
    let data = "";
    sock.setEncoding("utf8");
    sock.on("connect", () => {
      sock.write(
        `GET ${rawPath} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer ${LOCAL_KEY}\r\nConnection: close\r\n\r\n`,
      );
    });
    sock.on("data", (d) => { data += d; });
    sock.on("end", () => resolve(parseRawResponse(data, Date.now() - started)));
    sock.on("error", (e) => {
      resolve({ status: 0, bodyText: data, elapsedMs: Date.now() - started, error: e.message });
    });
    sock.setTimeout(10_000, () => {
      sock.destroy();
      resolve({ status: 0, bodyText: data, elapsedMs: Date.now() - started, error: "timeout" });
    });
  });
}
