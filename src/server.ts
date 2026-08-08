/**
 * GoRouter V1 — localhost transparent proxy server.
 *
 * Lane surface (contract §7):
 *   http://127.0.0.1:8787/go/v1/*   -> upstream Go lane
 *   http://127.0.0.1:8787/zen/v1/*  -> upstream Zen lane
 *
 * Invariants enforced here:
 *  - loopback-only binding by default (settings.host must be explicit to change);
 *  - the local client credential is validated locally and NEVER forwarded;
 *  - the selected account credential is injected through the upstream
 *    Authorization boundary only;
 *  - the upstream authority is fixed per lane from state settings — never
 *    derived from request input;
 *  - path suffix, method, query, body and streaming semantics are preserved;
 *  - redirects are never followed by the router (manual mode);
 *  - a coherent per-request route snapshot is resolved before dispatch and
 *    used for the request's entire lifetime;
 *  - journal writes degrade observably and never block routing.
 */
import { timingSafeEqual } from "node:crypto";
import {
  sanitizeForwardHeaders,
  validateCorrelationId,
  extractUpstreamRequestIds,
  classifyEndpointFamily,
  monotonicMs,
  utcNow,
  log,
} from "./util.ts";
import type { StateStore, Lane } from "./state.ts";
import type { Journal, TerminalOutcome } from "./journal.ts";

export const SERVER_VERSION = "1.0.0";

const LANE_PREFIX: Record<Lane, string> = { go: "/go/v1", zen: "/zen/v1" };

interface ServerDeps {
  state: StateStore;
  journal: Journal;
}

interface DispatchResult {
  status: number;
  body: ReadableStream<Uint8Array> | null;
  headers: Headers;
  outcome: TerminalOutcome;
  upstreamRequestIds: string[];
  statusText?: string;
}

function localError(status: number, type: string, message: string): Response {
  return Response.json(
    { error: { type, message } },
    { status, headers: { "content-type": "application/json" } },
  );
}

function timingSafeStringEq(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Upstream auth family derived from the forwarded path (contract §7:
 * endpoint-family-specific authentication handling is permitted where the
 * upstream API genuinely requires it — validated against the current
 * OpenCode gateway: chat/completions + responses parse Authorization Bearer,
 * /messages parses x-api-key, Gemini per-model endpoints parse
 * x-goog-api-key).
 */
type AuthFamily = "bearer" | "anthropic" | "google";

function classifyAuthFamily(suffix: string): AuthFamily {
  const segs = suffix.split("/").filter((s) => s.length > 0);
  if (segs.length >= 1 && segs[0] === "messages") return "anthropic";
  if (
    segs.length >= 2 && segs[0] === "models" &&
    (segs[1]!.includes(":generateContent") || segs[1]!.includes(":streamGenerateContent"))
  ) return "google";
  return "bearer";
}

function authHeaderForFamily(family: AuthFamily): string {
  switch (family) {
    case "anthropic": return "x-api-key";
    case "google": return "x-goog-api-key";
    default: return "authorization";
  }
}

/**
 * The local client credential may arrive in the family-appropriate header
 * (Bearer for OpenAI-style, x-api-key for Anthropic-style, x-goog-api-key
 * for Gemini). Accept any single header that matches.
 */
function extractBearerToken(value: string | null): string | null {
  if (!value) return null;
  const m = /^Bearer\s+(.+)$/i.exec(value);
  return m ? m[1]!.trim() : null;
}

function validateLocalAuth(req: Request, localCred: string): boolean {
  const candidates = [
    extractBearerToken(req.headers.get("authorization")),
    req.headers.get("x-api-key"),
    req.headers.get("x-goog-api-key"),
  ];
  for (const c of candidates) {
    if (c !== null && timingSafeStringEq(c, localCred)) return true;
  }
  return false;
}

function wrapBodyWithFinalize(
  body: ReadableStream<Uint8Array> | null,
  onEnd: (mode: "completed" | "aborted" | "error") => void,
  clientSignal?: AbortSignal | null,
): ReadableStream<Uint8Array> | null {
  if (!body) return null;
  let done = false;
  const reader = body.getReader();
  const finish = (mode: "completed" | "aborted" | "error") => {
    if (done) return;
    done = true;
    onEnd(mode);
  };
  const isClientGone = (e: unknown): boolean => {
    if (clientSignal?.aborted) return true;
    if (e instanceof Error) {
      const msg = e.message.toLowerCase();
      return e.name === "AbortError" || msg.includes("abort") || msg.includes("closed");
    }
    return false;
  };
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for (;;) {
          const { done: readerDone, value } = await reader.read();
          if (readerDone) break;
          controller.enqueue(value);
        }
        controller.close();
        finish("completed");
      } catch (e) {
        // upstream stream failure mid-flight, or client disconnect surfaced
        // through a closed sink / aborted upstream reader
        await Promise.resolve(); // let a disconnect signal settle if pending
        try { await reader.cancel(); } catch { /* ignore */ }
        if (isClientGone(e)) {
          finish("aborted");
        } else {
          controller.error(e);
          finish("error");
        }
      }
    },
    cancel() {
      // client disconnected: stop reading upstream and propagate cancellation
      void reader.cancel().catch(() => {});
      finish("aborted");
    },
  });
}

export function createServer(deps: ServerDeps): { serve: () => void; stop: () => void; port: () => number } {
  let server: ReturnType<typeof Bun.serve> | null = null;

  async function dispatch(lane: Lane, suffix: string, search: string, req: Request): Promise<Response> {
    // --- local client auth -------------------------------------------------
    let localCred: string;
    try {
      localCred = deps.state.localCredential();
    } catch (e) {
      log.error(`local credential unavailable: ${e instanceof Error ? e.message : e}`);
      return localError(503, "GoRouterCredentialError", "local router credential is not configured; run `gorouter setup`");
    }
    if (!validateLocalAuth(req, localCred)) {
      return localError(401, "GoRouterAuthError", "missing or invalid local client credential");
    }

    // --- route snapshot (immutable for this request) ------------------------
    let snapshot;
    try {
      snapshot = deps.state.resolveSnapshot(lane);
    } catch (e) {
      const kind = (e as { kind?: string }).kind ?? "route-error";
      log.warn(`route resolution failed for lane ${lane}: ${kind}`);
      // failures BEFORE upstream dispatch still get a traceable journal row + request id
      const correlationIdPre = validateCorrelationId(req.headers.get("x-gorouter-correlation-id"));
      const startedPre = monotonicMs();
      const preEntry = deps.journal.begin({
        lane,
        selectedAccountId: null,
        selectedAccountAliasSnapshot: null,
        method: req.method,
        endpointFamily: classifyEndpointFamily(suffix),
        terminalOutcome: "ok",
        httpStatus: null,
        upstreamRequestIds: [],
        model: null,
        clientCorrelationId: correlationIdPre ?? null,
      });
      const completeAndReturn = (status: number, type: string, msg: string) => {
        deps.journal.complete(preEntry, {
          completedAtUtc: utcNow(),
          durationMs: monotonicMs() - startedPre,
          terminalOutcome: "local_error",
          httpStatus: status,
          upstreamRequestIds: [],
        });
        const res = localError(status, type, msg);
        res.headers.set("x-gorouter-request-id", preEntry.routerRequestId);
        return res;
      };
      if (kind === "no-route") {
        return completeAndReturn(503, "GoRouterRouteError", `no account selected for lane '${lane}'`);
      }
      if (kind === "dangling-route") {
        return completeAndReturn(503, "GoRouterRouteError", `selected account for lane '${lane}' no longer exists`);
      }
      return completeAndReturn(500, "GoRouterCredentialError", `account credential unavailable for lane '${lane}'`);
    }

    // --- journal begin (id assigned before upstream dispatch) ----------------
    const correlationId = validateCorrelationId(req.headers.get("x-gorouter-correlation-id"));
    const entry = deps.journal.begin({
      lane,
      selectedAccountId: snapshot.accountId,
      selectedAccountAliasSnapshot: snapshot.alias,
      method: req.method,
      endpointFamily: classifyEndpointFamily(suffix),
      terminalOutcome: "ok",
      httpStatus: null,
      upstreamRequestIds: [],
      model: null,
      clientCorrelationId: correlationId ?? null,
    });
    log.debug(
      `dispatch lane=${lane} acct=${snapshot.alias} method=${req.method} suffix=${suffix} id=${entry.routerRequestId}`,
    );

    // --- upstream dispatch ----------------------------------------------------
    const started = monotonicMs();
    const base = lane === "go" ? deps.state.read().settings.upstreamGo : deps.state.read().settings.upstreamZen;
    const upstreamUrl = new URL(base);
    upstreamUrl.pathname = upstreamUrl.pathname + suffix;
    // strip the local credential from query params if present (client misplacement)
    const searchParams = new URLSearchParams(search);
    let stripped = false;
    for (const [k, v] of [...searchParams]) {
      if (v === localCred || v.includes(localCred)) {
        searchParams.delete(k);
        stripped = true;
      }
    }
    if (stripped) log.warn(`local credential stripped from query params (lane=${lane})`);
    upstreamUrl.search = searchParams.toString() ? "?" + searchParams.toString() : "";
    if (upstreamUrl.origin !== new URL(base).origin) {
      log.error(`refusing upstream URL outside fixed authority (lane=${lane})`);
      deps.journal.complete(entry, {
        completedAtUtc: utcNow(),
        durationMs: monotonicMs() - started,
        terminalOutcome: "local_error",
        httpStatus: 500,
        upstreamRequestIds: [],
      });
      const res = localError(500, "GoRouterRouteError", "upstream authority mismatch");
      res.headers.set("x-gorouter-request-id", entry.routerRequestId);
      return res;
    }

    // endpoint-family-specific credential injection (validated upstream surface)
    const authFamily = classifyAuthFamily(suffix);
    const forwardHeaders = sanitizeForwardHeaders(req.headers);
    // defense: arbitrary client headers whose value contains the local credential
    // are stripped so they never reach the pinned OpenCode authority
    for (const [name, value] of [...forwardHeaders]) {
      if (value.includes(localCred)) {
        log.warn(`local credential stripped from forwarded header ${name} (lane=${lane})`);
        forwardHeaders.delete(name);
      }
    }
    forwardHeaders.set(
      authHeaderForFamily(authFamily),
      authFamily === "bearer" ? `Bearer ${snapshot.secret}` : snapshot.secret,
    );
    forwardHeaders.set("host", upstreamUrl.host);

    let upstreamRes: Response;
    try {
      upstreamRes = await fetch(upstreamUrl, {
        method: req.method,
        headers: forwardHeaders,
        body: req.body,
        redirect: "manual",
        signal: (req as Request & { signal?: AbortSignal }).signal,
      });
    } catch (e) {
      log.warn(`upstream fetch failed lane=${lane} id=${entry.routerRequestId}: ${e instanceof Error ? e.message : e}`);
      deps.journal.complete(entry, {
        completedAtUtc: utcNow(),
        durationMs: monotonicMs() - started,
        terminalOutcome: "upstream_error",
        httpStatus: 502,
        upstreamRequestIds: [],
      });
      const res = localError(502, "GoRouterUpstreamError", "upstream OpenCode request failed");
      res.headers.set("x-gorouter-request-id", entry.routerRequestId);
      return res;
    }

    // --- build proxied response ------------------------------------------------
    const outHeaders = new Headers();
    for (const [name, value] of upstreamRes.headers) {
      const lower = name.toLowerCase();
      // hop-by-hop and transfer framing are runtime-managed; content-encoding
      // is stripped because the router's transport already decoded the body
      // (forwarding the original header would double-decode for clients)
      if (
        lower === "connection" || lower === "keep-alive" || lower === "transfer-encoding" ||
        lower === "content-encoding" || lower === "content-length"
      ) continue;
      outHeaders.set(name, value);
    }
    outHeaders.set("x-gorouter-request-id", entry.routerRequestId);
    outHeaders.delete("content-length"); // recomputed by the runtime for the stream

    const upstreamRequestIds = extractUpstreamRequestIds(upstreamRes.headers);
    const outcome: TerminalOutcome = upstreamRes.status >= 400 ? "upstream_error" : "ok";

    const finalize = (mode: "completed" | "aborted" | "error") => {
      const terminalOutcome: TerminalOutcome =
        mode === "aborted" ? "client_abort" : mode === "error" ? "upstream_error" : outcome;
      deps.journal.complete(entry, {
        completedAtUtc: utcNow(),
        durationMs: monotonicMs() - started,
        terminalOutcome,
        httpStatus: upstreamRes.status,
        upstreamRequestIds,
      });
    };

    // Bodyless responses (204/304/empty 200) must still terminalize the journal:
    // there is no stream to observe, so finalize immediately.
    if (upstreamRes.body === null) {
      finalize("completed");
      return new Response(null, { status: upstreamRes.status, headers: outHeaders });
    }

    const body = wrapBodyWithFinalize(upstreamRes.body, finalize, (req as Request & { signal?: AbortSignal }).signal);
    return new Response(body, { status: upstreamRes.status, headers: outHeaders });
  }

  const handler = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname;
    if (path === "/healthz") {
      const st = deps.state.read();
      const journal = deps.journal.stats();
      const routes: Record<string, { accountId: string | null; alias: string | null }> = {};
      for (const lane of ["go", "zen"] as const) {
        const id = st.routes[lane].accountId;
        const alias = id ? st.accounts.find((a) => a.id === id)?.alias ?? null : null;
        routes[lane] = { accountId: id, alias };
      }
      return Response.json({
        status: "ok",
        version: SERVER_VERSION,
        loopbackOnly: st.settings.host === "127.0.0.1" || st.settings.host === "::1" || st.settings.host === "localhost",
        routes,
        automaticFallback: "disabled",
        state: deps.state.health(),
        journal,
      });
    }

    let lane: Lane | null = null;
    let suffix = "";
    for (const l of ["go", "zen"] as const) {
      const prefix = LANE_PREFIX[l];
      if (path === prefix) {
        lane = l;
        suffix = "";
        break;
      }
      if (path.startsWith(prefix + "/")) {
        lane = l;
        suffix = path.slice(prefix.length);
        break;
      }
    }
    if (!lane) {
      return localError(404, "GoRouterRouteError", "unsupported local path; use /go/v1/* or /zen/v1/*");
    }
    if (suffix.length === 0) {
      return localError(404, "GoRouterRouteError", "unsupported local path; expected /go/v1/<path> or /zen/v1/<path>");
    }
    if (suffix.includes("//") || suffix.includes("\\")) {
      return localError(400, "GoRouterRouteError", "malformed local path");
    }
    return dispatch(lane, suffix, url.search, req);
  };

  return {
    serve() {
      const st = deps.state.read();
      const host = st.settings.host;
      const port = st.settings.port;
      server = Bun.serve({
        hostname: host,
        port,
        fetch: handler,
      });
      log.info(`GoRouter V1 listening on http://${host}:${server.port} (go/v1, zen/v1)`);
    },
    port() {
      return server?.port ?? 0;
    },
    stop() {
      server?.stop(true);
      server = null;
    },
  };
}
