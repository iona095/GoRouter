/**
 * Security/privacy tests: no plaintext secrets in state/config/logs/diffs,
 * DPAPI blob opacity, CLI output redaction, local credential distinctness,
 * loopback default, upstream-auth negative control through the router.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMockUpstream, startTestRouter, authHeaders, LOCAL_KEY, type TestRouter } from "./harness.ts";
import { sanitizeForwardHeaders } from "../src/util.ts";

const routers: TestRouter[] = [];
afterEach(() => {
  for (const r of routers.splice(0)) r.stop();
});

describe("sanitizeForwardHeaders strip predicate (slice D single-pass fuse)", () => {
  test("predicate drops matching values in the same copy pass", () => {
    const h = new Headers({ "x-custom": "abc", "x-evil": "has-secret-here", "authorization": "Bearer local" });
    const out = sanitizeForwardHeaders(h, (_name, value) => value.includes("secret"));
    expect(out.get("x-custom")).toBe("abc");
    expect(out.get("x-evil")).toBeNull();
    expect(out.get("authorization")).toBeNull(); // local-only, independent of the predicate
  });

  test("absent predicate preserves the legacy allowlist behavior", () => {
    const h = new Headers({ "x-custom": "abc", host: "example.com" });
    const out = sanitizeForwardHeaders(h);
    expect(out.get("x-custom")).toBe("abc");
    expect(out.get("host")).toBeNull();
  });
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
    const UNICODE_KEY = "emoji-😀-account-secret-0123";
    const router = await newRouter({
      upstreamBase: upstream.baseUrl,
      accounts: [
        { alias: "a1", key: "sk-log-secret-12345" },
        { alias: "u1", key: UNICODE_KEY },
      ],
      routes: { go: "a1", zen: "u1" },
    });
    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => { lines.push(args.join(" ")); };
    try {
      await fetch(`${router.baseUrl}/go/v1/models`, { headers: authHeaders() });
      const health = await fetch(`${router.baseUrl}/healthz`);
      await health.text();
      await fetch(`${router.baseUrl}/go/v1/models`, { headers: { authorization: "Bearer nope" } });
      // a rejected request whose raw target carries the LOCAL credential in a
      // query must not leak it into the rejection log — literal or
      // percent-encoded (a hostile client may encode the echoed key), even
      // when the query also contains a malformed escape (decodeURIComponent
      // would throw; the permissive redaction decode must not skip)
      const { connect } = await import("node:net");
      const port = router.server.port();
      const targets = [
        `POST /go/v1/models?token=${LOCAL_KEY} HTTP/1.1`,
        `POST /go/v1/models?token=${encodeURIComponent(LOCAL_KEY).replace(/%/g, "%25")} HTTP/1.1`,
        `POST /go/v1/models?x=%zz&token=${encodeURIComponent(LOCAL_KEY)} HTTP/1.1`,
      ];
      // a Unicode account key (incl. surrogate-pair emoji) — encoded as
      // UTF-8 percent-escapes OR literal — must not leak in the rejection log
      targets.push(`POST /go/v1/models?acct=${encodeURIComponent(UNICODE_KEY)} HTTP/1.1`);
      targets.push(`POST /go/v1/models?acct=${UNICODE_KEY} HTTP/1.1`);
      for (const reqLine of targets) {
        const sock = connect(port, "127.0.0.1", () => {
          sock.write(`${reqLine}\r\nHost: 127.0.0.1:${port}\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n`);
        });
        sock.setEncoding("utf8");
        sock.on("data", () => {});
        await new Promise((r) => setTimeout(r, 300));
        sock.destroy();
      }
    } finally {
      console.log = originalLog;
    }
    for (const line of lines) {
      expect(line).not.toContain("sk-log-secret-12345");
      expect(line).not.toContain(LOCAL_KEY);
      expect(line).not.toContain("emoji-😀-account-secret-0123");
    }
    upstream.stop();
  });

  test("overlapping known secrets are redacted longest-first (no tail leak)", async () => {
    // Two routed account keys where one is a PREFIX of the other: replacing
    // the short key first would leave the longer secret's tail visible, so
    // journalReject must replace the LONGEST secret first (claim 6).
    const SHORT = "sk-overlap-short-77";
    const LONG = "sk-overlap-short-77-extra";
    const upstream = await startMockUpstream();
    const router = await newRouter({
      upstreamBase: upstream.baseUrl,
      accounts: [
        { alias: "go-acct", key: SHORT },
        { alias: "zen-acct", key: LONG },
      ],
      routes: { go: "go-acct", zen: "zen-acct" },
    });
    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => { lines.push(args.join(" ")); };
    try {
      const { connect } = await import("node:net");
      const port = router.server.port();
      const targets = [
        `POST /go/v1/models?token=${LONG} HTTP/1.1`,
        `POST /zen/v1/models?token=${SHORT} HTTP/1.1`,
      ];
      for (const reqLine of targets) {
        const sock = connect(port, "127.0.0.1", () => {
          sock.write(`${reqLine}\r\nHost: 127.0.0.1:${port}\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n`);
        });
        sock.setEncoding("utf8");
        sock.on("data", () => {});
        await new Promise((r) => setTimeout(r, 300));
        sock.destroy();
      }
    } finally {
      console.log = originalLog;
    }
    for (const line of lines) {
      expect(line).not.toContain(LONG);
      expect(line).not.toContain(SHORT);
      // the tail that WOULD leak if the short prefix were replaced first
      expect(line).not.toContain(LONG.slice(SHORT.length));
      expect(line).not.toContain(LOCAL_KEY);
    }
    // positive control: the rejection log line shows the redacted marker
    // (journalReject's split/join replacement uses "<redacted>"; util.redact's
    // "[REDACTED]" is a separate layer for other credential families)
    expect(lines.some((l) => l.includes("<redacted>"))).toBe(true);
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

  test("redact() masks sk- secrets adjacent to word characters without over-redacting", async () => {
    const { redact } = await import("../src/util.ts");
    const KEY = "sk-synth-acc-SECRET-0123456789abcdef";

    // Word-adjacent placements (F02-01): the old leading-\b bound failed when
    // a word character preceded the 's' of 'sk-' — and a trailing word char
    // is an equally real leak vector (KEY+'yy').
    for (const text of [`xx${KEY}`, `${KEY}yy`, `zz${KEY}zz`, `key=${KEY}`]) {
      expect(redact(text)).toContain("[REDACTED]");
      expect(redact(text)).not.toContain(KEY);
    }

    // Non-over-redaction controls: error-type tokens and short sk- suffixes
    // must survive unchanged.
    expect(redact("GoUsageLimitError")).toBe("GoUsageLimitError");
    expect(redact("AuthError")).toBe("AuthError");
    expect(redact("CreditsError")).toBe("CreditsError");
    expect(redact("ServerError")).toBe("ServerError");
    expect(redact("wrk_x")).toBe("wrk_x");
    expect(redact("sk-abcdefghijk")).toBe("sk-abcdefghijk"); // 11 chars after sk- stays visible
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
