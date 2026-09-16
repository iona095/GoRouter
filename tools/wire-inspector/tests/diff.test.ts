import { describe, test, expect } from "bun:test";
import { diffHeaders, compareSession, compareUserAgent, compareAuthRaw, diffBodies, buildDiff } from "../src/diff.ts";
import { normalizeHeadersFromRecord, flattenPaths } from "../src/normalize.ts";

describe("WI01 header normalization", () => {
  test("case-insensitive, original casing preserved", () => {
    const n = normalizeHeadersFromRecord({ "X-Opencode-Session": "A", "content-type": "application/json" });
    expect(n.lower["x-opencode-session"]).toBe("A");
    expect(n.originalCase["x-opencode-session"]).toBe("X-Opencode-Session");
  });
});

describe("WI01 session comparison", () => {
  test("preserved unchanged", () => {
    expect(compareSession("WI01-SESSION-001", "WI01-SESSION-001").verdict).toBe("PRESERVED_UNCHANGED");
  });
  test("removed / changed / absent", () => {
    expect(compareSession("A", null).verdict).toBe("REMOVED");
    expect(compareSession("A", "B").verdict).toBe("CHANGED");
    expect(compareSession(null, "B").verdict).toBe("ABSENT_INBOUND");
    expect(compareSession("", "").verdict).toBe("ABSENT_INBOUND");
  });
});

describe("WI01 user-agent comparison", () => {
  test("observed rather than assumed", () => {
    expect(compareUserAgent("WI01-Synthetic-Client/1.0", "WI01-Synthetic-Client/1.0").verdict).toBe("PRESERVED_UNCHANGED");
    expect(compareUserAgent("A", "B").verdict).toBe("CHANGED");
    expect(compareUserAgent("A", null).verdict).toBe("REMOVED");
  });
});

describe("WI01 authorization semantics", () => {
  test("replaced when raw values differ (in-memory only)", () => {
    const p = compareAuthRaw("Bearer LOCAL-AAA", "Bearer ACCOUNT-BBB");
    expect(p.classification).toBe("REPLACED_BY_GOROUTER");
    expect(p.inbound.value).toBe("Bearer <REDACTED>");
    expect(p.outbound.value).toBe("Bearer <REDACTED>");
    expect(p.inbound.present).toBe(true);
  });
  test("preserved only when byte-identical", () => {
    expect(compareAuthRaw("Bearer SAME", "Bearer SAME").classification).toBe("PRESERVED_UNCHANGED");
  });
  test("sanitized re-diff never claims preserved from redacted equality", () => {
    const p = compareAuthRaw("Bearer <REDACTED>", "Bearer <REDACTED>");
    expect(p.classification).toBe("REPLACED_BY_GOROUTER");
  });
});

describe("WI01 JSON semantic diff", () => {
  test("ignores key order, reports paths", () => {
    const a = { model: "m", stream: true, messages: [{ role: "user", content: "hi" }] };
    const b = { stream: true, model: "m", messages: [{ role: "user", content: "hi" }] };
    const d = diffBodies(a, b);
    expect(d.identical).toBe(true);
    expect(d.added).toEqual([]);
  });
  test("added/removed/changed paths", () => {
    const d = diffBodies({ model: "m", stream: true }, { model: "m2", stream: true, tools: [] });
    expect(d.changed).toContain("model");
    expect(d.added.some((p) => p.startsWith("tools"))).toBe(true);
  });
  test("flatten paths shape", () => {
    const m = flattenPaths({ messages: [{ content: "x" }] });
    expect(m.get("messages[0].content")).toBe('"x"');
  });
});

describe("WI01 header diff classifications", () => {
  test("added/removed/changed/transport/routing/redacted", () => {
    const rows = diffHeaders(
      { "x-opencode-session": "S", "user-agent": "UA", authorization: "Bearer L", "x-gorouter-correlation-id": "c", host: "a", "x-extra": "1" },
      { "x-opencode-session": "S", "user-agent": "UA2", authorization: "Bearer A", host: "b", "x-new": "2" },
    );
    const by = Object.fromEntries(rows.map((r) => [r.header, r.classification]));
    expect(by["x-opencode-session"]).toBe("UNCHANGED");
    expect(by["user-agent"]).toBe("CHANGED BY GOROUTER");
    expect(by["authorization"]).toBe("REDACTED");
    expect(by["x-gorouter-correlation-id"]).toBe("ROUTING-ONLY / NOT FORWARDED");
    expect(by["host"]).toBe("TRANSPORT-DERIVED");
    expect(by["x-extra"]).toBe("REMOVED BY GOROUTER");
    expect(by["x-new"]).toBe("ADDED BY GOROUTER");
  });
  test("buildDiff answers the six WI01 questions", () => {
    const d = buildDiff(
      { method: "POST", path: "/go/v1/chat/completions", query: "", headers: { authorization: "Bearer L", "x-opencode-session": "WI01-SESSION-001", "user-agent": "WI01-Synthetic-Client/1.0" }, body: { model: "m", stream: true } },
      { method: "POST", path: "/chat/completions", query: "", headers: { authorization: "Bearer A", "x-opencode-session": "WI01-SESSION-001", "user-agent": "WI01-Synthetic-Client/1.0" }, body: { model: "m", stream: true } },
    );
    expect(d.session.verdict).toBe("PRESERVED_UNCHANGED");
    expect(d.userAgent.verdict).toBe("PRESERVED_UNCHANGED");
    expect(d.authorization.classification).toBe("REPLACED_BY_GOROUTER");
    expect(d.body.identical).toBe(true);
  });
});
