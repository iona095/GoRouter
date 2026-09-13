/**
 * GoRouter V1 — account/lane live validation probe.
 *
 * Uses the smallest safe authenticated surface per lane:
 *  - go:  a tiny chat completion on a current Go-catalog model (minimax-m3);
 *         this is the only honest Go auth surface — GET /models is public.
 *  - zen: a tiny chat completion on a current non-billing free model
 *         (deepseek-v4-flash-free); never a paid Zen model.
 *
 * Quota-aware classification (contract §6): an auth-passed quota/rate-limit
 * response (GoUsageLimitError / CreditsError / provider-state errors) is
 * reported as AUTH_PASS_* when the response is credential-dependent — the
 * controlled negative control (invalid key -> 401 AuthError) makes the
 * distinction credible. A generic/global failure is reported UNKNOWN.
 */
import { randomUUID } from "node:crypto";
import { log, OPENCODE_SESSION_HEADER } from "./util.ts";

export type ProbeVerdict =
  | "AUTH_PASS_LIVE" // successful tiny inference (or non-error authenticated response)
  | "AUTH_PASS_QUOTA_STATE" // credential-dependent, auth-passed quota state
  | "AUTH_PASS_UPSTREAM_STATE" // credential-dependent provider/model state (not AuthError)
  | "AUTH_FAIL" // 401 AuthError: credential rejected
  | "UNKNOWN"; // network/TLS/ambiguous failure

export interface ProbeResult {
  lane: "go" | "zen";
  model: string;
  verdict: ProbeVerdict;
  httpStatus: number | null;
  errorType: string | null;
  errorMessageBrief: string | null;
  workspaceHint: string | null;
  tookMs: number;
}

/** Truthful generator identity for probe traffic (H0 section 7): the probe speaks
 * for GoRouter validation, never as an originating coding-agent conversation.
 * Major-only version pin avoids duplication drift with SERVER_VERSION. */
export const PROBE_USER_AGENT = "GoRouter-Probe/1.0";
/** Per-attempt probe options. A retry of the same logical attempt reuses its
 * sessionId; a separate attempt uses a different one. Defaults are attempt-
 * scoped only and MUST NOT be read as conversation identity. */
export interface ProbeOptions {
  timeoutMs?: number;
  sessionId?: string;
  userAgent?: string;
}
const GO_PROBE_MODEL = "minimax-m3";
// Non-deepseek free Zen model (user-directed: deepseek family is flaky on
// opencode right now; mimo-v2.5-free verified 200 on both accounts).
const ZEN_PROBE_MODEL = "mimo-v2.5-free";

function classify(lane: "go" | "zen", status: number | null, errorType: string | null, errorMessage: string | null): ProbeVerdict {
  if (status === null) return "UNKNOWN";
  if (status === 200) return "AUTH_PASS_LIVE";
  if (status === 401 && errorType === "AuthError") return "AUTH_FAIL";
  if (status === 429 && (errorType === "GoUsageLimitError" || errorType === "CreditsError")) {
    return "AUTH_PASS_QUOTA_STATE";
  }
  // 404 is routing failure, not key evidence (D-10): a retired probe-model
  // id, a wrong endpoint path, or an unknown model all 404 — none of them
  // says anything about the credential, so UNKNOWN, never AUTH_PASS_*.
  if (status === 404) return "UNKNOWN";
  // H0 narrow: request-contract/validation classes (400 for malformed/
  // missing fields and shapes, 422 for semantically unprocessable bodies)
  // are never credential evidence — the request, not the key, was rejected.
  // MissingSessionID, InvalidRequest and equivalents map here, never to
  // AUTH_PASS_*. Other 4xx/5xx typed provider/billing states keep the
  // dependency rule below (key parsed past authentication).
  if (status === 400 || status === 422) return "UNKNOWN";
  // Retained AUTH_PASS_UPSTREAM_STATE triggers (non-400 typed provider/
  // billing state, e.g. 402/409/422/5xx with a provider error type, or a
  // non-AuthError 401): the gateway parsed the key far enough to return
  // typed provider-side state instead of the invalid-key 401 AuthError that
  // this gateway/surface returns for rejected keys (provider-specific
  // behavior observed on the current OpenCode surface — local evidence only,
  // not certified production behavior). Generic/typeless errors stay UNKNOWN.
  if (status >= 400 && errorType && errorType !== "AuthError") return "AUTH_PASS_UPSTREAM_STATE";
  return "UNKNOWN";
}

export async function probeAccountKey(
  lane: "go" | "zen",
  secret: string,
  upstreamBase: string,
  timeoutMsOrOpts: number | ProbeOptions = 45_000,
): Promise<ProbeResult> {
  const model = lane === "go" ? GO_PROBE_MODEL : ZEN_PROBE_MODEL;
  const opts: ProbeOptions = typeof timeoutMsOrOpts === "number" ? { timeoutMs: timeoutMsOrOpts } : timeoutMsOrOpts;
  const timeoutMs = opts.timeoutMs ?? 45_000;
  // Attempt-scoped session: identifies one logical probe attempt (a retry
  // reuses it; a new attempt mints a new one). Never a conversation id.
  const sessionId = opts.sessionId ?? randomUUID();
  const userAgent = opts.userAgent ?? PROBE_USER_AGENT;
  const body = JSON.stringify({
    model,
    messages: [{ role: "user", content: "Reply with exactly: OK" }],
    max_tokens: 8,
    stream: false,
  });
  const started = Date.now();
  let status: number | null = null;
  let errorType: string | null = null;
  let errorMessage: string | null = null;
  let workspaceHint: string | null = null;
  try {
    const res = await fetch(`${upstreamBase}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${secret}`,
        "content-type": "application/json",
        [OPENCODE_SESSION_HEADER]: sessionId,
        "user-agent": userAgent,
      },
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    status = res.status;
    try {
      const data = (await res.json()) as {
        error?: { type?: string; message?: string; metadata?: { workspace?: string } };
      };
      errorType = data.error?.type ?? null;
      errorMessage = data.error?.message ? data.error.message.slice(0, 200) : null;
      workspaceHint = data.error?.metadata?.workspace ?? null;
    } catch {
      // non-JSON error body — keep raw status only
    }
  } catch (e) {
    log.warn(`probe network failure (${lane}): ${e instanceof Error ? e.message : String(e)}`);
    status = null;
  }
  const verdict = classify(lane, status, errorType, errorMessage);
  return {
    lane,
    model,
    verdict,
    httpStatus: status,
    errorType,
    errorMessageBrief: errorMessage,
    workspaceHint,
    tookMs: Date.now() - started,
  };
}
