/**
 * GR-005 — router identity proof (shared contract).
 *
 * Liveness is not identity: the public /healthz JSON ({status, version}) is
 * intentionally unauthenticated, so any loopback listener can parrot it.
 * A supervisor proves it is talking to OUR router with a fresh per-probe
 * challenge: the router answers with HMAC-SHA256(challenge) keyed by the
 * local client credential (DPAPI-held, shared only with routers using the
 * same state dir). A foreign listener cannot forge the proof without the
 * credential, and a captured proof never verifies against a new challenge.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** Header carrying the supervisor challenge on GET /healthz. */
export const ROUTER_CHALLENGE_HEADER = "x-gorouter-challenge";

/** Fresh challenges are URL-safe tokens, 8..128 chars (hex nonces qualify). */
const CHALLENGE_RE = /^[A-Za-z0-9._~-]{8,128}$/;
export function isValidChallenge(v: unknown): v is string {
  return typeof v === "string" && CHALLENGE_RE.test(v);
}

/** Mint a fresh per-probe challenge (32 hex chars). */
export function newRouterChallenge(): string {
  return randomBytes(16).toString("hex");
}

/** HMAC-SHA256 proof, hex-encoded. The secret never leaves either process. */
export function computeRouterProof(secret: string, challenge: string): string {
  return createHmac("sha256", secret).update(challenge, "utf8").digest("hex");
}

/** Timing-safe proof check (length-compared first; never throws). */
export function verifyRouterProof(secret: string, challenge: string, proof: unknown): boolean {
  if (typeof proof !== "string" || proof.length === 0) return false;
  const expected = computeRouterProof(secret, challenge);
  const a = Buffer.from(proof, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
