import { describe, test, expect } from "bun:test";
import { assertLoopbackUrl, isAllowedSyntheticUpstream, isLoopbackHost } from "../src/loopback.ts";

describe("WI01 loopback-only enforcement", () => {
  test("allows loopback http", () => {
    expect(isAllowedSyntheticUpstream("http://127.0.0.1:9/")).toBe(true);
    expect(isAllowedSyntheticUpstream("http://localhost:1234/chat")).toBe(true);
    expect(isAllowedSyntheticUpstream("http://[::1]:8080/")).toBe(true);
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
  });
  test("refuses public IPs", () => {
    expect(isAllowedSyntheticUpstream("http://8.8.8.8/")).toBe(false);
    expect(() => assertLoopbackUrl("http://8.8.8.8/")).toThrow();
    expect(() => assertLoopbackUrl("http://192.168.1.10:8080/")).toThrow();
  });
  test("refuses provider DNS and opencode.ai", () => {
    for (const u of ["https://opencode.ai/zen/v1", "https://api.opencode.ai/", "https://example.com/", "https://provider.example/"]) {
      expect(isAllowedSyntheticUpstream(u)).toBe(false);
      expect(() => assertLoopbackUrl(u)).toThrow();
    }
  });
  test("refuses https even on loopback (no TLS MITM)", () => {
    expect(isAllowedSyntheticUpstream("https://127.0.0.1:443/")).toBe(false);
    expect(() => assertLoopbackUrl("https://127.0.0.1:443/")).toThrow();
  });
  test("refuses userinfo", () => {
    expect(() => assertLoopbackUrl("http://user:pass@127.0.0.1:8080/")).toThrow();
  });
});
