/**
 * GR-008 regression: query sanitization preserves raw bytes and removes
 * only the tainted pair. Encoding (%20 vs +), bare keys, duplicate order,
 * and malformed escapes survive; safe duplicates of a stripped key survive.
 */
import { describe, test, expect } from "bun:test";
import { stripCredentialFromQuery } from "../src/server.ts";
import { startMockUpstream, startTestRouter, LOCAL_KEY } from "./harness.ts";

const SECRET = "gr008-local-credential-abcdef";

describe("GR-008 stripCredentialFromQuery", () => {
  test("clean queries pass through byte-identical", () => {
    const cases = [
      "",
      "?x=a%20b&flag",
      "?x=a+b&flag=",
      "?b=2&a=1&b=1",
      "?flag&key&x=%zz&y=%",
      "?q=%2F%3F%26%3D",
      "?x=%25zz",
    ];
    for (const q of cases) {
      const r = stripCredentialFromQuery(q, SECRET);
      expect(r.search).toBe(q);
      expect(r.stripped).toBe(false);
    }
  });

  test("audit repro: encoding kept, safe duplicate kept, tainted pair dropped", () => {
    const r = stripCredentialFromQuery("?x=a%20b&api_key=keep&api_key=" + SECRET + "&flag", SECRET);
    expect(r.search).toBe("?x=a%20b&api_key=keep&flag");
    expect(r.stripped).toBe(true);
  });

  test("percent-encoded credential is detected and dropped verbatim-neighbors kept", () => {
    // A secret with encodable bytes (slashes/spaces): the encoded form must
    // still match, while clean pairs keep their exact bytes.
    const secret = "gr008/s3cr+et with space";
    const encoded = encodeURIComponent(secret);
    expect(encoded).not.toBe(secret);
    const r = stripCredentialFromQuery("?x=a%20b&k=" + encoded + "&y=1", secret);
    expect(r.search).toBe("?x=a%20b&y=1");
    expect(r.stripped).toBe(true);
  });

  test("credential split across name and value is not a carrier (kept)", () => {
    // Neither the name nor the value holds the contiguous secret, so no
    // credential leaks by forwarding it — only whole-secret carriers strip.
    const half = Math.floor(SECRET.length / 2);
    const q = "?" + SECRET.slice(0, half) + "=" + SECRET.slice(half) + "&ok=1";
    const r = stripCredentialFromQuery(q, SECRET);
    expect(r.search).toBe(q);
    expect(r.stripped).toBe(false);
  });

  test("stripping every pair yields an empty query", () => {
    const r = stripCredentialFromQuery("?k=" + SECRET, SECRET);
    expect(r.search).toBe("");
    expect(r.stripped).toBe(true);
  });

  test("empty secret never strips", () => {
    const r = stripCredentialFromQuery("?k=" + SECRET, "");
    expect(r.search).toBe("?k=" + SECRET);
    expect(r.stripped).toBe(false);
  });
});

describe("GR-008 end-to-end query transparency", () => {
  test("raw query reaches upstream verbatim; credential pair is removed", async () => {
    const upstream = await startMockUpstream((req) => Response.json({ ok: true }));
    const router = await startTestRouter({
      upstreamBase: upstream.baseUrl,
      accounts: [{ alias: "a1", key: "sk-test" }],
      routes: { go: "a1" },
    });
    try {
      const auth = "Bearer " + LOCAL_KEY;
      const clean = await fetch(router.baseUrl + "/go/v1/chat/completions?x=a%20b&flag&b=2&b=1", {
        method: "POST",
        headers: { authorization: auth, "content-type": "application/json" },
        body: JSON.stringify({ model: "m", messages: [] }),
      });
      expect(clean.status).toBe(200);
      expect(new URL(upstream.requests[0]!.url).search).toBe("?x=a%20b&flag&b=2&b=1");
      const tainted = await fetch(router.baseUrl + "/go/v1/chat/completions?api_key=keep&api_key=" + encodeURIComponent(LOCAL_KEY) + "&flag", {
        method: "POST",
        headers: { authorization: auth, "content-type": "application/json" },
        body: JSON.stringify({ model: "m", messages: [] }),
      });
      expect(tainted.status).toBe(200);
      expect(new URL(upstream.requests[1]!.url).search).toBe("?api_key=keep&flag");
    } finally {
      router.stop();
      upstream.stop();
    }
  }, 30000);
});
