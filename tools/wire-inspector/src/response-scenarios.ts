/**
 * WI03 response scenario registry — each scenario OWNS the exact synthetic
 * upstream response it causes (status, headers, JSON body or SSE writes).
 *
 * Unknown ids fail closed ("unknown response scenario '<id>'") and never
 * fall back to a default profile. The fixture never sniffs request bodies to
 * choose a response: the selected scenario drives the script explicitly.
 *
 * Request-side provenance: routes/auth/shapes reuse the WI02 request registry
 * evidence (Main/src/util.ts classifyEndpointFamily; server.ts
 * classifyAuthFamily; proxy.test.ts chat/responses/messages + anthropic-family
 * tests; probe.ts max_tokens). requestScenarioId names the WI02 scenario the
 * request bytes were derived from; the actual request bytes below are owned
 * here so WI03 never depends on WI02 runtime behavior.
 */

export type ResponseLane = "go" | "zen";
export type ResponseKind = "json" | "sse";

export interface ResponseScenario {
  id: string;
  description: string;
  /** WI02 request scenario this request was derived from (provenance only). */
  requestScenarioId: string;
  lane: ResponseLane;
  method: "POST";
  clientPath: string;
  /** Headers with "{{LOCAL_KEY}}" placeholder in the credential header. */
  headers: Record<string, string>;
  body: unknown;
  accountAlias: string;
  upstreamStatus: number;
  upstreamHeaders: Record<string, string>;
  responseKind: ResponseKind;
  /** Exact JSON body the fixture serializes (kind === "json"). */
  jsonBody?: unknown;
  /** Exact ordered stream writes the fixture emits (kind === "sse"). */
  sseWrites?: string[];
  expectedObservationProfile: string[];
}

export const LOCAL_KEY_PLACEHOLDER = "{{LOCAL_KEY}}";

const CHAT_REQ_HEADERS = {
  "content-type": "application/json",
  accept: "application/json",
  authorization: "Bearer {{LOCAL_KEY}}",
  "user-agent": "WI03-Synthetic-Client/1.0",
};

const CHAT_SSE_WRITES = [
  'data: {"id":"wi03-chat-1","object":"chat.completion.chunk","created":0,"model":"wi03-synthetic-chat-model","choices":[{"index":0,"delta":{"role":"assistant","content":"wire"},"finish_reason":null}]}\n\n',
  'data: {"id":"wi03-chat-1","object":"chat.completion.chunk","created":0,"model":"wi03-synthetic-chat-model","choices":[{"index":0,"delta":{"content":" inspector"},"finish_reason":null}]}\n\n',
  "data: [DONE]\n\n",
];

const SCENARIOS: ResponseScenario[] = [
  {
    id: "chat-json-200",
    description: "Chat JSON 200: non-streaming chat/completions success (GO lane).",
    requestScenarioId: "chat-completions-rich",
    lane: "go",
    method: "POST",
    clientPath: "/go/v1/chat/completions",
    headers: { ...CHAT_REQ_HEADERS, "x-opencode-session": "WI03-SESSION-CHAT-JSON" },
    body: {
      model: "wi03-synthetic-chat-model",
      messages: [{ role: "user", content: "wire inspector chat json test" }],
      stream: false,
    },
    accountAlias: "wi02-synthetic-go",
    upstreamStatus: 200,
    upstreamHeaders: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "x-request-id": "WI03-UPSTREAM-REQ-CHAT-200",
      "x-wi03-upstream": "chat-json-200",
    },
    responseKind: "json",
    jsonBody: {
      id: "wi03-chat-1",
      object: "chat.completion",
      created: 0,
      model: "wi03-synthetic-chat-model",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "wire inspector chat json reply" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 },
    },
    expectedObservationProfile: ["status", "content-type", "cache-control", "x-request-id", "x-wi03-upstream", "body-byte-identity", "body-semantic-identity"],
  },
  {
    id: "chat-sse-200",
    description: "Chat SSE 200: streaming chat/completions with 3 logical pieces (GO lane).",
    requestScenarioId: "chat-completions-stream",
    lane: "go",
    method: "POST",
    clientPath: "/go/v1/chat/completions",
    headers: { ...CHAT_REQ_HEADERS, "x-opencode-session": "WI03-SESSION-CHAT-SSE" },
    body: {
      model: "wi03-synthetic-chat-model",
      messages: [{ role: "user", content: "wire inspector chat sse test" }],
      stream: true,
    },
    accountAlias: "wi02-synthetic-go",
    upstreamStatus: 200,
    upstreamHeaders: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "x-request-id": "WI03-UPSTREAM-REQ-CHAT-SSE",
      "x-wi03-upstream": "chat-sse-200",
    },
    responseKind: "sse",
    sseWrites: [...CHAT_SSE_WRITES],
    expectedObservationProfile: ["status", "content-type", "cache-control", "x-request-id", "logical-bytes", "event-sequence", "fixture-writes", "client-reads"],
  },
  {
    id: "responses-sse-200",
    description: "Responses SSE 200: responses-shaped events (GO lane; transparency only, no understanding claimed).",
    requestScenarioId: "responses-basic",
    lane: "go",
    method: "POST",
    clientPath: "/go/v1/responses",
    headers: { ...CHAT_REQ_HEADERS, "x-opencode-session": "WI03-SESSION-RESPONSES-SSE" },
    body: {
      model: "wi03-synthetic-responses-model",
      input: "wire inspector responses sse test",
      stream: true,
    },
    accountAlias: "wi02-synthetic-go",
    upstreamStatus: 200,
    upstreamHeaders: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "x-request-id": "WI03-UPSTREAM-REQ-RESPONSES-SSE",
      "x-wi03-upstream": "responses-sse-200",
    },
    responseKind: "sse",
    sseWrites: [
      'data: {"type":"response.created","response":{"id":"wi03-resp-1","model":"wi03-synthetic-responses-model","status":"in_progress"}}\n\n',
      'data: {"type":"response.output_text.delta","delta":"wire inspector"}\n\n',
      'data: {"type":"response.completed","response":{"id":"wi03-resp-1","status":"completed"}}\n\n',
    ],
    expectedObservationProfile: ["status", "content-type", "logical-bytes", "event-sequence", "responses-shape-preserved"],
  },
  {
    id: "messages-sse-200",
    description: "Messages SSE 200: Anthropic-style named events (GO lane; derived from WI02 messages-basic auth/shape).",
    requestScenarioId: "messages-basic",
    lane: "go",
    method: "POST",
    clientPath: "/go/v1/messages",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      "x-api-key": "{{LOCAL_KEY}}",
      "anthropic-version": "2023-06-01",
      "x-opencode-session": "WI03-SESSION-MESSAGES-SSE",
      "user-agent": "WI03-Synthetic-Client/1.0",
    },
    body: {
      model: "wi03-synthetic-messages-model",
      messages: [{ role: "user", content: "wire inspector messages sse test" }],
      max_tokens: 8,
    },
    accountAlias: "wi02-synthetic-go",
    upstreamStatus: 200,
    upstreamHeaders: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "x-request-id": "WI03-UPSTREAM-REQ-MESSAGES-SSE",
      "x-wi03-upstream": "messages-sse-200",
    },
    responseKind: "sse",
    sseWrites: [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"wi03-msg-1","model":"wi03-synthetic-messages-model"}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"wire inspector"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ],
    expectedObservationProfile: ["status", "logical-bytes", "event-order", "messages-shape-preserved", "no-openai-conversion"],
  },
  {
    id: "zen-chat-sse-200",
    description: "ZEN chat SSE 200: same logical SSE profile as chat-sse-200 through ZEN lane.",
    requestScenarioId: "zen-chat-baseline",
    lane: "zen",
    method: "POST",
    clientPath: "/zen/v1/chat/completions",
    headers: { ...CHAT_REQ_HEADERS, "x-opencode-session": "WI03-SESSION-ZEN-SSE" },
    body: {
      model: "wi03-synthetic-zen-model",
      messages: [{ role: "user", content: "wire inspector zen sse test" }],
      stream: true,
    },
    accountAlias: "wi02-synthetic-zen",
    upstreamStatus: 200,
    upstreamHeaders: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "x-request-id": "WI03-UPSTREAM-REQ-ZEN-SSE",
      "x-wi03-upstream": "zen-chat-sse-200",
    },
    responseKind: "sse",
    sseWrites: [...CHAT_SSE_WRITES],
    expectedObservationProfile: ["status", "logical-bytes", "event-order", "go-zen-compare"],
  },
  {
    id: "error-400",
    description: "Synthetic upstream 400 JSON error (GO lane; proxy-behavior observation only, not H0 classification).",
    requestScenarioId: "chat-completions-rich",
    lane: "go",
    method: "POST",
    clientPath: "/go/v1/chat/completions",
    headers: { ...CHAT_REQ_HEADERS, "x-opencode-session": "WI03-SESSION-ERR-400" },
    body: {
      model: "wi03-synthetic-chat-model",
      messages: [{ role: "user", content: "wire inspector error 400 test" }],
      stream: false,
    },
    accountAlias: "wi02-synthetic-go",
    upstreamStatus: 400,
    upstreamHeaders: {
      "content-type": "application/json",
      "x-request-id": "WI03-ERR-400",
      "x-wi03-upstream": "error-400",
    },
    responseKind: "json",
    jsonBody: { error: { type: "synthetic_bad_request", message: "WI03 synthetic 400" } },
    expectedObservationProfile: ["status", "x-request-id", "body"],
  },
  {
    id: "error-401",
    description: "Synthetic upstream 401 JSON error (GO lane; provider-side fiction, no real credential).",
    requestScenarioId: "chat-completions-rich",
    lane: "go",
    method: "POST",
    clientPath: "/go/v1/chat/completions",
    headers: { ...CHAT_REQ_HEADERS, "x-opencode-session": "WI03-SESSION-ERR-401" },
    body: {
      model: "wi03-synthetic-chat-model",
      messages: [{ role: "user", content: "wire inspector error 401 test" }],
      stream: false,
    },
    accountAlias: "wi02-synthetic-go",
    upstreamStatus: 401,
    upstreamHeaders: {
      "content-type": "application/json",
      "x-request-id": "WI03-ERR-401",
      "x-wi03-upstream": "error-401",
    },
    responseKind: "json",
    jsonBody: { error: { type: "synthetic_auth_error", message: "WI03 synthetic 401" } },
    expectedObservationProfile: ["status", "x-request-id", "body"],
  },
  {
    id: "error-422",
    description: "Synthetic upstream 422 JSON error (GO lane; proxy-behavior observation only, not H0 classification).",
    requestScenarioId: "chat-completions-rich",
    lane: "go",
    method: "POST",
    clientPath: "/go/v1/chat/completions",
    headers: { ...CHAT_REQ_HEADERS, "x-opencode-session": "WI03-SESSION-ERR-422" },
    body: {
      model: "wi03-synthetic-chat-model",
      messages: [{ role: "user", content: "wire inspector error 422 test" }],
      stream: false,
    },
    accountAlias: "wi02-synthetic-go",
    upstreamStatus: 422,
    upstreamHeaders: {
      "content-type": "application/json",
      "x-request-id": "WI03-ERR-422",
      "x-wi03-upstream": "error-422",
    },
    responseKind: "json",
    jsonBody: { error: { type: "synthetic_validation_error", message: "WI03 synthetic 422" } },
    expectedObservationProfile: ["status", "x-request-id", "body"],
  },
  {
    id: "error-429",
    description: "Synthetic upstream 429 with retry/rate-limit headers (GO lane).",
    requestScenarioId: "chat-completions-rich",
    lane: "go",
    method: "POST",
    clientPath: "/go/v1/chat/completions",
    headers: { ...CHAT_REQ_HEADERS, "x-opencode-session": "WI03-SESSION-ERR-429" },
    body: {
      model: "wi03-synthetic-chat-model",
      messages: [{ role: "user", content: "wire inspector error 429 test" }],
      stream: false,
    },
    accountAlias: "wi02-synthetic-go",
    upstreamStatus: 429,
    upstreamHeaders: {
      "content-type": "application/json",
      "x-request-id": "WI03-ERR-429",
      "x-wi03-upstream": "error-429",
      "retry-after": "7",
      "x-ratelimit-limit-requests": "100",
      "x-ratelimit-remaining-requests": "0",
      "x-ratelimit-reset-requests": "7s",
    },
    responseKind: "json",
    jsonBody: { error: { type: "synthetic_rate_limit", message: "WI03 synthetic 429" } },
    expectedObservationProfile: ["status", "retry-after", "rate-limit-headers", "body"],
  },
  {
    id: "error-500",
    description: "Synthetic upstream 500 JSON error (GO lane).",
    requestScenarioId: "chat-completions-rich",
    lane: "go",
    method: "POST",
    clientPath: "/go/v1/chat/completions",
    headers: { ...CHAT_REQ_HEADERS, "x-opencode-session": "WI03-SESSION-ERR-500" },
    body: {
      model: "wi03-synthetic-chat-model",
      messages: [{ role: "user", content: "wire inspector error 500 test" }],
      stream: false,
    },
    accountAlias: "wi02-synthetic-go",
    upstreamStatus: 500,
    upstreamHeaders: {
      "content-type": "application/json",
      "x-request-id": "WI03-ERR-500",
      "x-wi03-upstream": "error-500",
    },
    responseKind: "json",
    jsonBody: { error: { type: "synthetic_internal_error", message: "WI03 synthetic 500" } },
    expectedObservationProfile: ["status", "x-request-id", "body"],
  },
];

export function listResponseScenarios(): ResponseScenario[] {
  return SCENARIOS.map((s) => ({
    ...s,
    headers: { ...s.headers },
    upstreamHeaders: { ...s.upstreamHeaders },
    body: structuredClone(s.body),
    jsonBody: s.jsonBody === undefined ? undefined : structuredClone(s.jsonBody),
    sseWrites: s.sseWrites === undefined ? undefined : [...s.sseWrites],
  }));
}

export function getResponseScenario(id: string): ResponseScenario {
  const found = SCENARIOS.find((s) => s.id === id);
  if (!found) throw new Error("unknown response scenario '" + id + "'");
  return {
    ...found,
    headers: { ...found.headers },
    upstreamHeaders: { ...found.upstreamHeaders },
    body: structuredClone(found.body),
    jsonBody: found.jsonBody === undefined ? undefined : structuredClone(found.jsonBody),
    sseWrites: found.sseWrites === undefined ? undefined : [...found.sseWrites],
  };
}

/** Substitute the synthetic local key into the credential header. */
export function materializeResponseHeaders(scn: ResponseScenario, localKey: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(scn.headers)) {
    out[k] = v.split(LOCAL_KEY_PLACEHOLDER).join(localKey);
  }
  return out;
}

export const REQUIRED_WI03_SCENARIO_IDS = [
  "chat-json-200",
  "chat-sse-200",
  "responses-sse-200",
  "messages-sse-200",
  "zen-chat-sse-200",
  "error-400",
  "error-401",
  "error-422",
  "error-429",
  "error-500",
] as const;
