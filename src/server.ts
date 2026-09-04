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
import type { Server } from "node:http";
import { createInboundHttpServer } from "./inbound-http.ts";
import {
  sanitizeForwardHeaders,
  validateCorrelationId,
  OPENCODE_SESSION_HEADER,
  resolveUpstreamSessionIdSafe,
  MIN_SUBSTRING_SECRET_LENGTH,
  extractUpstreamRequestIds,
  classifyEndpointFamily,
  monotonicMs,
  utcNow,
  log,
  redact,
} from "./util.ts";
import type { StateStore, Lane } from "./state.ts";
import type { Journal, TerminalOutcome } from "./journal.ts";
import { resolvePaths, type Paths } from "./paths.ts";
import { loadRegistry, isFresh, isCooldown } from "./models/registry.ts";
import { maybeRefreshOnStartup, refreshRegistry } from "./models/refresh.ts";
import { createDshClient } from "./models/dsh-client.ts";
import { reconcileDshCatalog } from "./models/dsh-sync.ts";
import { storeDshSyncStatus } from "./models/dsh-sync-state.ts";
import { loadApprovalStore } from "./models/dsh-approvals.ts";

export const SERVER_VERSION = "1.0.0";

const LANE_PREFIX: Record<Lane, string> = { go: "/go/v1", zen: "/zen/v1" };

interface ServerDeps {
  state: StateStore;
  journal: Journal;
  paths?: Paths;
  /** When false, skip Slice A background startup refresh (tests use fresh state per router) */
  startupRefresh?: boolean;
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

/**
 * Path-namespace enforcement for forwarded suffixes. The upstream URL is
 * pinned to a lane base path (e.g. /zen/go/v1); an encoded payload such as
 * %2e%2e (dot-dot) must never escape that namespace once an upstream decodes
 * and resolves it. Percent-decodes up to 3 passes (fail closed on malformed
 * escapes) and rejects any decoded traversal form ('\\', '//', '.'/'..'
 * segments) or a final path that is not equal-or-descendant of the base.
 *
 * The 3-pass bound is a deliberate defense-in-depth limit, NOT a decoding
 * guarantee: no standard HTTP server decodes a request-target more than once,
 * so encodings nested deeper than 3 levels (N>3) are out of scope by design
 * and are not chased further. The bound is intentionally not raised.
 */
export function isPathWithinLaneBase(finalPathname: string, basePathname: string): boolean {
  let decoded = finalPathname;
  for (let i = 0; i < 3; i++) {
    // stop when no valid percent-encoding remains (a literal '%' from %25 is
    // legal and must not be re-decoded)
    if (!/%[0-9a-f]{2}/i.test(decoded)) break;
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      return false;
    }
  }
  if (decoded.includes("\\") || decoded.includes("//")) return false;
  // Defense-in-depth: encodings nested deeper than the 3-pass bound still
  // leave percent-encodings (any depth) — reject rather than forward.
  if (/%[0-9a-f]{2}/i.test(decoded)) return false;
  const segments = decoded.split("/").filter((s) => s.length > 0);
  // Semicolon-parameter dot segments (e.g. ..;foo) are traversal-capable on
  // matrix-parameter-aware backends; reject any dot-core segment.
  if (segments.some((s) => { const core = s.split(";")[0]; return core === "." || core === ".."; })) return false;
  const baseSegments = basePathname.split("/").filter((s) => s.length > 0);
  if (segments.length < baseSegments.length) return false;
  for (let i = 0; i < baseSegments.length; i++) {
    if (segments[i] !== baseSegments[i]) return false;
  }
  return true;
}

export function wrapBodyWithFinalize(
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
  // Client abort is inferred ONLY from the client signal or an AbortError;
  // never from error message text: genuine upstream mid-stream failures
  // mention "closed"/"terminated" but are upstream errors, not client aborts.
  const isClientGone = (e: unknown): boolean => {
    if (clientSignal?.aborted) return true;
    return e instanceof Error && e.name === "AbortError";
  };
  // One-shot client-abort subscription: when the client disconnects, the
  // transport aborts the request signal. Cancel the upstream read and
  // finalize the journal as "aborted" even when no pull is in flight
  // (e.g. the consumer is stalled on backpressure).
  const onClientAbort = () => {
    void reader.cancel().catch(() => {});
    finish("aborted");
  };
  if (clientSignal) {
    if (clientSignal.aborted) {
      onClientAbort();
    } else {
      clientSignal.addEventListener("abort", onClientAbort, { once: true });
    }
  }
  return new ReadableStream<Uint8Array>({
    // pull-driven: read exactly one upstream chunk per consumer pull so the
    // router never buffers the whole upstream response ahead of the client
    async pull(controller) {
      try {
        const { done: readerDone, value } = await reader.read();
        if (readerDone) {
          controller.close();
          finish("completed");
          return;
        }
        controller.enqueue(value);
      } catch (e) {
        if (isClientGone(e)) {
          // Client is gone, or the upstream read failed with an AbortError-named
          // error while the client is still connected. Stop reading upstream and
          // settle the consumer stream: if the client really did abort, the sink
          // is already closed and close() throws (swallowed); if the client is
          // still alive (an upstream error merely named AbortError), the guarded
          // close() lets the surviving consumer settle promptly instead of
          // hanging forever on a pending read.
          try { await reader.cancel(); } catch { /* ignore */ }
          try { controller.close(); } catch { /* sink already closed */ }
          finish("aborted");
        } else {
          try { await reader.cancel(); } catch { /* ignore */ }
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
  let server: Server | null = null;

  function serveModelsCache(lane: Lane, reg: import("./models/types.ts").RegistryFile, fromCache: "hit" | "stale"): Response {
    const snap = lane === "go" ? reg.go! : reg.zen!;
    const body = JSON.stringify({ object: "list", data: snap.models });
    const age = Date.now() - Date.parse(reg.updatedAtUtc);
    return new Response(body, {
      status: 200,
      headers: {
        "content-type": "application/json",
        "x-gorouter-models-cache": fromCache,
        "x-gorouter-models-age-ms": String(Math.max(0, age)),
        "x-gorouter-request-id": "", // filled by caller if needed
      },
    });
  }

  async function handleModels(lane: Lane, suffix: string, req: Request): Promise<Response> {
    // local auth — same as dispatch (preserve auth even for bad method)
    let localCred: string;
    try {
      localCred = deps.state.localCredential();
    } catch (e) {
      log.error(`local credential unavailable: ${e instanceof Error ? e.message : e}`);
      return localError(503, "GoRouterCredentialError", "local router credential is not configured; run `gorouter setup`");
    }
    if (!validateLocalAuth(req, localCred)) {
      const entry = deps.journal.begin({
        lane,
        selectedAccountId: null,
        selectedAccountAliasSnapshot: null,
        method: req.method,
        endpointFamily: "models",
        terminalOutcome: "ok",
        httpStatus: null,
        upstreamRequestIds: [],
        model: null,
        clientCorrelationId: validateCorrelationId(req.headers.get("x-gorouter-correlation-id")) ?? null,
      });
      deps.journal.complete(entry, { completedAtUtc: utcNow(), durationMs: 0, terminalOutcome: "local_error", httpStatus: 401, upstreamRequestIds: [] });
      const res = localError(401, "GoRouterAuthError", "missing or invalid local client credential");
      res.headers.set("x-gorouter-request-id", entry.routerRequestId);
      return res;
    }
    if (req.method !== "GET") {
      const entry = deps.journal.begin({
        lane,
        selectedAccountId: null,
        selectedAccountAliasSnapshot: null,
        method: req.method,
        endpointFamily: "models",
        terminalOutcome: "ok",
        httpStatus: null,
        upstreamRequestIds: [],
        model: null,
        clientCorrelationId: validateCorrelationId(req.headers.get("x-gorouter-correlation-id")) ?? null,
      });
      deps.journal.complete(entry, { completedAtUtc: utcNow(), durationMs: 0, terminalOutcome: "local_error", httpStatus: 405, upstreamRequestIds: [] });
      const res = localError(405, "GoRouterRouteError", "method not allowed for /models; use GET");
      res.headers.set("x-gorouter-request-id", entry.routerRequestId);
      return res;
    }
    // For /models: when no registry exists, proxy directly (preserves existing proxy semantics and exact upstream request counts).
    // When registry exists, serve from cache (fresh/stale) with background refresh. This keeps inference routing and
    // route-snapshot validation (dangling/missing-secret -> 503/500) intact for the no-cache path.
    const paths = deps.paths ?? resolvePaths();
    const now = Date.now();
    let reg = loadRegistry(paths);
    const hasLaneData = reg !== null && (lane === "go" ? reg.go !== null : reg.zen !== null);
    const fresh = reg !== null ? isFresh(reg, now) : false;
    const cooldown = reg !== null ? isCooldown(reg, now) : false;
    const correlationId = validateCorrelationId(req.headers.get("x-gorouter-correlation-id"));

    // If no registry at all, directly proxy (do not attempt dual-lane refresh which would double-hit upstream and break request counts)
    if (!reg || !hasLaneData) {
      return dispatch(lane, suffix, new URL(req.url).search, req);
    }

    // At this point we have a registry with data for this lane: check route snapshot before serving cache
    // so that dangling/missing-secret still fails closed (503/500) rather than silently serving stale cache.
    try {
      deps.state.resolveSnapshot(lane);
    } catch (e) {
      // Fall back to dispatch so the existing route-error handling (journal + 503/500) applies
      return dispatch(lane, suffix, new URL(req.url).search, req);
    }

    let snapForJournal: { accountId: string; alias: string } | null = null;
    try { const s = deps.state.resolveSnapshot(lane); snapForJournal = { accountId: s.accountId, alias: s.alias }; } catch {}

    // fresh cache -> serve immediately without upstream
    if (fresh) {
      const entry = deps.journal.begin({
        lane,
        selectedAccountId: snapForJournal?.accountId ?? null,
        selectedAccountAliasSnapshot: snapForJournal?.alias ?? null,
        method: req.method,
        endpointFamily: "models",
        terminalOutcome: "ok",
        httpStatus: 200,
        upstreamRequestIds: [],
        model: null,
        clientCorrelationId: correlationId ?? null,
      });
      const cached = serveModelsCache(lane, reg, "hit");
      cached.headers.set("x-gorouter-request-id", entry.routerRequestId);
      deps.journal.complete(entry, { completedAtUtc: utcNow(), durationMs: 0, terminalOutcome: "ok", httpStatus: 200, upstreamRequestIds: [] });
      return cached;
    }

    // stale cache -> trigger background refresh (single-flight) and immediately serve stale
    if (!cooldown) {
      const s = deps.state.read();
      refreshRegistry(paths, { upstreamGo: s.settings.upstreamGo, upstreamZen: s.settings.upstreamZen }).then(async (result) => {
        if (result.success && result.registry) {
          log.info(`models registry refreshed in background (${result.registry?.go?.models.length ?? 0} go, ${result.registry?.zen?.models.length ?? 0} zen)`);
          // Downstream DSH reconciliation (failure-isolated, non-blocking, single-flight inside).
          try {
            const client = createDshClient();
            const dshStatus = await reconcileDshCatalog(result.registry, client, { approvalStore: loadApprovalStore(paths), expectedPort: s.settings.port }, (st) => {
              try { storeDshSyncStatus(paths, st); } catch {}
            });
            if (dshStatus.outcome === "current") log.info(`dsh live catalog reconciled (${dshStatus.activeGoCount ?? 0} go, ${dshStatus.activeZenCount ?? 0} zen, withheld go=${dshStatus.withheldGoCount ?? 0} zen=${dshStatus.withheldZenCount ?? 0})`);
            else if (dshStatus.outcome !== "no-op") log.warn(`dsh sync pending: ${redact(dshStatus.lastError ?? dshStatus.outcome)}`);
          } catch (e) {
            log.warn(`dsh sync after background refresh failed (registry preserved): ${redact(e instanceof Error ? e.message : String(e))}`);
          }
        } else log.warn(`models background refresh failed: ${result.error}`);
      }).catch((e) => log.warn(`models background refresh failed: ${e instanceof Error ? e.message : String(e)}`));
    }
    {
      const entry = deps.journal.begin({
        lane,
        selectedAccountId: snapForJournal?.accountId ?? null,
        selectedAccountAliasSnapshot: snapForJournal?.alias ?? null,
        method: req.method,
        endpointFamily: "models",
        terminalOutcome: "ok",
        httpStatus: 200,
        upstreamRequestIds: [],
        model: null,
        clientCorrelationId: correlationId ?? null,
      });
      const cached = serveModelsCache(lane, reg, "stale");
      cached.headers.set("x-gorouter-request-id", entry.routerRequestId);
      deps.journal.complete(entry, { completedAtUtc: utcNow(), durationMs: 0, terminalOutcome: "ok", httpStatus: 200, upstreamRequestIds: [] });
      return cached;
    }
  }

  /** Slice B.1: fixed upstream authority, parsed once per settings value. */
  interface UpstreamParts {
    origin: string;
    basePathname: string;
  }
  interface UpstreamSlot {
    raw: string;
    parts: UpstreamParts;
  }
  const upstreamParseCache: { go: UpstreamSlot | null; zen: UpstreamSlot | null } = { go: null, zen: null };
  function parseUpstreamBase(rawBase: string): UpstreamParts {
    const u = new URL(rawBase);
    return { origin: u.origin, basePathname: u.pathname };
  }

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
      // Auth failures get the same traceable journal row + request id as every
      // other local failure (models path and route-error path already do this).
      const entry = deps.journal.begin({
        lane,
        selectedAccountId: null,
        selectedAccountAliasSnapshot: null,
        method: req.method,
        endpointFamily: classifyEndpointFamily(suffix),
        // Begin in the terminal state: a crash between begin/complete must
        // never leave a phantom "ok" row (journalReject does the same).
        terminalOutcome: "local_error",
        httpStatus: 401,
        upstreamRequestIds: [],
        model: null,
        clientCorrelationId: validateCorrelationId(req.headers.get("x-gorouter-correlation-id")) ?? null,
      });
      deps.journal.complete(entry, { completedAtUtc: utcNow(), durationMs: 0, terminalOutcome: "local_error", httpStatus: 401, upstreamRequestIds: [] });
      const res = localError(401, "GoRouterAuthError", "missing or invalid local client credential");
      res.headers.set("x-gorouter-request-id", entry.routerRequestId);
      return res;
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
    // Exactly-once finalization: the FIRST completion wins; later calls (an
    // async fetch rejection after the synchronous stop() abort completer, or a
    // wrapper finalize racing a client abort) are idempotent no-ops so the
    // journal row is never double-written and never written after close.
    let entryCompleted = false;
    const completeEntry = (
      terminalOutcome: TerminalOutcome,
      httpStatus: number | null,
      upstreamRequestIds: string[],
      durationMs: number,
    ): void => {
      if (entryCompleted) return;
      entryCompleted = true;
      deps.journal.complete(entry, {
        completedAtUtc: utcNow(),
        durationMs: Math.max(0, Math.round(durationMs)),
        terminalOutcome,
        httpStatus,
        upstreamRequestIds,
      });
    };
    // Slice B.1: the fixed upstream authority parses once per settings value,
    // not once per request (single state.read + amortized-zero URL parses).
    // Per-lane lazy: a garbage URL on the idle lane must not break the live
    // lane, exactly as before (only the requested lane parses).
    const st = deps.state.read();
    const rawBase = lane === "go" ? st.settings.upstreamGo : st.settings.upstreamZen;
    const slot = lane === "go" ? upstreamParseCache.go : upstreamParseCache.zen;
    const cached = slot !== null && slot.raw === rawBase ? slot : null;
    const parts = cached !== null
      ? cached.parts
      : parseUpstreamBase(rawBase);
    if (cached === null) {
      const fresh = { raw: rawBase, parts };
      if (lane === "go") upstreamParseCache.go = fresh;
      else upstreamParseCache.zen = fresh;
    }
    const base = rawBase;
    const upstreamUrl = new URL(base);
    const basePathname = parts.basePathname;
    // join base + suffix without a leading-slash artifact (root base "/" joined
    // with "/models" must stay "/models", never "//models")
    upstreamUrl.pathname = basePathname.endsWith("/")
      ? basePathname.slice(0, -1) + suffix
      : basePathname + suffix;
    // strip the local credential from query params if present (client misplacement).
    // Deliberately no entropy floor here (unlike the header/session substring
    // scans): a query-param delete has no innocent-id rotation/spam vector,
    // so exact-or-substring always strips.
    // Slice A.2: empty query (the common case) skips parse/serialize entirely.
    if (!search) {
      upstreamUrl.search = "";
    } else {
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
    }
    if (upstreamUrl.origin !== parts.origin) {
      log.error(`refusing upstream URL outside fixed authority (lane=${lane})`);
      completeEntry("local_error", 500, [], monotonicMs() - started);
      const res = localError(500, "GoRouterRouteError", "upstream authority mismatch");
      res.headers.set("x-gorouter-request-id", entry.routerRequestId);
      return res;
    }

    // path namespace check: encoded traversal payloads (e.g. %2e%2e, %2f, %5c)
    // survive URL parsing verbatim but would escape the lane base once an
    // upstream decodes them; reject before any upstream bytes are sent
    if (!isPathWithinLaneBase(upstreamUrl.pathname, basePathname)) {
      completeEntry("local_error", 400, [], monotonicMs() - started);
      const res = localError(400, "GoRouterRouteError", "upstream path outside lane namespace");
      res.headers.set("x-gorouter-request-id", entry.routerRequestId);
      return res;
    }

    // endpoint-family-specific credential injection (validated upstream surface)
    const authFamily = classifyAuthFamily(suffix);
    const forwardHeaders = sanitizeForwardHeaders(req.headers);
    // defense: arbitrary client headers whose value contains the local credential
    // are stripped so they never reach the pinned OpenCode authority
    for (const [name, value] of [...forwardHeaders]) {
      // Exact equality always strips (even for short/test credentials);
      // only the SUBSTRING scan is gated on the entropy floor.
      if (value === localCred || (localCred.length >= MIN_SUBSTRING_SECRET_LENGTH && value.includes(localCred))) {
        log.warn(`local credential stripped from forwarded header ${name} (lane=${lane})`);
        forwardHeaders.delete(name);
      }
    }
    // OpenCode requires x-opencode-session (one stable id per conversation):
    // resolve first, then apply the same credential-containment rule as every
    // other forwarded header — the raw inbound value must not be re-introduced
    // after stripping. Replaced (never deleted) on match, so upstream never
    // sees a missing header.
    const { sessionId, replaced } = resolveUpstreamSessionIdSafe(
      req.headers.get(OPENCODE_SESSION_HEADER),
      correlationId,
      localCred,
      [snapshot.secret],
    );
    if (replaced) {
      log.warn(`local credential stripped from forwarded header ${OPENCODE_SESSION_HEADER} (lane=${lane})`);
    }
    forwardHeaders.set(OPENCODE_SESSION_HEADER, sessionId);
    forwardHeaders.set(
      authHeaderForFamily(authFamily),
      authFamily === "bearer" ? `Bearer ${snapshot.secret}` : snapshot.secret,
    );
    forwardHeaders.set("host", upstreamUrl.host);

    const reqSignal = (req as Request & { signal?: AbortSignal }).signal;
    // Finalize the entry SYNCHRONOUSLY on signal abort: stop() aborts the
    // request controllers directly and AbortController listeners fire
    // synchronously, so a caller that closes the journal immediately after
    // stop() must not race a pending dispatch's async fetch rejection.
    const syncAbortCompleter = (): void => {
      completeEntry("client_abort", null, [], monotonicMs() - started);
    };
    if (reqSignal) {
      if (reqSignal.aborted) syncAbortCompleter();
      else reqSignal.addEventListener("abort", syncAbortCompleter, { once: true });
    }

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
      const reqSignal = (req as Request & { signal?: AbortSignal }).signal;
      reqSignal?.removeEventListener("abort", syncAbortCompleter);
      if (reqSignal?.aborted) {
        // client went away while the upstream response was still pending; the
        // response is undeliverable, but journal the abort as such
        log.debug(`client aborted before upstream response lane=${lane} id=${entry.routerRequestId}`);
        completeEntry("client_abort", null, [], monotonicMs() - started);
        const res = localError(502, "GoRouterUpstreamError", "upstream OpenCode request failed");
        res.headers.set("x-gorouter-request-id", entry.routerRequestId);
        return res;
      }
      log.warn(`upstream fetch failed lane=${lane} id=${entry.routerRequestId}: ${e instanceof Error ? e.message : e}`);
      completeEntry("upstream_error", 502, [], monotonicMs() - started);
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
      reqSignal?.removeEventListener("abort", syncAbortCompleter);
      const terminalOutcome: TerminalOutcome =
        mode === "aborted" ? "client_abort" : mode === "error" ? "upstream_error" : outcome;
      completeEntry(terminalOutcome, upstreamRes.status, upstreamRequestIds, monotonicMs() - started);
    };

    // Bodyless responses (204/304/empty 200) must still terminalize the journal:
    // there is no stream to observe, so finalize immediately.
    if (upstreamRes.body === null) {
      finalize("completed");
      return new Response(null, { status: upstreamRes.status, headers: outHeaders });
    }

    const body = wrapBodyWithFinalize(upstreamRes.body, finalize, (req as Request & { signal?: AbortSignal }).signal);
    // The wrapper now owns abort finalization and knows the response status;
    // detach the pending-dispatch completer so it cannot pre-empt with a
    // null status (a mid-stream abort must journal client_abort/200, not null).
    reqSignal?.removeEventListener("abort", syncAbortCompleter);
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
    if (suffix === "/models") {
      return handleModels(lane, suffix, req);
    }
    if (suffix.length === 0) {
      return localError(404, "GoRouterRouteError", "unsupported local path; expected /go/v1/<path> or /zen/v1/<path>");
    }
    if (suffix.includes("//") || suffix.includes("\\")) {
      return localError(400, "GoRouterRouteError", "malformed local path");
    }
    // fail closed on malformed percent-escapes (e.g. %zz) before dispatch;
    // encoded traversal content itself is rejected at dispatch with a journal row
    let decodedSuffix = suffix;
    for (let i = 0; i < 3; i++) {
      // stop when no valid percent-encoding remains (a literal '%' from %25
      // is legal and must not be re-decoded)
      if (!/%[0-9a-f]{2}/i.test(decodedSuffix)) break;
      try {
        decodedSuffix = decodeURIComponent(decodedSuffix);
      } catch {
        return localError(400, "GoRouterRouteError", "malformed local path");
      }
    }
    return dispatch(lane, suffix, url.search, req);
  };

  return {
    serve() {
      const st = deps.state.read();
      const host = st.settings.host;
      const port = st.settings.port;

      const journalReject = (rawTarget: string, reason: string, method?: string, httpStatus?: number, correlationId?: string | null) => {
        // Create a synthetic journal entry for the rejected request.
        // The correlation id rides in from inbound (D-12, validated there);
        // absent when the client sent none.
        const cid = correlationId ?? null;
        const rejectedPath = rawTarget.split("?")[0] ?? "";
        // Lane derived from the raw target path prefix with an explicit go
        // check: targets with NO lane prefix (e.g. chunked POST to /foo) must
        // not be mislabeled "go" — journal provenance stays honest.
        const rejectedLane = rejectedPath === "/go/v1" || rejectedPath.startsWith("/go/v1/")
          ? "go"
          : rejectedPath === "/zen/v1" || rejectedPath.startsWith("/zen/v1/")
            ? "zen"
            : "unknown";
        const entry = deps.journal.begin({
          lane: rejectedLane,
          selectedAccountId: null,
          selectedAccountAliasSnapshot: null,
          method: method ?? 'GET', // default; actual method unknown
          endpointFamily: 'unknown',
          terminalOutcome: 'local_error',
          httpStatus: httpStatus ?? 400,
          upstreamRequestIds: [],
          model: null,
          clientCorrelationId: cid,
        });
        deps.journal.complete(entry, {
          completedAtUtc: utcNow(),
          durationMs: 0,
          terminalOutcome: 'local_error',
          httpStatus: httpStatus ?? 400,
          upstreamRequestIds: [],
        });
        // The raw target may carry a known credential (the local key, a lane
        // account key — possibly percent-encoded by a hostile client echoing
        // it into a query). Redact every known secret VALUE from the DECODED
        // target (decoding resolves encoded forms), then apply the shape
        // redactor for other secret families. Never log credentials verbatim.
        const knownSecrets: string[] = [];
        try {
          const localCred = deps.state.localCredential();
          if (localCred.length > 0) knownSecrets.push(localCred);
        } catch { /* local credential unconfigured */ }
        for (const lane of ["go", "zen"] as const) {
          try {
            const snap = deps.state.resolveSnapshot(lane);
            if (snap.secret.length > 0) knownSecrets.push(snap.secret);
          } catch { /* no route or missing secret */ }
        }
        let loggedTarget = rawTarget;
        // permissive decode: iteratively resolve runs of VALID percent-escapes
        // as UTF-8 bytes (so percent-encoded Unicode and double-encoded
        // credentials resolve to their literal text), leaving malformed
        // escapes (e.g. %zz) and already-literal Unicode untouched —
        // decodeURIComponent would throw on a malformed escape and skip the
        // redaction entirely.
        for (let i = 0; i < 5; i++) {
          const prev = loggedTarget;
          loggedTarget = loggedTarget.replace(/(?:%[0-9a-f]{2})+/gi, (m) =>
            Buffer.from(m.replace(/%/g, ""), "hex").toString("utf8"),
          );
          if (loggedTarget === prev) break;
        }
        // longest secrets first: replacing a short value first would destroy a
        // longer overlapping match and leak its suffix
        knownSecrets.sort((a, b) => b.length - a.length);
        for (const secret of knownSecrets) {
          loggedTarget = loggedTarget.split(secret).join("<redacted>");
        }
        loggedTarget = redact(loggedTarget);
        log.warn(`raw-target validation rejected: ${reason} (target: ${loggedTarget})`);
      };

      server = createInboundHttpServer(handler, { hostname: host, port }, journalReject);
      const addr = server.address();
      const actualPort = addr && typeof addr === 'object' ? addr.port : 0;
      log.info(`GoRouter V1 listening on http://${host}:${actualPort} (go/v1, zen/v1)`);
      // Slice A startup trigger: if registry absent/stale and not in cooldown, background refresh
      // Disabled in tests (startupRefresh===false) so per-test upstream request counts stay deterministic.
      if (deps.startupRefresh !== false) {
        try {
          const startupPaths = deps.paths ?? resolvePaths();
          const sForStartup = deps.state.read();
          const maybe = maybeRefreshOnStartup(startupPaths, sForStartup.settings.upstreamGo, sForStartup.settings.upstreamZen);
          if (maybe) {
            maybe.then(async (result) => {
              if (result?.success && result.registry) {
                try {
                  const client = createDshClient();
                  const st = await reconcileDshCatalog(result.registry, client, { approvalStore: loadApprovalStore(startupPaths), expectedPort: sForStartup.settings.port }, (d) => {
                    try { storeDshSyncStatus(startupPaths, d); } catch {}
                  });
                  if (st.outcome === "current") log.info(`dsh live catalog reconciled on startup (${st.activeGoCount ?? 0} go, ${st.activeZenCount ?? 0} zen)`);
                } catch (e) {
                  log.warn(`dsh sync on startup failed (registry preserved): ${redact(e instanceof Error ? e.message : String(e))}`);
                }
              }
            }).catch((e) => log.warn(`dsh sync on startup failed: ${e instanceof Error ? e.message : String(e)}`));
          }
        } catch (e) {
          log.warn(`models startup trigger skipped: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    },
    port() {
      const addr = server?.address();
      return (addr && typeof addr === 'object') ? addr.port : 0;
    },
    stop() {
      // Restore the Bun.serve force-close shutdown semantics. Force-close
      // order matters on Bun 1.3.14: closeAllConnections() BEFORE close()
      // (the reverse is a no-op). Active request controllers are aborted
      // FIRST so the response wrappers finalize their journal rows
      // synchronously (AbortController listeners fire synchronously) — a
      // caller that closes the journal immediately after stop() must not race
      // the finalization.
      const srv = server;
      server = null;
      if (srv) {
        const controllers = (srv as unknown as { __gorouterActiveControllers?: Set<AbortController> }).__gorouterActiveControllers;
        if (controllers) {
          for (const ac of [...controllers]) ac.abort();
        }
        try { srv.closeAllConnections(); } catch { /* API unavailable */ }
        srv.close();
      }
    },
  };
}