/**
 * GoRouter V1 — inbound HTTP transport adapter.
 *
 * Validates the raw HTTP request-target BEFORE WHATWG URL normalization,
 * blocking path traversal attacks that would cross lane boundaries.
 *
 * Architecture: node:http.createServer → validate raw target → construct
 * web Request → call existing handler → stream Response back.
 */
import {
  createServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { Socket } from "node:net";

/**
 * Maximum admitted request-body size (declared or streamed). 25 MiB is
 * generous for legitimate vision/base64 chat payloads while bounding router
 * RAM against giant Content-Length POSTs from any local process. Larger
 * bodies are rejected 413 before a single byte is buffered.
 */
export const MAX_REQUEST_BODY_BYTES = 25 * 1024 * 1024;

/** Idle window while reading a held request body: no bytes for this long
 * means a trickling sender holding the connection — give up and destroy it.
 * (server.requestTimeout stays 0 to preserve long-gap response streaming.) */
const BODY_IDLE_TIMEOUT_MS = 30_000;
let bodyIdleTimeoutMs = BODY_IDLE_TIMEOUT_MS;

/** Test hook (precedent: clearDshSyncSingleFlightForTests): shrink the body
 * idle window. Callers must restore with resetInboundBodyIdleTimeoutForTests. */
export function setInboundBodyIdleTimeoutForTests(ms: number): void {
  if (!Number.isFinite(ms) || ms <= 0) throw new Error(`invalid test idle timeout: ${String(ms)}`);
  bodyIdleTimeoutMs = ms;
}

export function resetInboundBodyIdleTimeoutForTests(): void {
  bodyIdleTimeoutMs = BODY_IDLE_TIMEOUT_MS;
}

/**
 * Dot-segment core: a segment is traversal-capable when its semicolon-
 * parameter core is `.` or `..` (e.g. `..;foo`, `.;bar`). Matrix-parameter-
 * aware backends may strip parameters and then resolve the dot segment, so
 * param-dot segments are treated exactly like their bare dot equivalents.
 */
function dotCore(seg: string): "." | ".." | null {
  const core = seg.split(";")[0];
  if (core === ".") return ".";
  if (core === "..") return "..";
  return null;
}

/**
 * Resolve dot segments (`.` and `..`, including semicolon-parameter forms)
 * in an absolute path, mirroring the WHATWG URL path-resolution semantics
 * for the router's lane check.
 */
function resolveDotSegments(path: string): string {
  const segments = path.split("/");
  const resolved: string[] = [];
  for (const seg of segments) {
    if (seg === "") continue;
    const core = dotCore(seg);
    if (core === ".") continue;
    if (core === "..") {
      if (resolved.length > 0) resolved.pop();
    } else {
      resolved.push(seg);
    }
  }
  return "/" + resolved.join("/");
}

/**
 * Validate the raw HTTP request-target BEFORE WHATWG URL normalization.
 *
 * Contract (F-01 raw-prefix lane integrity):
 * - Reject absolute-form (http://, https://) and asterisk-form (*).
 * - Reject backslash (raw or decoded).
 * - Reject ENCODED double-slash (introduced by decoding, not literal): a
 *   literal `//` is left for the handler's suffix check (400, no journal).
 * - Reject ENCODED `..` (not literal in the raw target): these are
 *   traversal payloads that the handler's normalized check cannot see.
 * - Literal `..` segments: resolve dot segments and reject only if the
   * resolved path escapes the lane base (cross-lane traversal). In-namespace
   * dot segments (e.g. /go/v1/x/.. -> /go/v1) are allowed and normalized by
   * the handler.
 * - No lane prefix: NOT rejected here; the handler returns 404.
 */
export function validateRawTarget(rawTarget: string): { valid: boolean; reason?: string } {
  // Split path and query on first '?'
  const qIndex = rawTarget.indexOf("?");
  const path = qIndex === -1 ? rawTarget : rawTarget.slice(0, qIndex);

  // Reject absolute-form (case-insensitive: HTTP:// and HTTPs:// too)
  if (/^https?:\/\//i.test(path)) {
    return { valid: false, reason: "absolute-form not allowed" };
  }

  // Reject asterisk-form
  if (path === "*") {
    return { valid: false, reason: "asterisk-form not allowed" };
  }

  // Determine lane base from the raw path (exact prefix boundary so that
  // /go/v12 is NOT classified as the /go/v1 lane)
  const laneBase =
    path === "/go/v1" || path.startsWith("/go/v1/")
      ? "/go/v1"
      : path === "/zen/v1" || path.startsWith("/zen/v1/")
        ? "/zen/v1"
        : null;

  // Count the RAW path's literal `..`-core segments (incl. `..;param`). At
  // each decode level, if MORE `..`-core segments appear than were literal in
  // the raw path, some came from decoding (encoded traversal) — reject.
  const rawDotDotCount = path.split("/").filter((s) => dotCore(s) === "..").length;

  // Reject malformed percent-encoding in the raw target: a '%' not followed
  // by two hex digits (e.g. %zz, a trailing %). A literal '%' produced by
  // decoding %25 is legal and must not be re-decoded.
  for (let i = 0; i < path.length; i++) {
    if (path[i] === "%" && !/^[0-9a-f]{2}$/i.test(path.slice(i + 1, i + 3))) {
      return { valid: false, reason: "malformed percent-encoding" };
    }
  }

  // Iteratively decode (up to 3 passes), checking traversal after each level.
  // The checks run on the CURRENT value (raw first, then each decode level);
  // decoding stops when no valid percent-encoding remains so a literal '%'
  // (from decoding %25) is never re-decoded.
  let decoded = path;
  for (let i = 0; i < 3; i++) {
    // Check for backslash (always rejected)
    if (decoded.includes("\\")) {
      return { valid: false, reason: "backslash in path" };
    }

    // Check for encoded double-slash (introduced by decoding, not literal)
    if (decoded.includes("//") && !path.includes("//")) {
      return { valid: false, reason: "encoded double slash in path" };
    }

    // Check for dot-core segments (`.`, `..`, and `.;`/`..;` parameter forms)
    const decodedHasDot = decoded.split("/").some((s) => dotCore(s) !== null);
    if (decodedHasDot) {
      if (laneBase === null) {
        // No raw lane prefix: after WHATWG normalization, dot segments could
        // cause the target to enter a lane (e.g. /./go/v1/... or
        // /foo/../go/v1/... -> /go/v1/...), so reject conservatively.
        return { valid: false, reason: "dot-segment path without lane prefix" };
      }
      const decodedDotDotCount = decoded.split("/").filter((s) => dotCore(s) === "..").length;
      if (decodedDotDotCount > 0) {
        if (decodedDotDotCount > rawDotDotCount) {
          // Some `..`-core segment appeared only after decoding: encoded
          // traversal — always rejected, even when other `..` were literal
          // (e.g. /go/v1/a/../b/%2e%2e/c mixes both forms).
          return { valid: false, reason: "encoded path traversal" };
        }
        // All decoded `..`-core segments are literal in the raw path: resolve
        // dot segments and check lane containment; reject cross-lane escapes.
        const resolved = resolveDotSegments(decoded);
        if (resolved !== laneBase && !resolved.startsWith(laneBase + "/")) {
          return { valid: false, reason: "path traversal outside lane" };
        }
      }
      // In-lane `.`-core segments (literal or encoded, no `..`): allowed —
      // they normalize within the lane and cannot cross lanes.
    }

    // Decode one more level if a valid percent-encoding remains; a literal
    // '%' (from %25) or a fully decoded path stops the loop.
    if (!/%[0-9a-f]{2}/i.test(decoded)) break;
    const prev = decoded;
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      return { valid: false, reason: "malformed percent-encoding" };
    }
    if (decoded === prev) break;
  }

  // Defense-in-depth: if the bounded decode loop ended with ANY remaining
  // percent-encoding (e.g. 5-level %252525252e leaves %252e after 3 passes),
  // the nesting is deeper than the loop bound. No standard server decodes a
  // request-target more than once, so multi-level nesting is an attack payload
  // rather than a legitimate path — reject.
  if (/%[0-9a-f]{2}/i.test(decoded)) {
    return { valid: false, reason: "excessive nested encoding" };
  }

  return { valid: true };
}

/**
 * Read a content-length request body while holding the IncomingMessage open.
 *
 * Bun 1.3.14's node:http only surfaces client disconnects while the request
 * stream is still open: once a body is fully consumed ('end'/'close' fired)
 * the socket stops flowing and no 'aborted'/'close' event is ever delivered.
 * Reading via 'data' events and pausing the stream once the declared length
 * is received keeps the message technically incomplete, so a downstream
 * disconnect still fires 'aborted' and socket 'close' (proven). The buffered
 * bytes become the web Request body.
 */
/**
 * Content-Length wire grammar: a bare non-negative integer token. Anything
 * else present (text, sign, embedded whitespace, multi-value array) is a
 * framing lie — callers fail the request closed rather than guessing.
 */
export function isWellFormedContentLength(raw: unknown): boolean {
  return typeof raw === "string" && /^\d+$/.test(raw);
}

/** Thrown when a request body exceeds MAX_REQUEST_BODY_BYTES (413, not a crash). */
export class RequestBodyTooLargeError extends Error {
  readonly bytes: number;
  constructor(bytes: number) {
    super(`request body too large (${bytes} > ${MAX_REQUEST_BODY_BYTES} bytes)`);
    this.name = "RequestBodyTooLargeError";
    this.bytes = bytes;
  }
}

/**
 * Consume a Connection:close request body with a byte cap (A1). Close-
 * declared requests cannot use the held (pause-at-length) path: a post-body
 * FIN surfaces as 'aborted' on the still-open stream and Bun destroys the
 * socket pre-response. But streaming the raw message bypassed the size cap.
 * Measured framing behavior (Bun 1.3.14 node:http): the stream yields exactly
 * the declared bytes and 'end' for exact bodies, but ALSO emits flood bytes
 * past a lying declaration — while the parser independently kills the socket
 * on the pipeline garbage. So: resolve at the declaration (prompt dispatch
 * wins the race exactly like the old streaming path), slice exact, drain the
 * tail into the void, and keep a hard cap + idle kill as backstops. Upstream
 * never receives more than the declared length; the router never buffers more
 * than the cap.
 */
function readCloseBody(req: IncomingMessage, cap: number, stopAt: number): Promise<Uint8Array> {
  return new Promise<Uint8Array>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const idle = { current: null as unknown as ReturnType<typeof setTimeout> | null };
    const armIdle = () => {
      const t = setTimeout(() => {
        if (settled) return;
        cleanup();
        req.destroy();
        reject(new Error("client body stalled past the idle window"));
      }, bodyIdleTimeoutMs);
      (t as unknown as { unref?: () => void }).unref?.();
      return t;
    };
    const cleanup = () => {
      if (settled) return;
      settled = true;
      if (idle.current) clearTimeout(idle.current);
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("aborted", onAbort);
      req.off("error", onError);
    };
    const onData = (chunk: Buffer) => {
      chunks.push(chunk);
      total += chunk.length;
      // Pathological parser variance: more bytes than the whole cap with no
      // end in sight — 413 like the declared path.
      if (total > cap) {
        cleanup();
        // Pause (do NOT destroy): the caller answers 413 on this same socket
        // and destroys after flush, so the client reads a clean response.
        req.pause();
        reject(new RequestBodyTooLargeError(total));
        return;
      }
      // Declared length reached: resolve promptly (wins the parser-kill race
      // like the old streaming path), drain the lying tail into the void.
      if (total >= stopAt) {
        cleanup();
        req.resume();
        resolve(Buffer.concat(chunks).slice(0, stopAt));
        return;
      }
      if (idle.current) clearTimeout(idle.current);
      idle.current = armIdle();
    };
    const onEnd = () => {
      cleanup();
      resolve(Buffer.concat(chunks));
    };
    const onAbort = () => {
      cleanup();
      reject(new Error("client aborted mid-request body"));
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    idle.current = armIdle();
    req.on("data", onData);
    req.once("end", onEnd);
    req.once("aborted", onAbort);
    req.once("error", onError);
  });
}

function readHeldBody(
  req: IncomingMessage,
  contentLength: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  if (signal.aborted) {
    // abort already fired before listeners were attached; AbortSignal does
    // not replay events to late listeners
    return Promise.reject(new Error("client aborted mid-request body"));
  }
  if (contentLength === 0) {
    req.pause(); // hold 'end' for empty bodies too, preserving abort detection
    return Promise.resolve(new Uint8Array(0));
  }
  return new Promise<Uint8Array>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    // unref: a held body must never pin the event loop / delay process exit.
    const armIdle = () => {
      const t = setTimeout(() => {
        if (settled) return;
        cleanup();
        reject(new Error("client body stalled past the idle window"));
      }, bodyIdleTimeoutMs);
      (t as unknown as { unref?: () => void }).unref?.();
      return t;
    };
    let idleTimer = armIdle();
    const cleanup = () => {
      if (settled) return;
      settled = true;
      clearTimeout(idleTimer);
      req.off("data", onData);
      req.off("aborted", onAbort);
      req.off("error", onError);
      signal.removeEventListener("abort", onAbort);
    };
    const onData = (chunk: Buffer) => {
      chunks.push(chunk);
      total += chunk.length;
      if (total >= contentLength) {
        req.pause(); // hold 'end' so client-abort detection stays alive
        cleanup();
        // Slice to the declaration: a sender must not smuggle an extra TCP
        // chunk past the framed length into the forwarded body.
        resolve(Buffer.concat(chunks).slice(0, contentLength));
        return;
      }
      clearTimeout(idleTimer);
      idleTimer = armIdle();
    };
    const onAbort = () => {
      cleanup();
      reject(new Error("client aborted mid-request body"));
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    req.on("data", onData);
    req.once("aborted", onAbort);
    req.once("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Create an inbound HTTP server that validates raw request-targets before
 * passing to the handler.
 *
 * @param handler - The existing request handler (web Request → web Response)
 * @param opts - Server bind options (hostname, port)
 * @param journalReject - Callback to journal rejected requests
 * @returns The node:http server (already listening)
 */
export function createInboundHttpServer(
  handler: (req: Request) => Promise<Response>,
  opts: { hostname: string; port: number },
  journalReject: (rawTarget: string, reason: string, method?: string, httpStatus?: number) => void,
): Server {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const rawTarget = req.url ?? "/";

    // Refuse any further request on a connection that already carried rejected
    // framing (pipelined bytes the parser had already buffered).
    if (terminatedSockets.has(req.socket)) {
      res.writeHead(400, { "content-type": "application/json", connection: "close" });
      res.end(JSON.stringify({
        error: { type: "GoRouterRouteError", message: "connection terminated after rejected framing" },
      }));
      return;
    }

    // Chunked/unknown-framing request bodies cannot be held for client-abort
    // detection on Bun 1.3.14 node:http (the IncomingMessage completes and the
    // socket stops flowing; no 'aborted'/'close' is delivered afterwards). Per
    // the architecture decision (REJECT_UNSAFE_CHUNKED_REQUEST_BODIES), reject
    // such framing 400 before consumption — the client-abort invariant is
    // preserved by never admitting unsafe framing. Applies to any method and
    // runs BEFORE raw-target validation so a rejected connection is always
    // terminated (Connection: close + gate), never left alive for a pipelined
    // follow-up to dispatch.
    if (req.headers["transfer-encoding"] !== undefined) {
      journalReject(rawTarget, "chunked request bodies are not supported", req.method ?? "GET");
      // Connection: close — the chunked body may still be arriving; the
      // response is flushed, then the socket closes, discarding the unread
      // framing so a keep-alive connection cannot desynchronize.
      res.writeHead(400, {
        "content-type": "application/json",
        connection: "close",
      });
      res.end(JSON.stringify({
        error: { type: "GoRouterRouteError", message: "chunked request bodies are not supported" },
      }));
      // Terminate the connection: mark it so any pipelined request already
      // buffered by the parser is refused at entry, and close once the 400 is
      // flushed so the client reads a clean response before the FIN.
      terminatedSockets.add(req.socket);
      res.once("finish", () => req.socket.destroy());
      return;
    }

    // Validate raw target
    const validation = validateRawTarget(rawTarget);
    if (!validation.valid) {
      journalReject(rawTarget, validation.reason ?? "invalid", req.method ?? "GET");
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({
        error: { type: "GoRouterRouteError", message: `invalid request target: ${validation.reason}` },
      }));
      return;
    }

    // Construct web Request from IncomingMessage. IPv6 hostnames (e.g. ::1)
    // must be bracketed in the URL authority.
    const urlHost = opts.hostname.includes(":") ? `[${opts.hostname}]` : opts.hostname;
    const url = `http://${urlHost}:${opts.port}${rawTarget}`;
    const method = req.method ?? "GET";

    // Convert headers
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (value === undefined) continue;
      if (Array.isArray(value)) {
        for (const v of value) headers.append(key, v);
      } else {
        headers.set(key, value);
      }
    }

    // Client abort detection. Bun 1.3.14's node:http fires IncomingMessage
    // "close" at request-MESSAGE completion (not only on disconnect), and
    // socket "close" fires on a graceful request-side FIN (half-close) too —
    // either would misclassify ordinary requests as client aborts. The
    // abort-only signal is "aborted" on req: it fires for fetch-style aborts
    // (RST), raw-socket destroys, and any disconnect while the request stream
    // is still open (held content-length bodies keep it open). Guarded by
    // responseComplete.
    const abortController = new AbortController();
    activeControllers.add(abortController);
    let responseComplete = false;
    const onClientAbort = () => {
      if (!responseComplete) abortController.abort();
    };
    // Connection: close clients may gracefully FIN right after the request; on
    // Bun 1.3.14 that FIN surfaces as 'aborted' on the still-open stream and
    // would misclassify the request as a client abort. The client declared
    // close, so abort detection is disabled for these requests (the response
    // is processed and journaled normally).
    if (!/close/i.test(req.headers["connection"] ?? "")) {
      req.on("aborted", onClientAbort);
    }

    // Convert body.
    //
    // Bun 1.3.14's node:http stops surfacing client disconnects once a request
    // body is fully consumed: draining the IncomingMessage (via Readable.toWeb)
    // closes it and no 'aborted' is ever delivered afterwards. For content-length
    // bodies, read via 'data' events and PAUSE the stream once the declared
    // length is received — the message stays technically incomplete, so
    // 'aborted' still fires when the client disconnects (proven). The buffered
    // bytes become the body. Chunked framing is rejected before this point.
    //
    // Connection: close clients may gracefully half-close (FIN) right after
    // sending the request; on Bun 1.3.14 a held-open stream makes that FIN
    // surface as 'aborted' and destroys the socket before the response can be
    // sent. For declared-close requests, stream the body normally instead —
    // once the message is consumed the FIN is inert — and accept that per-
    // request abort detection is unavailable for that single request (the
    // connection is closing anyway).
    //
    // The web Request model forbids GET/HEAD bodies, so a positive
    // content-length on GET/HEAD is rejected pre-dispatch rather than
    // forwarded (the declared body cannot be represented).
    let body: Uint8Array | ReadableStream<Uint8Array> | null = null;
    // A present-but-malformed Content-Length (non-numeric, negative, or a
    // multi-value array) leaves unread framing on a reusable connection — a
    // keep-alive desync primitive. Fail closed like every other framing
    // reject: 400 + close + gate, never dispatch with body=null. (Bun's
    // parser rejects most malformed values before this runs; this is the
    // backstop for runtimes/array forms that pass through.)
    const rawContentLength: unknown = req.headers["content-length"];
    if (rawContentLength !== undefined) {
      if (!isWellFormedContentLength(rawContentLength)) {
        journalReject(rawTarget, "invalid content-length header", method);
        res.writeHead(400, { "content-type": "application/json", connection: "close" });
        res.end(JSON.stringify({
          error: { type: "GoRouterRouteError", message: "invalid content-length header" },
        }));
        activeControllers.delete(abortController);
        terminatedSockets.add(req.socket);
        res.once("finish", () => req.socket.destroy());
        return;
      }
    }
    const contentLength = Number(req.headers["content-length"] ?? NaN);
    if (Number.isFinite(contentLength) && contentLength > 0) {
      if (method === "GET" || method === "HEAD") {
        journalReject(rawTarget, "GET/HEAD request bodies are not supported", method);
        res.writeHead(400, { "content-type": "application/json", connection: "close" });
        res.end(JSON.stringify({
          error: { type: "GoRouterRouteError", message: "GET/HEAD request bodies are not supported" },
        }));
        activeControllers.delete(abortController);
        terminatedSockets.add(req.socket);
        res.once("finish", () => req.socket.destroy());
        return;
      }
      if (contentLength > MAX_REQUEST_BODY_BYTES) {
        journalReject(rawTarget, `request body too large (${contentLength} > ${MAX_REQUEST_BODY_BYTES})`, method, 413);
        res.writeHead(413, { "content-type": "application/json", connection: "close" });
        res.end(JSON.stringify({
          error: { type: "GoRouterRouteError", message: `request body too large (limit ${MAX_REQUEST_BODY_BYTES} bytes)` },
        }));
        activeControllers.delete(abortController);
        terminatedSockets.add(req.socket);
        res.once("finish", () => req.socket.destroy());
        return;
      }
      if (/close/i.test(req.headers["connection"] ?? "")) {
        // Capped consume: streaming the close-path raw bypassed the size
        // bound. Over-cap raises RequestBodyTooLargeError and answers 413
        // like the declared path.
        try {
          body = await readCloseBody(req, MAX_REQUEST_BODY_BYTES, contentLength);
        } catch (e) {
          activeControllers.delete(abortController);
          if (e instanceof RequestBodyTooLargeError) {
            journalReject(rawTarget, e.message, method, 413);
            res.writeHead(413, { "content-type": "application/json", connection: "close" });
            res.end(JSON.stringify({
              error: { type: "GoRouterRouteError", message: `request body too large (limit ${MAX_REQUEST_BODY_BYTES} bytes)` },
            }));
            terminatedSockets.add(req.socket);
            res.once("finish", () => req.socket.destroy());
            return;
          }
          // client aborted mid-body (or body read error); connection is gone
          res.destroy();
          return;
        }
      } else {
        try {
          body = await readHeldBody(req, contentLength, abortController.signal);
        } catch {
          // client aborted mid-body (or body read error); connection is gone
          activeControllers.delete(abortController);
          res.destroy();
          return;
        }
      }
    }

    // Construct web Request
    const webReq = new Request(url, {
      method,
      headers,
      body,
      duplex: body instanceof ReadableStream ? "half" : undefined,
      signal: abortController.signal,
    });

    try {
      // Call handler
      const webRes = await handler(webReq);

      // Write status and headers
      const responseHeaders: Record<string, string> = {};
      webRes.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });
      res.writeHead(webRes.status, responseHeaders);

      // Stream response body with backpressure
      if (webRes.body) {
        const reader = webRes.body.getReader();
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            if (value) {
              const canWrite = res.write(value);
              if (!canWrite) {
                // Client may have disconnected while the write buffer was
                // full; do not wait for a drain that will never come.
                if (res.destroyed || !res.writable) {
                  abortController.abort();
                  break;
                }
                // Wait for drain (backpressure) or close (client abort)
                await new Promise<void>((resolve) => {
                  res.once("drain", resolve);
                  res.once("close", resolve);
                });
                if (res.destroyed || !res.writable) {
                  abortController.abort();
                  break;
                }
              }
            }
          }
        } catch (err) {
          // Client disconnected or read error
          abortController.abort();
        }
      }

      res.end();
      responseComplete = true;
      activeControllers.delete(abortController);
    } catch (err) {
      // Handler threw (or client aborted mid-stream)
      activeControllers.delete(abortController);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({
          error: "GoRouterInternalError",
          message: "internal server error",
        }));
      } else {
        // Headers already sent, just destroy the connection
        res.destroy();
      }
    }
  });

  // Track connections that carried rejected framing: any further request
  // already buffered by the parser on such a connection is refused at handler
  // entry (the rejection terminates the connection; see the chunked-rejection
  // branch). Entries are removed when the socket closes.
  const terminatedSockets = new Set<Socket>();
  server.on("connection", (sock) => {
    sock.on("close", () => terminatedSockets.delete(sock));
  });

  // Track per-request abort controllers so stop() can abort them directly:
  // AbortController fires its listeners SYNCHRONOUSLY, which lets the
  // response wrapper finalize the journal row before stop() returns — the
  // socket-destruction path ('aborted' events) is async and would race a
  // caller that closes the journal immediately after stop().
  const activeControllers = new Set<AbortController>();
  (server as unknown as { __gorouterActiveControllers?: Set<AbortController> }).__gorouterActiveControllers = activeControllers;

  // Parser-level rejections (malformed Transfer-Encoding codings such as gzip
  // or parameterized chunked, TE+Content-Length conflicts, malformed request
  // lines) never reach the request callback. Bun 1.3.14 sends its own bare
  // 400 + Connection: close for these, and a clientError listener cannot
  // deliver an app response (writes from the listener vanish on 1.3.14), so no
  // listener is installed: the parser's visible 400 is preserved. Such
  // parser-level rejections produce NO journal row (documented limitation —
  // the request never reaches the app). Valid `Transfer-Encoding: chunked`
  // requests DO reach the callback and are journaled by the rejection above.

  // Configure timeouts for long-gap streaming
  server.keepAliveTimeout = 60000; // idle keep-alive connections survive >14s gaps
  server.requestTimeout = 0; // disable request timeout
  server.headersTimeout = 60000; // keep 60s headers timeout

  // Start listening
  server.listen(opts.port, opts.hostname);

  return server;
}
