/**
 * WI02 scenario registry — each scenario OWNS its actual request bytes.
 *
 * --scenario is executable behavior, not a report label. Unknown ids fail
 * closed and never fall back to chat/completions.
 *
 * Route authority (read-only GoRouter v1.0.0, commit 967c98c):
 * - Main/src/util.ts classifyEndpointFamily: suffixes "/chat/completions",
 *   "/responses", "/messages" (+ "/models") are the accepted families.
 * - Main/test/proxy.test.ts "endpoint families carry the same explicit
 *   session (chat/responses/messages)": client paths /go/v1/chat/completions,
 *   /go/v1/responses, /go/v1/messages all 200 with {model:"m"} and forward
 *   the same x-opencode-session.
 * - Main/test/proxy.test.ts "anthropic family": POST /go/v1/messages with
 *   x-api-key local credential + anthropic-version 2023-06-01 + body
 *   {model, messages, max_tokens:8}; upstream sees path /messages, body
 *   byte-identical, x-api-key replaced with account key, authorization absent.
 * - Main/test/models-registry.test.ts "other inference paths are not
 *   intercepted": upstream pathnames /chat/completions, /responses,
 *   /messages; client paths /go/v1+suffix bypass the models cache.
 * - Main/src/server.ts classifyAuthFamily: suffix "messages*" -> anthropic
 *   (x-api-key); models/*:generateContent -> google; default -> bearer.
 *   chat/completions + responses parse Authorization Bearer.
 * - Main/src/probe.ts: probe body {model, messages, max_tokens:8,
 *   stream:false} proves max_tokens is a known request field at this layer.
 * - Reasoning: NO reasoning request field exists in Main/src or Main/test
 *   request contracts (catalog reasoningEfforts are model metadata, not
 *   request fields). Rich scenario therefore reports:
 *   "reasoning control: NOT REPRESENTED IN RELEASED REQUEST CONTRACT".
 *
 * Auth placeholder: scenarios store "{{LOCAL_KEY}}" in the credential header;
 * run.ts substitutes the synthetic local key at runtime so registry definitions
 * never embed secret literals.
 */

export type WireLane = "go" | "zen";
export type WireAuthKind = "bearer" | "anthropic";

export interface WireScenario {
  id: string;
  description: string;
  lane: WireLane;
  method: "POST";
  /** Full local client path including lane prefix. */
  clientPath: string;
  query?: string;
  /** Headers with "{{LOCAL_KEY}}" placeholder in the credential header. */
  headers: Record<string, string>;
  body: unknown;
  observationProfile: string[];
  /** Accepted GoRouter client path evidence. */
  routeEvidence: string;
  /** Expected captured upstream path (base joined, lane prefix stripped). */
  expectedUpstreamPath: string;
  authKind: WireAuthKind;
  accountAlias: string;
  support: "SUPPORTED_CAPTURED" | "UNSUPPORTED_BY_RELEASED_GOROUTER";
}

export const LOCAL_KEY_PLACEHOLDER = "{{LOCAL_KEY}}";

const CHAT_EVIDENCE =
  "Main/src/util.ts classifyEndpointFamily '/chat/completions'; " +
  "Main/test/proxy.test.ts POST /go/v1/chat/completions -> upstream /chat/completions " +
  "(session/UA/auth/body observations).";
const RESPONSES_EVIDENCE =
  "Main/src/util.ts classifyEndpointFamily '/responses'; " +
  "Main/test/proxy.test.ts 'endpoint families carry the same explicit session " +
  "(chat/responses/messages)' POST /go/v1/responses -> 200 + session forwarded; " +
  "Main/test/proxy.test.ts 'streaming request forms' /go/v1/responses {model,stream:true}; " +
  "Main/test/models-registry.test.ts upstream pathname /responses.";
const MESSAGES_EVIDENCE =
  "Main/src/util.ts classifyEndpointFamily '/messages'; " +
  "Main/src/server.ts classifyAuthFamily 'messages*' -> anthropic (x-api-key); " +
  "Main/test/proxy.test.ts 'anthropic family' POST /go/v1/messages " +
  "(x-api-key + anthropic-version 2023-06-01, body {model,messages,max_tokens:8}) " +
  "-> upstream /messages byte-identical body, x-api-key=account key, authorization absent.";

export const WI02_MODEL_CHAT = "wi01-synthetic-model";
export const WI02_MODEL_RESPONSES = "wi02-synthetic-responses-model";
export const WI02_MODEL_MESSAGES = "wi02-synthetic-messages-model";
export const WI02_MODEL_RICH = "wi02-synthetic-rich-model";
export const WI02_MODEL_MATRIX = "wi02-synthetic-matrix-model";
export const WI02_MODEL_ZEN = "wi02-synthetic-zen-model";

const SCENARIOS: WireScenario[] = [
  {
    id: "chat-completions-stream",
    description: "WI01 baseline: POST chat/completions stream=true (GO lane).",
    lane: "go",
    method: "POST",
    clientPath: "/go/v1/chat/completions",
    query: "",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      authorization: "Bearer {{LOCAL_KEY}}",
      "x-opencode-session": "WI01-SESSION-001",
      "user-agent": "WI01-Synthetic-Client/1.0",
    },
    body: {
      model: WI02_MODEL_CHAT,
      messages: [{ role: "user", content: "wire inspector test" }],
      stream: true,
    },
    observationProfile: ["session", "user-agent", "auth", "model", "messages", "stream", "path"],
    routeEvidence: CHAT_EVIDENCE,
    expectedUpstreamPath: "/chat/completions",
    authKind: "bearer",
    accountAlias: "wi01-synthetic",
    support: "SUPPORTED_CAPTURED",
  },
  {
    id: "responses-basic",
    description: "Responses-family baseline: POST /responses with model+input+stream (GO lane).",
    lane: "go",
    method: "POST",
    clientPath: "/go/v1/responses",
    query: "",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      authorization: "Bearer {{LOCAL_KEY}}",
      "x-opencode-session": "WI02-SESSION-RESPONSES-001",
      "user-agent": "WI02-Synthetic-Client/1.0",
    },
    body: {
      model: WI02_MODEL_RESPONSES,
      input: "wire inspector responses test",
      stream: false,
    },
    observationProfile: ["session", "user-agent", "auth", "model", "input", "stream", "path"],
    routeEvidence: RESPONSES_EVIDENCE,
    expectedUpstreamPath: "/responses",
    authKind: "bearer",
    accountAlias: "wi02-synthetic-go",
    support: "SUPPORTED_CAPTURED",
  },
  {
    id: "messages-basic",
    description: "Messages-family baseline: POST /messages with Anthropic auth (GO lane).",
    lane: "go",
    method: "POST",
    clientPath: "/go/v1/messages",
    query: "",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      "x-api-key": "{{LOCAL_KEY}}",
      "anthropic-version": "2023-06-01",
      "x-opencode-session": "WI02-SESSION-MESSAGES-001",
      "user-agent": "WI02-Synthetic-Client/1.0",
    },
    body: {
      model: WI02_MODEL_MESSAGES,
      messages: [{ role: "user", content: "wire inspector messages test" }],
      max_tokens: 8,
    },
    observationProfile: ["session", "user-agent", "auth-family", "model", "messages", "token-controls", "path"],
    routeEvidence: MESSAGES_EVIDENCE,
    expectedUpstreamPath: "/messages",
    authKind: "anthropic",
    accountAlias: "wi02-synthetic-go",
    support: "SUPPORTED_CAPTURED",
  },
  {
    id: "chat-completions-rich",
    description: "Rich chat/completions: tools, tool_choice, temperature, top_p, max_tokens (GO lane; reasoning NOT REPRESENTED).",
    lane: "go",
    method: "POST",
    clientPath: "/go/v1/chat/completions",
    query: "",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      authorization: "Bearer {{LOCAL_KEY}}",
      "x-opencode-session": "WI02-SESSION-RICH-001",
      "user-agent": "WI02-Synthetic-Client/1.0",
    },
    body: {
      model: WI02_MODEL_RICH,
      messages: [{ role: "user", content: "wire inspector rich test" }],
      stream: false,
      tools: [
        {
          type: "function",
          function: {
            name: "wi02_weather",
            description: "Deterministic synthetic weather tool (WI02 only).",
            parameters: {
              type: "object",
              properties: { city: { type: "string" } },
              required: ["city"],
            },
          },
        },
      ],
      tool_choice: "auto",
      temperature: 0.2,
      top_p: 0.9,
      max_tokens: 16,
    },
    observationProfile: ["session", "user-agent", "auth", "model", "messages", "stream", "tools", "tool_choice", "sampling", "token-controls", "reasoning-absence", "path"],
    routeEvidence:
      CHAT_EVIDENCE + " Rich fields: max_tokens proven by Main/src/probe.ts {model,messages,max_tokens:8}; " +
      "router forwards bodies verbatim (proxy.test.ts body byte-equality), so standard " +
      "chat tools/tool_choice/temperature/top_p pass through unmodified; no reasoning " +
      "request field exists in Main/src|test (catalog reasoningEfforts are metadata, not request fields).",
    expectedUpstreamPath: "/chat/completions",
    authKind: "bearer",
    accountAlias: "wi02-synthetic-go",
    support: "SUPPORTED_CAPTURED",
  },
  {
    id: "header-matrix",
    description: "Header matrix: deterministic session/correlation/client headers over chat/completions (GO lane).",
    lane: "go",
    method: "POST",
    clientPath: "/go/v1/chat/completions",
    query: "",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      authorization: "Bearer {{LOCAL_KEY}}",
      "x-opencode-session": "WI02-SESSION-MATRIX",
      "x-client-request-id": "WI02-CLIENT-REQ-001",
      "x-session-id": "WI02-X-SESSION-ID-001",
      "x-session-affinity": "WI02-AFFINITY-001",
      "x-gorouter-correlation-id": "WI02-CORR-001",
      "x-wi02-test": "WI02-CUSTOM-HEADER",
      "user-agent": "WI02-Header-Matrix/1.0",
    },
    body: {
      model: WI02_MODEL_MATRIX,
      messages: [{ role: "user", content: "wire inspector header matrix test" }],
      stream: false,
    },
    observationProfile: ["x-opencode-session", "x-client-request-id", "x-session-id", "x-session-affinity", "x-gorouter-correlation-id", "x-wi02-test", "user-agent", "accept", "content-type", "auth"],
    routeEvidence: CHAT_EVIDENCE + " Matrix headers ride the same accepted chat/completions route; " +
      "x-gorouter-correlation-id is journal-only per Main/src/server.ts (validated, never mapped to session).",
    expectedUpstreamPath: "/chat/completions",
    authKind: "bearer",
    accountAlias: "wi02-synthetic-go",
    support: "SUPPORTED_CAPTURED",
  },
  {
    id: "zen-chat-baseline",
    description: "ZEN-lane chat/completions baseline for GO-vs-ZEN comparison.",
    lane: "zen",
    method: "POST",
    clientPath: "/zen/v1/chat/completions",
    query: "",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      authorization: "Bearer {{LOCAL_KEY}}",
      "x-opencode-session": "WI02-SESSION-ZEN-001",
      "user-agent": "WI02-Synthetic-Client-Zen/1.0",
    },
    body: {
      model: WI02_MODEL_ZEN,
      messages: [{ role: "user", content: "wire inspector zen test" }],
      stream: false,
    },
    observationProfile: ["session", "user-agent", "auth", "model", "messages", "stream", "path", "go-zen-compare"],
    routeEvidence:
      "Same family authority as chat/completions (classifyEndpointFamily is lane-independent); " +
      "lane prefix /zen/v1 per Main/src/server.ts LANE_PREFIX {go:'/go/v1',zen:'/zen/v1'}; " +
      "proxy.test.ts google-family test exercises /zen/v1/* routing; models-registry " +
      "seeds both go+zen routes against the same loopback base.",
    expectedUpstreamPath: "/chat/completions",
    authKind: "bearer",
    accountAlias: "wi02-synthetic-zen",
    support: "SUPPORTED_CAPTURED",
  },
];

export function listScenarios(): WireScenario[] {
  return SCENARIOS.map((s) => ({ ...s, headers: { ...s.headers }, body: structuredClone(s.body) }));
}

export function getScenario(id: string): WireScenario {
  const found = SCENARIOS.find((s) => s.id === id);
  if (!found) throw new Error("unknown scenario '" + id + "'");
  return { ...found, headers: { ...found.headers }, body: structuredClone(found.body) };
}

/** Substitute the synthetic local key into the credential header. */
export function materializeHeaders(scn: WireScenario, localKey: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(scn.headers)) {
    out[k] = v.split(LOCAL_KEY_PLACEHOLDER).join(localKey);
  }
  return out;
}

export const REQUIRED_WI02_SCENARIO_IDS = [
  "chat-completions-stream",
  "responses-basic",
  "messages-basic",
  "chat-completions-rich",
  "header-matrix",
  "zen-chat-baseline",
] as const;
