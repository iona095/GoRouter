/**
 * H0 probe contract tests (C03): probe-scoped session + intentional probe
 * User-Agent emission, MissingSessionID/validation narrowing, retained
 * compatible classifications, manual redirect. Synthetic fixture only —
 * no real credentials, no provider contact (containment preflight proves
 * no-external-network for the bound run).
 */
import { describe, test, expect } from "bun:test";
import { probeAccountKey, PROBE_USER_AGENT } from "../src/probe.ts";
import { startMockUpstream } from "./harness.ts";

const SYNTH_KEY = "synth-h0-probe-key-0123456789abcdef";

describe("h0 probe emission contract", () => {
  test("GO and ZEN attempts each emit a probe-scoped session id", async () => {
    for (const lane of ["go", "zen"] as const) {
      const upstream = await startMockUpstream();
      try {
        const r = await probeAccountKey(lane, SYNTH_KEY, upstream.baseUrl);
        expect(r.verdict).toBe("AUTH_PASS_LIVE");
        expect(upstream.requests.length).toBe(1);
        const sent = upstream.requests[0]!.headers.get("x-opencode-session");
        expect(sent).toBeTruthy();
        expect(sent).toMatch(/^[A-Za-z0-9._~-]+$/);
      } finally {
        upstream.stop();
      }
    }
  });

  test("probe emits the intentional GoRouter probe User-Agent, never an agent identity", async () => {
    const upstream = await startMockUpstream();
    try {
      await probeAccountKey("zen", SYNTH_KEY, upstream.baseUrl);
      const ua = upstream.requests[0]!.headers.get("user-agent");
      expect(ua).toBe(PROBE_USER_AGENT);
      expect(ua).toContain("GoRouter-Probe");
    } finally {
      upstream.stop();
    }
  });

  test("retry of one logical attempt reuses its session; distinct attempts differ", async () => {
    const upstream = await startMockUpstream();
    try {
      const attempt = "probe-attempt-reuse-1";
      await probeAccountKey("zen", SYNTH_KEY, upstream.baseUrl, { sessionId: attempt });
      await probeAccountKey("zen", SYNTH_KEY, upstream.baseUrl, { sessionId: attempt });
      const ids = upstream.requests.map((r) => r.headers.get("x-opencode-session"));
      expect(ids).toEqual([attempt, attempt]);
      await probeAccountKey("zen", SYNTH_KEY, upstream.baseUrl);
      await probeAccountKey("zen", SYNTH_KEY, upstream.baseUrl);
      const auto = upstream.requests.slice(2).map((r) => r.headers.get("x-opencode-session"));
      expect(auto[0]).toBeTruthy();
      expect(auto[1]).toBeTruthy();
      expect(auto[0]).not.toBe(auto[1]);
    } finally {
      upstream.stop();
    }
  });
});

describe("h0 probe classification narrowing", () => {
  async function verdictFor(handler: (req: Request) => Response, lane: "go" | "zen" = "zen") {
    const upstream = await startMockUpstream(handler);
    try {
      return await probeAccountKey(lane, SYNTH_KEY, upstream.baseUrl);
    } finally {
      upstream.stop();
    }
  }

  test("400 MissingSessionID -> UNKNOWN (never AUTH_PASS_*)", async () => {
    const r = await verdictFor(() =>
      Response.json({ error: { type: "MissingSessionID", message: "session required" } }, { status: 400 }),
    );
    expect(r.httpStatus).toBe(400);
    expect(r.errorType).toBe("MissingSessionID");
    expect(r.verdict).toBe("UNKNOWN");
  });

  test("422 validation error -> UNKNOWN (never AUTH_PASS_*)", async () => {
    const r = await verdictFor(() =>
      Response.json({ error: { type: "InvalidRequest", message: "bad shape" } }, { status: 422 }),
    );
    expect(r.verdict).toBe("UNKNOWN");
  });

  test("400 without error type -> UNKNOWN", async () => {
    const r = await verdictFor(() => new Response("bad", { status: 400 }));
    expect(r.verdict).toBe("UNKNOWN");
  });

  test("retained: 401 AuthError -> AUTH_FAIL; 404 -> UNKNOWN; 429 quota -> QUOTA", async () => {
    const fail = await verdictFor(() =>
      Response.json({ error: { type: "AuthError", message: "nope" } }, { status: 401 }),
    );
    expect(fail.verdict).toBe("AUTH_FAIL");
    const nf = await verdictFor(() =>
      Response.json({ error: { type: "NotFoundError", message: "gone" } }, { status: 404 }),
    );
    expect(nf.verdict).toBe("UNKNOWN");
    const q = await verdictFor(() =>
      Response.json({ error: { type: "CreditsError", message: "empty" } }, { status: 429 }),
    );
    expect(q.verdict).toBe("AUTH_PASS_QUOTA_STATE");
  });

  test("retained with justification: typed 503 provider state -> AUTH_PASS_UPSTREAM_STATE", async () => {
    // Justification: a typed 5xx provider state means the gateway parsed the
    // key past authentication (rejected keys surface as 401 AuthError on this
    // surface). Generic/typeless 5xx stays UNKNOWN (covered in probe.test.ts).
    const r = await verdictFor(() =>
      Response.json({ error: { type: "ProviderOverloaded", message: "busy" } }, { status: 503 }),
    );
    expect(r.verdict).toBe("AUTH_PASS_UPSTREAM_STATE");
  });

  test("redirect is manual: 302 is not followed", async () => {
    const upstream = await startMockUpstream(() => new Response(null, { status: 302, headers: { location: "http://127.0.0.1:9/elsewhere" } }));
    try {
      const r = await probeAccountKey("zen", SYNTH_KEY, upstream.baseUrl);
      expect(upstream.requests.length).toBe(1);
      expect(r.httpStatus).toBe(302);
      expect(r.verdict).toBe("UNKNOWN");
    } finally {
      upstream.stop();
    }
  });
});
