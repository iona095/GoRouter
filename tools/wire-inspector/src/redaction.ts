/**
 * WI01 redaction — MUST run before any request data reaches disk.
 *
 * Never persist raw values for headers/fields semantically equivalent to:
 * authorization, proxy-authorization, cookie, set-cookie, x-api-key, api-key,
 * access-token, refresh-token, secret, password, bootstrap, csrf, admin token,
 * named-pipe credential.
 *
 * Retained output keeps only safe metadata: scheme, length, presence.
 */

export const SENSITIVE_HEADER_NAMES = new Set([
  "authorization",
  "proxy-authorization",
  "proxy-authenticate",
  "cookie",
  "set-cookie",
  "x-api-key",
  "api-key",
  "x-goog-api-key",
  "access-token",
  "refresh-token",
  "secret",
  "password",
  "bootstrap",
  "csrf",
]);

function normHeader(h: string): string {
  return h.toLowerCase().trim();
}

/** True when a header name must be redacted (exact + heuristic containment). */
export function isSensitiveHeaderName(name: string): boolean {
  const n = normHeader(name);
  if (SENSITIVE_HEADER_NAMES.has(n)) return true;
  // Heuristic containment for variants: x-admin-token, csrf-token, etc.
  // Deliberately EXCLUDES x-opencode-session / user-agent / content-type.
  const flat = n.replace(/[_\-\s]/g, "");
  if (flat.includes("secret")) return true;
  if (flat.includes("password")) return true;
  if (flat.includes("bootstrap")) return true;
  if (flat === "csrf" || flat.includes("csrf")) return true;
  if (flat.includes("apikey")) return true;
  if (flat.includes("accesstoken")) return true;
  if (flat.includes("refreshtoken")) return true;
  if (flat === "cookie" || flat.includes("cookie")) return true;
  if (flat.includes("authorization")) return true;
  if (flat.includes("authenticate")) return true; // www-authenticate, proxy-authenticate carriers
  if (flat.includes("admintoken") || (flat.includes("admin") && flat.includes("token"))) return true;
  // Named-pipe credential carriers
  if (flat.includes("namedpipe")) return true;
  return false;
}

/** Redact one header value, preserving only the auth scheme word. */
export function redactHeaderValue(name: string, value: string): string {
  if (!isSensitiveHeaderName(name)) return value;
  const m = /^\s*(Bearer|Basic|Digest)\s+.+$/i.exec(value);
  if (m) return m[1]![0]!.toUpperCase() + m[1]!.slice(1).toLowerCase() + " <REDACTED>";
  return "<REDACTED>";
}

export interface AuthMeta {
  present: boolean;
  scheme: string | null;
  length: number | null;
}

export function authMetaForValue(value: string | null | undefined): AuthMeta {
  if (value === null || value === undefined) return { present: false, scheme: null, length: null };
  const m = /^\s*([A-Za-z][A-Za-z0-9]*)\s+.+$/s.exec(value);
  return { present: true, scheme: m ? m[1]! : "opaque", length: value.length };
}

/** Sanitize a header map (record). Returns a NEW record; input untouched. */
export function sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) out[k] = redactHeaderValue(k, v);
  return out;
}

function normKey(k: string): string {
  return k.toLowerCase().replace(/[_\-]/g, "");
}

/** True when a JSON body key carries credential material. */
export function isSensitiveBodyKey(key: string): boolean {
  const flat = normKey(key);
  if (["authorization", "cookie", "setcookie", "secret", "password", "bootstrap", "csrf", "token"].includes(flat)) return true;
  if (flat.includes("secret")) return true;
  if (flat.includes("password")) return true;
  if (flat.includes("bootstrap")) return true;
  if (flat.includes("csrf")) return true;
  if (flat.includes("apikey")) return true;
  if (flat.includes("accesstoken")) return true;
  if (flat.includes("refreshtoken")) return true;
  if (flat === "admintoken" || (flat.includes("admin") && flat.includes("token"))) return true;
  return false;
}

/** Deep-sanitize a JSON-compatible body. Returns a NEW value. */
export function sanitizeBody(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeBody);
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isSensitiveBodyKey(k) ? "<REDACTED>" : sanitizeBody(v);
    }
    return out;
  }
  return value;
}

/** Scan any string for a literal secret; true when leaked. */
export function containsLiteral(haystack: string, literal: string): boolean {
  if (!literal) return false;
  return haystack.includes(literal);
}
