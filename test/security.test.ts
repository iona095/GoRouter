/**
 * Security/privacy tests: no plaintext secrets in state/config/logs/diffs,
 * DPAPI blob opacity, CLI output redaction, local credential distinctness,
 * loopback default, upstream-auth negative control through the router.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMockUpstream, startTestRouter, authHeaders, type TestRouter } from "./harness.ts";

const routers: TestRouter[] = [];
afterEach(() => {
  for (const r of routers.splice(0)) r.stop();
});

async function newRouter(opts: Parameters<typeof startTestRouter>[0]) {
  const r = await startTestRouter(opts);
  routers.push(r);
  return r;
}

describe("secret-at-rest protections", () => {
  test("state.json contains only secret references, never key material", async () => {
    const upstream = await startMockUpstream();
    const router = await newRouter({ upstreamBase: upstream.baseUrl, accounts: [{ alias: "a1", key: "sk-super-secret-value-12345" }], routes: { go: "a1" } });
    const raw = readFileSync(router.paths.stateJson, "utf8");
    expect(raw).not.toContain("sk-super-secret-value-12345");
    expect(raw).toContain("sec_a1");
    expect(raw).toContain("secretRef");
    upstream.stop();
  });

  test("DPAPI blob file does not contain the plaintext key", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gorouter-dpapi-"));
    try {
      const { createSecretStore } = await import("../src/secret-store.ts");
      const store = createSecretStore(join(dir, "secrets"));
      store.put("sec_x", "sk-plaintext-key-value-999");
      const blob = readFileSync(join(dir, "secrets", "sec_x.bin"), "utf8");
      expect(blob).not.toContain("sk-plaintext-key-value-999");
      expect(store.get("sec_x")).toBe("sk-plaintext-key-value-999");
      store.delete("sec_x");
      expect(store.exists("sec_x")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("local client credential is distinct from account credentials and validated locally", async () => {
    const upstream = await startMockUpstream();
    const router = await newRouter({
      upstreamBase: upstream.baseUrl,
      accounts: [{ alias: "a1", key: "sk-account-key-777" }],
      routes: { go: "a1" },
    });
    // the local key is NOT an account key; upstream must never see it
    const res = await fetch(`${router.baseUrl}/go/v1/models`, {
      headers: { authorization: `Bearer ${"sk-account-key-777"}` }, // account key used as local cred -> rejected
    });
    expect(res.status).toBe(401);
    expect(upstream.requests.length).toBe(0);
    upstream.stop();
  });

  test("logs and diagnostics never contain account keys", async () => {
    const upstream = await startMockUpstream(() => Response.json({ ok: true }));
    const router = await newRouter({ upstreamBase: upstream.baseUrl, accounts: [{ alias: "a1", key: "sk-log-secret-12345" }], routes: { go: "a1" } });
    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => { lines.push(args.join(" ")); };
    try {
      await fetch(`${router.baseUrl}/go/v1/models`, { headers: authHeaders() });
      const health = await fetch(`${router.baseUrl}/healthz`);
      await health.text();
      await fetch(`${router.baseUrl}/go/v1/models`, { headers: { authorization: "Bearer nope" } });
    } finally {
      console.log = originalLog;
    }
    for (const line of lines) expect(line).not.toContain("sk-log-secret-12345");
    upstream.stop();
  });
});

describe("redaction coverage", () => {
  test("redact() masks all credential families the router handles", async () => {
    const { redact } = await import("../src/util.ts");
    expect(redact("key sk-abcdefghijklmnop12345")).toContain("[REDACTED]");
    expect(redact("Bearer sk-abcdefghijklmnop12345")).toContain("[REDACTED]");
    expect(redact("token eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c")).toContain("[REDACTED]");
    expect(redact("gemini AIzaSyA123456789012345678901234567890123456")).toContain("[REDACTED]");
    expect(redact("ordinary text without secrets")).not.toContain("[REDACTED]");
  });
});

describe("loopback and upstream safety", () => {
  test("default settings bind loopback", async () => {
    const upstream = await startMockUpstream();
    const router = await newRouter({ upstreamBase: upstream.baseUrl, accounts: [{ alias: "a1", key: "k" }], routes: { go: "a1" } });
    expect(router.state.read().settings.host).toBe("127.0.0.1");
    const health = (await (await fetch(`${router.baseUrl}/healthz`)).json()) as { loopbackOnly: boolean };
    expect(health.loopbackOnly).toBe(true);
    upstream.stop();
  });

  test("request input cannot select a different upstream host", async () => {
    const upstream = await startMockUpstream();
    const router = await newRouter({ upstreamBase: upstream.baseUrl, accounts: [{ alias: "a1", key: "k" }], routes: { go: "a1" } });
    // absolute-form URL or host header tricks must still hit the fixed authority
    const res = await fetch(`${router.baseUrl}/go/v1/models`, {
      headers: authHeaders({ host: "evil.example.com" }),
    });
    expect(res.status).toBe(200);
    expect(upstream.requests.length).toBe(1);
    expect(upstream.requests[0]!.headers.get("host")).toBe(`127.0.0.1:${upstream.port}`);
    upstream.stop();
  });

  test("upstream invalid-key negative control returns AuthError, not a local fallback", async () => {
    let calls = 0;
    const upstream = await startMockUpstream(() => {
      calls++;
      return Response.json({ type: "error", error: { type: "AuthError", message: "Invalid API key." } }, { status: 401 });
    });
    const router = await newRouter({ upstreamBase: upstream.baseUrl, accounts: [{ alias: "a1", key: "sk-bogus" }], routes: { go: "a1" } });
    const res = await fetch(`${router.baseUrl}/go/v1/chat/completions`, { method: "POST", headers: authHeaders(), body: "{}" });
    expect(res.status).toBe(401);
    expect(calls).toBe(1);
    const body = (await res.json()) as { error: { type: string } };
    expect(body.error.type).toBe("AuthError");
    upstream.stop();
  });
});
