/**
 * R4-002 — mixed malformed escape must not mask encoded local credential (R3-AUD-001).
 * RED on baseline: decodeIncludes returns false for whole pair when any %zz
 * present, so tainted pair is forwarded raw and upstream URL parser
 * reconstructs the credential.
 */
import { describe, test, expect } from "bun:test";
import { stripCredentialFromQuery } from "../src/server.ts";
import { startMockUpstream, startTestRouter, LOCAL_KEY } from "./harness.ts";

// Synthetic credential with encodable bytes: encodeURIComponent(SECRET) !== SECRET,
// so raw includes() cannot see it — only a tolerant decode can. This mirrors a
// real base64url/local credential after full percent-encoding on the wire.
const SECRET = "R4-002 s3cr/et+with space";

function enc(s: string): string { return encodeURIComponent(s); }

describe("R4-002 malformed escape credential containment (unit)", () => {
  test("malformed suffix does not mask encoded credential", () => {
    const q = "?x=" + enc(SECRET) + "%zz&safe=1";
    const r = stripCredentialFromQuery(q, SECRET);
    expect(r.stripped).toBe(true);
    expect(r.search).toBe("?safe=1");
  });
  test("malformed prefix does not mask", () => {
    const q = "?x=%zz" + enc(SECRET) + "&safe=1";
    const r = stripCredentialFromQuery(q, SECRET);
    expect(r.stripped).toBe(true);
    expect(r.search).toBe("?safe=1");
  });
  test("malformed middle does not mask (pair in middle of query)", () => {
    // Tainted pair sits between safe pairs; the malformed token is inside the
    // same pair but the encoded credential remains contiguous after it.
    const q = "?safe=0&x=pre%zzmid" + enc(SECRET) + "post&safe=1";
    const r = stripCredentialFromQuery(q, SECRET);
    expect(r.stripped).toBe(true);
    expect(r.search).toBe("?safe=0&safe=1");
  });
  test("safe malformed pairs without credential stay byte-identical", () => {
    const q = "?x=%zz&y=a%20b&flag";
    const r = stripCredentialFromQuery(q, "definitely-not-present-credential-xyz");
    expect(r.stripped).toBe(false);
    expect(r.search).toBe(q);
  });
  test("safe duplicate adjacent to tainted pair is preserved", () => {
    const q = "?k=keep&x=" + enc(SECRET) + "%zz&k=keep";
    const r = stripCredentialFromQuery(q, SECRET);
    expect(r.stripped).toBe(true);
    expect(r.search).toBe("?k=keep&k=keep");
  });
});

describe("R4-002 end-to-end containment", () => {
  test("tainted mixed pair never reaches upstream; safe pairs verbatim", async () => {
    const upstream = await startMockUpstream((req) => Response.json({ ok: true }));
    const router = await startTestRouter({
      upstreamBase: upstream.baseUrl,
      localKey: SECRET,
      accounts: [{ alias: "a1", key: "sk-test" }],
      routes: { go: "a1" },
    });
    try {
      const auth = "Bearer " + SECRET;
      const rawQ = "?x=" + enc(SECRET) + "%zz&safe=1";
      const res = await fetch(router.baseUrl + "/go/v1/chat/completions" + rawQ, {
        method: "POST",
        // W0 (Amendment A5/A7): success-path dispatch carries a session.
        headers: { authorization: auth, "content-type": "application/json", "x-opencode-session": "conv-w0-test-01" },
        body: JSON.stringify({ model: "m", messages: [] }),
      });
      expect(res.status).toBe(200);
      expect(upstream.requests.length).toBe(1);
      const upUrl = new URL(upstream.requests[0]!.url);
      // Upstream ordinary parsing must not reconstruct the credential.
      expect(upUrl.searchParams.get("x")).toBeNull();
      expect(upUrl.search).toBe("?safe=1");
      // Credential absent in every decoded upstream param value.
      for (const [, v] of upUrl.searchParams) expect(v.includes(SECRET)).toBe(false);
      // And raw upstream query carries no encoded credential either.
      expect(upstream.requests[0]!.url.includes(enc(SECRET))).toBe(false);
    } finally {
      router.stop();
      upstream.stop();
    }
  }, 30000);
});
