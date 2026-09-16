import { describe, test, expect } from "bun:test";
import { getScenario, listScenarios, materializeHeaders, REQUIRED_WI02_SCENARIO_IDS } from "../src/scenarios.ts";
import { wireInspectorRun } from "../src/run.ts";

describe("WI02 scenario registry", () => {
  test("required ids map to real request definitions", () => {
    expect([...REQUIRED_WI02_SCENARIO_IDS]).toEqual([
      "chat-completions-stream",
      "responses-basic",
      "messages-basic",
      "chat-completions-rich",
      "header-matrix",
      "zen-chat-baseline",
    ]);
    const byId = Object.fromEntries(listScenarios().map((s) => [s.id, s]));
    expect(byId["chat-completions-stream"]!.clientPath).toBe("/go/v1/chat/completions");
    expect(byId["responses-basic"]!.clientPath).toBe("/go/v1/responses");
    expect(byId["messages-basic"]!.clientPath).toBe("/go/v1/messages");
    expect(byId["chat-completions-rich"]!.clientPath).toBe("/go/v1/chat/completions");
    expect(byId["header-matrix"]!.clientPath).toBe("/go/v1/chat/completions");
    expect(byId["zen-chat-baseline"]!.clientPath).toBe("/zen/v1/chat/completions");
    for (const s of listScenarios()) {
      expect(s.method).toBe("POST");
      expect(s.routeEvidence.length).toBeGreaterThan(40);
      expect(s.observationProfile.length).toBeGreaterThan(0);
    }
  });

  test("unknown scenario fails closed (never chat/completions)", () => {
    expect(() => getScenario("nope-unknown-xyz")).toThrow("unknown scenario 'nope-unknown-xyz'");
    expect(() => getScenario("")).toThrow("unknown scenario ''");
  });

  test("unknown scenario run rejects (async fail-closed)", async () => {
    await expect(wireInspectorRun({ scenario: "does-not-exist-123" })).rejects.toThrow("unknown scenario 'does-not-exist-123'");
  });

  test("responses cannot accidentally execute chat/completions", () => {
    const s = getScenario("responses-basic");
    expect(s.clientPath).toContain("/responses");
    expect(s.clientPath).not.toContain("chat/completions");
    expect(s.expectedUpstreamPath).toBe("/responses");
    expect(JSON.stringify(s.body)).toContain("wire inspector responses test");
    const rbody = s.body as Record<string, unknown>;
    expect(rbody["input"]).toBe("wire inspector responses test");
    expect("messages" in rbody).toBe(false);
  });

  test("messages cannot accidentally execute chat/completions", () => {
    const s = getScenario("messages-basic");
    expect(s.clientPath).toBe("/go/v1/messages");
    expect(s.expectedUpstreamPath).toBe("/messages");
    // Anthropic auth shape from released tests: x-api-key + anthropic-version, no bearer.
    expect("x-api-key" in s.headers).toBe(true);
    expect("authorization" in s.headers).toBe(false);
    expect(s.headers["anthropic-version"]).toBe("2023-06-01");
    const body = s.body as Record<string, unknown>;
    expect(body["max_tokens"]).toBe(8);
    expect(Array.isArray(body["messages"])).toBe(true);
  });

  test("rich request really includes its configured rich fields", () => {
    const s = getScenario("chat-completions-rich");
    const body = s.body as Record<string, unknown>;
    expect(body["model"]).toBe("wi02-synthetic-rich-model");
    expect(Array.isArray(body["tools"])).toBe(true);
    expect(body["tool_choice"]).toBe("auto");
    expect(body["temperature"]).toBe(0.2);
    expect(body["top_p"]).toBe(0.9);
    expect(body["max_tokens"]).toBe(16);
    const tools = body["tools"] as Array<{ function: { name: string } }>;
    expect(tools[0]!.function.name).toBe("wi02_weather");
    // No invented reasoning field.
    expect("reasoning" in body).toBe(false);
    expect("reasoning_effort" in body).toBe(false);
  });

  test("header matrix really sends its configured headers", () => {
    const s = getScenario("header-matrix");
    const h = materializeHeaders(s, "LOCAL-PLACEHOLDER");
    for (const k of ["x-opencode-session", "x-client-request-id", "x-session-id", "x-session-affinity", "x-gorouter-correlation-id", "x-wi02-test", "user-agent", "accept", "content-type"]) {
      expect(k in h, k + " configured").toBe(true);
    }
    expect(h["x-opencode-session"]).toBe("WI02-SESSION-MATRIX");
    expect(h["x-client-request-id"]).toBe("WI02-CLIENT-REQ-001");
    expect(h["x-session-id"]).toBe("WI02-X-SESSION-ID-001");
    expect(h["x-session-affinity"]).toBe("WI02-AFFINITY-001");
    expect(h["x-gorouter-correlation-id"]).toBe("WI02-CORR-001");
    expect(h["x-wi02-test"]).toBe("WI02-CUSTOM-HEADER");
    // Distinct values: never treat session/correlation headers as equivalent.
    const vals = new Set([h["x-opencode-session"], h["x-client-request-id"], h["x-session-id"], h["x-session-affinity"], h["x-gorouter-correlation-id"]]);
    expect(vals.size).toBe(5);
  });

  test("ZEN scenario actually uses ZEN lane", () => {
    const s = getScenario("zen-chat-baseline");
    expect(s.lane).toBe("zen");
    expect(s.clientPath.startsWith("/zen/v1/")).toBe(true);
    expect(s.accountAlias).toBe("wi02-synthetic-zen");
    expect((s.body as Record<string, unknown>)["model"]).toBe("wi02-synthetic-zen-model");
  });

  test("per-scenario path and body match their definitions", () => {
    for (const s of listScenarios()) {
      const again = getScenario(s.id);
      expect(again.clientPath).toBe(s.clientPath);
      expect(JSON.stringify(again.body)).toBe(JSON.stringify(s.body));
      expect(again.lane).toBe(s.lane);
    }
  });
});
