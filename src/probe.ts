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
import { log } from "./util.ts";

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
  // Any other credential-dependent upstream/provider state: the gateway
  // accepted the key (an invalid key is always 401 AuthError on this surface).
  if (status >= 400 && errorType && errorType !== "AuthError") return "AUTH_PASS_UPSTREAM_STATE";
  return "UNKNOWN";
}

export async function probeAccountKey(
  lane: "go" | "zen",
  secret: string,
  upstreamBase: string,
  timeoutMs = 45_000,
): Promise<ProbeResult> {
  const model = lane === "go" ? GO_PROBE_MODEL : ZEN_PROBE_MODEL;
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
