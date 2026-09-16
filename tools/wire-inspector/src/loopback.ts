/**
 * WI01 loopback-only enforcement.
 *
 * Every upstream destination must be HTTP on a loopback host. Anything else
 * — public IPs, provider DNS, opencode.ai, https — is refused fail-closed.
 * The capture server is an endpoint only: no proxying, no CONNECT, no
 * redirect forwarding, no external destination.
 */

export const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export function normalizeHost(hostname: string): string {
  let h = hostname.trim().toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  return h;
}

export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(normalizeHost(hostname));
}

/**
 * Assert a URL is an allowed WI01 synthetic upstream: http + loopback + no
 * userinfo. Throws on any violation (fail closed).
 */
export function assertLoopbackUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("WI01 refuses non-URL upstream '" + raw + "'");
  }
  if (url.username || url.password) {
    throw new Error("WI01 refuses upstream URL with embedded userinfo");
  }
  if (url.protocol !== "http:") {
    throw new Error("WI01 refuses non-http upstream '" + url.protocol + "//" + url.host + "' (loopback http only, no TLS MITM)");
  }
  if (!isLoopbackHost(url.hostname)) {
    throw new Error(
      "WI01 refuses non-loopback upstream host '" + url.hostname + "' (loopback only: 127.0.0.1, localhost, ::1)",
    );
  }
  const lower = raw.toLowerCase();
  if (lower.includes("opencode.ai")) {
    throw new Error("WI01 refuses provider host 'opencode.ai' (synthetic loopback only)");
  }
  return url;
}

/** Boolean form (no throw). */
export function isAllowedSyntheticUpstream(raw: string): boolean {
  try {
    assertLoopbackUrl(raw);
    return true;
  } catch {
    return false;
  }
}

/** Refuse anything that smells like a public/provider destination. */
export function refuseIfPublicOrProvider(raw: string): void {
  // Allow only what assertLoopbackUrl allows; everything else throws.
  assertLoopbackUrl(raw);
}
