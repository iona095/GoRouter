/**
 * GoRouter V1 — shared utilities: redaction, logging, atomic file writes,
 * monotonic timing, safe header handling.
 */

// ---------------------------------------------------------------------------
// Logging — never contains credentials. All log lines are redacted through
// this helper so a future call site cannot accidentally add a secret.
// ---------------------------------------------------------------------------

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export class Logger {
  private minLevel: number;
  constructor(minLevel: LogLevel = "info") {
    this.minLevel = LEVEL_ORDER[minLevel];
  }
  log(level: LogLevel, msg: string): void {
    if (LEVEL_ORDER[level] < this.minLevel) return;
    const line = `${new Date().toISOString()} [${level.toUpperCase()}] ${redact(msg)}`;
    if (level === "error") console.error(line);
    else console.log(line);
  }
  debug(msg: string): void { this.log("debug", msg); }
  info(msg: string): void { this.log("info", msg); }
  warn(msg: string): void { this.log("warn", msg); }
  error(msg: string): void { this.log("error", msg); }
}

export const log = new Logger(
  process.env.GOROUTER_LOG_LEVEL === "debug" ? "debug" : "info",
);

// ---------------------------------------------------------------------------
// Secret redaction — applied to every string that may reach logs, CLI output,
// journal or handoff surfaces. This is a defense-in-depth guard: call sites
// must still avoid placing secrets in these strings in the first place.
// ---------------------------------------------------------------------------

// F02-01: the sk- family is deliberately boundary-free on BOTH sides — the
// leading \b failed between a preceding word char and 's' (redact('xx'+KEY)
// leaked the key), and a trailing word char is an equally real leak vector
// (KEY+'yy'). The 'sk-' prefix plus the {12,} run is a strong enough signal;
// every other family keeps its \b...\b word boundaries unchanged.
const SECRET_SCAN = /(?:sk-[A-Za-z0-9_-]{12,}|\b(?:Bearer\s+[A-Za-z0-9._~+/-]{12,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}|AIza[A-Za-z0-9_-]{30,}|[A-Za-z0-9_-]{40,})\b)/g;

/** Replace credential-shaped fragments with a fixed marker. */
export function redact(text: string): string {
  return text.replace(SECRET_SCAN, "[REDACTED]");
}

// ---------------------------------------------------------------------------
// Atomic file writes (temp + fsync + rename) so concurrent readers never see
// a half-written state file.
// ---------------------------------------------------------------------------

import { writeFileSync, renameSync, openSync, closeSync, fsyncSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export function atomicWriteJson(file: string, value: unknown): void {
  const dir = dirname(file);
  const tmp = join(dir, `.${randomUUID()}.tmp`);
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(value, null, 2) + "\n", "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
}

export function atomicWriteBytes(file: string, bytes: Uint8Array): void {
  const dir = dirname(file);
  const tmp = join(dir, `.${randomUUID()}.tmp`);
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
}

export function tryUnlink(file: string): void {
  try { unlinkSync(file); } catch { /* already gone */ }
}

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

/** Monotonic milliseconds (process-lifetime reference). */
export function monotonicMs(): number {
  return performance.now();
}

/** UTC ISO-8601 timestamp with millisecond precision, 'Z' suffix. */
export function utcNow(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Headers
// ---------------------------------------------------------------------------

/** Hop-by-hop + proxy-hop headers that must never be forwarded. */
export const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** Local-only headers consumed by GoRouter and never forwarded upstream. */
export const LOCAL_HEADERS = new Set([
  "x-gorouter-correlation-id",
  // per-family client-auth headers: the local credential may arrive in any of
  // these (OpenAI-style Bearer, Anthropic x-api-key, Gemini x-goog-api-key);
  // none of them may be forwarded — the account key is injected per family.
  "authorization",
  "x-api-key",
  "x-goog-api-key",
]);

export function sanitizeForwardHeaders(headers: Headers): Headers {
  const out = new Headers();
  for (const [name, value] of headers) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    if (lower === "host") continue; // set explicitly to the upstream authority
    if (LOCAL_HEADERS.has(lower)) continue;
    out.set(name, value);
  }
  return out;
}

/**
 * Bounded validation for the optional client correlation id header.
 * The value must be a short, printable, non-secret identifier.
 */
export function validateCorrelationId(value: string | null): string | undefined {
  if (value === null || value === undefined) return undefined;
  const v = value.trim();
  if (v.length === 0 || v.length > 128) return undefined;
  if (!/^[A-Za-z0-9._~-]+$/.test(v)) return undefined;
  return v;
}

/** Upstream session header required by OpenCode (one stable id per conversation). */
export const OPENCODE_SESSION_HEADER = "x-opencode-session";

/**
 * Resolve the upstream OpenCode session id for one proxied request.
 * A valid inbound client value is forwarded untouched so DSH/OMP
 * conversations keep their stable grouping id; otherwise the validated
 * router correlation id is reused; otherwise a fresh UUID is generated
 * so upstream never sees a missing header.
 */
/**
 * Shared id grammar for session and correlation ids forwarded upstream:
 * URL-safe token chars only (no spaces, commas, quotes — multi-value headers
 * arrive comma-joined and must fall back, never forward as one garbage id).
 */
export const FORWARDED_ID_PATTERN = /^[A-Za-z0-9._~-]+$/;

export function resolveUpstreamSessionId(
  inbound: string | null | undefined,
  correlationId: string | undefined,
): string {
  const v = (inbound ?? "").trim();
  if (v.length > 0 && v.length <= 256 && FORWARDED_ID_PATTERN.test(v)) return v;
  if (correlationId) return correlationId;
  return randomUUID();
}

/**
 * Credential-safe wrapper around resolveUpstreamSessionId.
 * The resolved value is subject to the same containment rule as every other
 * forwarded header: it must never carry the local client credential upstream
 * (the raw inbound value must not be re-introduced after stripping). On a
 * match the value is REPLACED with a fresh UUID — never deleted — so the
 * upstream never-missing guarantee still holds. The caller logs the
 * replacement the same way it logs other credential strips.
 */
/**
 * Minimum secret length for substring containment checks: below this only
 * exact-token equality applies. A short/low-entropy credential would otherwise
 * substring-match innocent ids (rotating them to fresh UUIDs per request and
 * spamming the strip log). Router-generated credentials are 43 chars.
 */
export const MIN_SUBSTRING_SECRET_LENGTH = 16;

export function resolveUpstreamSessionIdSafe(
  inbound: string | null | undefined,
  correlationId: string | undefined,
  localCred: string,
  alsoStrip: string[] = [],
): { sessionId: string; replaced: boolean } {
  const sessionId = resolveUpstreamSessionId(inbound, correlationId);
  // The session header is set AFTER the generic strip loop, so this wrapper
  // is the sole backstop for it: check the local credential and any extra
  // secret the caller names (e.g. the account key).
  for (const secret of [localCred, ...alsoStrip]) {
    if (secret.length >= MIN_SUBSTRING_SECRET_LENGTH && sessionId.includes(secret)) {
      return { sessionId: randomUUID(), replaced: true };
    }
  }
  return { sessionId, replaced: false };
}

/** Narrow allowlist of upstream response headers archived as request ids. */
export const UPSTREAM_REQUEST_ID_HEADERS = ["x-request-id", "x-amzn-requestid"] as const;

export function extractUpstreamRequestIds(headers: Headers): string[] {
  const ids: string[] = [];
  for (const name of UPSTREAM_REQUEST_ID_HEADERS) {
    const value = headers.get(name);
    if (value && value.length > 0 && value.length <= 256 && /^[\x20-\x7E]+$/.test(value)) {
      ids.push(`${name}: ${value}`);
    }
  }
  return ids;
}

/** Endpoint-family classification from the forwarded path suffix — bounded vocabulary so an arbitrary path cannot store arbitrary strings in the journal. */
export function classifyEndpointFamily(suffix: string): string {
  if (suffix.startsWith("/chat/completions")) return "chat/completions";
  if (suffix.startsWith("/responses")) return "responses";
  if (suffix.startsWith("/messages")) return "messages";
  if (suffix.startsWith("/models")) return "models";
  if (suffix === "/" || suffix.length === 0) return "root";
  return "other";
}
