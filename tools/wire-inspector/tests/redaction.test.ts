import { describe, test, expect } from "bun:test";
import { isSensitiveHeaderName, redactHeaderValue, sanitizeHeaders, sanitizeBody, isSensitiveBodyKey } from "../src/redaction.ts";

describe("WI01 redaction", () => {
  test("never persists raw authorization", () => {
    expect(redactHeaderValue("authorization", "Bearer SECRET123456789")).toBe("Bearer <REDACTED>");
    expect(redactHeaderValue("Authorization", "Bearer abc")).toBe("Bearer <REDACTED>");
  });
  test("cookies/api-keys/tokens/bootstrap/csrf/admin redacted", () => {
    for (const h of ["cookie", "set-cookie", "x-api-key", "api-key", "x-goog-api-key", "access-token", "refresh-token", "proxy-authorization"]) {
      expect(isSensitiveHeaderName(h)).toBe(true);
      expect(redactHeaderValue(h, "anything-secret")).toBe("<REDACTED>");
    }
    expect(isSensitiveHeaderName("x-bootstrap-token")).toBe(true);
    expect(isSensitiveHeaderName("x-csrf-token")).toBe(true);
    expect(isSensitiveHeaderName("x-admin-token")).toBe(true);
    expect(isSensitiveHeaderName("x-secret-thing")).toBe(true);
    expect(isSensitiveHeaderName("x-password-reset")).toBe(true);
  });
  test("non-sensitive headers pass through", () => {
    expect(isSensitiveHeaderName("x-opencode-session")).toBe(false);
    expect(isSensitiveHeaderName("user-agent")).toBe(false);
    expect(isSensitiveHeaderName("content-type")).toBe(false);
    expect(redactHeaderValue("x-opencode-session", "WI01-SESSION-001")).toBe("WI01-SESSION-001");
  });
  test("sanitizeHeaders returns new redacted record", () => {
    const raw = { authorization: "Bearer LOCALKEY", "x-opencode-session": "WI01-SESSION-001" };
    const out = sanitizeHeaders(raw);
    expect(out["authorization"]).toBe("Bearer <REDACTED>");
    expect(out["x-opencode-session"]).toBe("WI01-SESSION-001");
    expect(raw["authorization"]).toBe("Bearer LOCALKEY"); // input untouched
  });
  test("sensitive body keys redacted, safe keys kept", () => {
    expect(isSensitiveBodyKey("authorization")).toBe(true);
    expect(isSensitiveBodyKey("api_key")).toBe(true);
    expect(isSensitiveBodyKey("access_token")).toBe(true);
    expect(isSensitiveBodyKey("password")).toBe(true);
    expect(isSensitiveBodyKey("model")).toBe(false);
    expect(isSensitiveBodyKey("messages")).toBe(false);
    expect(isSensitiveBodyKey("max_tokens")).toBe(false);
    const out = sanitizeBody({ model: "m", secret: "SHOULD-HIDE", nested: { password: "x", content: "keep" } }) as Record<string, unknown>;
    expect(out["model"]).toBe("m");
    expect(out["secret"]).toBe("<REDACTED>");
    expect((out["nested"] as Record<string, unknown>)["password"]).toBe("<REDACTED>");
    expect((out["nested"] as Record<string, unknown>)["content"]).toBe("keep");
  });
});
