/**
 * B.1 — owned provider-binding safety guard.
 *
 * Before any approval-derived DSH mutation, BOTH owned provider bindings must
 * validate: gorouter-go (openai-completions) and gorouter-zen
 * (openai-responses) must point at the canonical local GoRouter lane routes
 * (http://<loopback>:<port>/go/v1 and /zen/v1). `baseURL` is NOT part of
 * approval identity — it is a separate, mandatory safety condition. A wrong
 * host, foreign service, wrong lane path, wrong port or wrong API protocol
 * fails closed: neither owned model array may be mutated.
 */
import { isLoopbackHostname } from "./dsh-types.ts";
import { OWNED_DSH_PROVIDERS } from "./dsh-approvals.ts";
import type { Lane } from "../state.ts";
import type { DshSnapshot } from "./dsh-client.ts";

export interface LaneBindingCheck {
  lane: Lane;
  valid: boolean;
  /** Observed api protocol (null when provider object missing/unreadable). */
  api: string | null;
  /** Observed baseURL (null when absent). Non-secret: local route only. */
  baseURL: string | null;
  reason: string | null;
}

export interface BindingCheck {
  valid: boolean;
  go: LaneBindingCheck;
  zen: LaneBindingCheck;
}

function normalizedPathname(raw: string): string | null {
  try {
    const u = new URL(raw);
    const path = u.pathname.replace(/\/+$/, "");
    return path.length === 0 ? "/" : path;
  } catch {
    return null;
  }
}

function checkLane(lane: Lane, rawProvider: Record<string, unknown> | null | undefined, expectedPort: number): LaneBindingCheck {
  const owned = OWNED_DSH_PROVIDERS[lane];
  const base: LaneBindingCheck = { lane, valid: false, api: null, baseURL: null, reason: null };
  if (!rawProvider || typeof rawProvider !== "object") {
    return { ...base, reason: `owned provider '${owned.providerId}' missing from DSH settings` };
  }
  const api = typeof rawProvider["api"] === "string" ? (rawProvider["api"] as string) : null;
  const baseURL = typeof rawProvider["baseURL"] === "string" ? (rawProvider["baseURL"] as string) : null;
  if (api !== owned.apiProtocol) {
    return { ...base, api, baseURL, reason: `owned provider '${owned.providerId}' api protocol '${api ?? "(missing)"}' != certified '${owned.apiProtocol}'` };
  }
  if (!baseURL) {
    return { ...base, api, baseURL, reason: `owned provider '${owned.providerId}' has no baseURL` };
  }
  let u: URL;
  try {
    u = new URL(baseURL);
  } catch {
    return { ...base, api, baseURL, reason: `owned provider '${owned.providerId}' baseURL unparseable` };
  }
  // Plaintext http: ONLY (M8): the owned bindings must point at GoRouter's
  // own loopback lane routes, which serve plaintext. An https: URL here is
  // not "safer" — TLS against the plaintext router fails at fetch — so it
  // fails closed with a reason that says so. (The DSH *host* endpoint in
  // dsh-client.ts deliberately allows https:; different endpoint, different
  // rule.)
  if (u.protocol !== "http:") {
    return { ...base, api, baseURL, reason: `owned provider '${owned.providerId}' baseURL must be local plaintext http (https against the loopback router cannot handshake)` };
  }
  if (!isLoopbackHostname(u.hostname)) {
    return { ...base, api, baseURL, reason: `owned provider '${owned.providerId}' baseURL host '${u.hostname}' is not loopback` };
  }
  const port = u.port === "" ? 80 : Number(u.port);
  if (port !== expectedPort) {
    return { ...base, api, baseURL, reason: `owned provider '${owned.providerId}' baseURL port ${port} != canonical GoRouter port ${expectedPort}` };
  }
  const path = normalizedPathname(baseURL);
  if (path !== owned.lanePath) {
    return { ...base, api, baseURL, reason: `owned provider '${owned.providerId}' baseURL path '${path ?? "?"}' != canonical lane path '${owned.lanePath}'` };
  }
  return { lane, valid: true, api, baseURL, reason: null };
}

/**
 * Validate both owned bindings from one coherent DSH snapshot view.
 * Either lane invalid => overall invalid (no partial two-lane mutation).
 */
export function checkOwnedProviderBindings(snapshot: DshSnapshot, expectedPort: number): BindingCheck {
  const go = checkLane("go", snapshot.rawGoProvider, expectedPort);
  const zen = checkLane("zen", snapshot.rawZenProvider, expectedPort);
  return { valid: go.valid && zen.valid, go, zen };
}
