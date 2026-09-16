import { describe, test, expect } from "bun:test";
import {
  getResponseScenario,
  listResponseScenarios,
  materializeResponseHeaders,
  REQUIRED_WI03_SCENARIO_IDS,
} from "../src/response-scenarios.ts";
import { startCaptureServer } from "../src/capture-server.ts";
import { diffSSE, diffJsonBodies } from "../src/response-diff.ts";

describe("WI03 response scenario registry", () => {
  test("registers all ten required scenarios", () => {
    expect([...REQUIRED_WI03_SCENARIO_IDS]).toEqual([
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
    ]);
    expect(listResponseScenarios().length).toBe(10);
    for (const s of listResponseScenarios()) {
      expect(s.method).toBe("POST");
      expect(s.expectedObservationProfile.length).toBeGreaterThan(0);
      expect(s.requestScenarioId.length).toBeGreaterThan(0);
    }
  });

  test("unknown response scenario fails closed", () => {
    expect(() => getResponseScenario("nope-xyz")).toThrow("unknown response scenario 'nope-xyz'");
    expect(() => getResponseScenario("chat-json-200 ")).toThrow("unknown response scenario");
  });

  test("error-429 carries the required retry/rate-limit contract", () => {
    const s = getResponseScenario("error-429");
    expect(s.upstreamStatus).toBe(429);
    expect(s.upstreamHeaders["retry-after"]).toBe("7");
    expect(s.upstreamHeaders["x-ratelimit-limit-requests"]).toBe("100");
    expect(s.upstreamHeaders["x-ratelimit-remaining-requests"]).toBe("0");
    expect(s.upstreamHeaders["x-ratelimit-reset-requests"]).toBe("7s");
    expect(s.upstreamHeaders["x-request-id"]).toBe("WI03-ERR-429");
  });

  test("error bodies are deterministic synthetic JSON", () => {
    const bodies: Record<string, unknown> = {};
    for (const id of ["error-400", "error-401", "error-422", "error-429", "error-500"] as const) {
      const s = getResponseScenario(id);
      expect(s.responseKind).toBe("json");
      bodies[id] = s.jsonBody;
    }
    expect((bodies["error-400"] as { error: { type: string } }).error.type).toBe("synthetic_bad_request");
    expect((bodies["error-401"] as { error: { type: string } }).error.type).toBe("synthetic_auth_error");
    expect((bodies["error-422"] as { error: { type: string } }).error.type).toBe("synthetic_validation_error");
  });

  test("messages scenario keeps its protocol shape (no OpenAI conversion)", () => {
    const s = getResponseScenario("messages-sse-200");
    expect(s.clientPath).toBe("/go/v1/messages");
    expect("x-api-key" in s.headers).toBe(true);
    const text = (s.sseWrites ?? []).join("");
    for (const name of ["message_start", "content_block_delta", "message_stop"]) {
      expect(text).toContain(name);
    }
    expect(text).not.toContain("chat.completion.chunk");
    expect(text).not.toContain("[DONE]");
  });

  test("responses scenario keeps its protocol shape", () => {
    const s = getResponseScenario("responses-sse-200");
    const text = (s.sseWrites ?? []).join("");
    for (const frag of ["response.created", "response.output_text.delta", "response.completed"]) {
      expect(text).toContain(frag);
    }
  });

  test("zen uses the same logical SSE profile as go chat", () => {
    const go = getResponseScenario("chat-sse-200");
    const zen = getResponseScenario("zen-chat-sse-200");
    expect(zen.lane).toBe("zen");
    expect(zen.clientPath).toBe("/zen/v1/chat/completions");
    expect(zen.sseWrites).toEqual(go.sseWrites);
  });

  test("credential placeholder materializes without leaking shape", () => {
    const s = getResponseScenario("messages-sse-200");
    const h = materializeResponseHeaders(s, "LOCAL-PLACEHOLDER-KEY");
    expect(h["x-api-key"]).toBe("LOCAL-PLACEHOLDER-KEY");
    expect(JSON.stringify(s.headers)).toContain("{{LOCAL_KEY}}");
  });
});

describe("WI03 scripted fixture control", () => {
  test("selected scenario controls the actual fixture response", async () => {
    const s = getResponseScenario("error-422");
    const srv = await startCaptureServer({
      responseProfile: { status: s.upstreamStatus, headers: { ...s.upstreamHeaders }, jsonText: JSON.stringify(s.jsonBody) },
    });
    try {
      const res = await fetch(srv.baseUrl + "/go/v1/chat/completions", { method: "POST", body: "{}" });
      expect(res.status).toBe(422);
      expect(res.headers.get("x-request-id")).toBe("WI03-ERR-422");
      const body = (await res.json()) as { error: { type: string } };
      expect(body.error.type).toBe("synthetic_validation_error");
      expect(srv.scriptedWrites).toEqual([{ index: 0, bytes: JSON.stringify(s.jsonBody).length }]);
    } finally {
      srv.stop();
    }
  });

  test("different scenarios emit different responses (no universal stub)", async () => {
    const a = getResponseScenario("error-400");
    const b = getResponseScenario("error-500");
    const srvA = await startCaptureServer({
      responseProfile: { status: a.upstreamStatus, headers: { ...a.upstreamHeaders }, jsonText: JSON.stringify(a.jsonBody) },
    });
    const srvB = await startCaptureServer({
      responseProfile: { status: b.upstreamStatus, headers: { ...b.upstreamHeaders }, jsonText: JSON.stringify(b.jsonBody) },
    });
    try {
      const [ra, rb] = await Promise.all([
        fetch(srvA.baseUrl + "/x", { method: "POST", body: "{}" }),
        fetch(srvB.baseUrl + "/x", { method: "POST", body: "{}" }),
      ]);
      expect(ra.status).toBe(400);
      expect(rb.status).toBe(500);
      expect(await ra.text()).not.toBe(await rb.text());
    } finally {
      srvA.stop();
      srvB.stop();
    }
  });

  test("SSE writes are recorded per write", async () => {
    const s = getResponseScenario("chat-sse-200");
    const srv = await startCaptureServer({
      responseProfile: { status: 200, headers: { ...s.upstreamHeaders }, sseWrites: [...(s.sseWrites ?? [])], sseWriteDelayMs: 1 },
    });
    try {
      const res = await fetch(srv.baseUrl + "/x");
      const text = await res.text();
      expect(text).toBe((s.sseWrites ?? []).join(""));
      expect(srv.scriptedWrites.length).toBe(3);
      expect(srv.scriptedWrites.map((w) => w.bytes).reduce((a, b) => a + b, 0)).toBe(text.length);
    } finally {
      srv.stop();
    }
  });
});

describe("WI03 logical-vs-transport chunking", () => {
  test("chunk-boundary differences do not imply logical-byte change", () => {
    const text = "data: a\n\ndata: b\n\n";
    const d = diffSSE(text, text, [5, 5], [10]);
    expect(d.bytesVerdict).toBe("LOGICAL_BYTES_IDENTICAL");
    expect(d.sequenceVerdict).toBe("SSE_EVENT_SEQUENCE_IDENTICAL");
    expect(d.chunkingVerdict).toBe("TRANSPORT_CHUNKING_DIFFERENT");
  });

  test("logical change is still detected", () => {
    const d = diffSSE("data: a\n\n", "data: b\n\n", [8], [8]);
    expect(d.bytesVerdict).toBe("LOGICAL_BYTES_CHANGED");
    expect(d.sequenceVerdict).toBe("SSE_EVENT_SEQUENCE_CHANGED");
    expect(d.chunkingVerdict).toBe("TRANSPORT_CHUNKING_IDENTICAL");
  });

  test("json byte vs semantic identity distinguished", () => {
    expect(diffJsonBodies('{"a":1}', '{"a":1}').verdict).toBe("BYTE_IDENTICAL");
    expect(diffJsonBodies('{"a":1,"b":2}', '{"b":2,"a":1}').verdict).toBe("SEMANTICALLY_IDENTICAL");
    expect(diffJsonBodies('{"a":1}', '{"a":2}').verdict).toBe("CHANGED");
  });
});
