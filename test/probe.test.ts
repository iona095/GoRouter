/**
 * Probe classification tests (mock upstream): the quota-aware evidence rule —
 * auth-passed quota states are credential-dependent and distinct from the
 * invalid-key negative control.
 */
import { describe, test, expect } from "bun:test";
import { probeAccountKey } from "../src/probe.ts";
import { startMockUpstream } from "./harness.ts";

async function probeWith(handler: (req: Request) => Response, lane: "go" | "zen" = "zen") {
  const upstream = await startMockUpstream(handler);
  try {
    return await probeAccountKey(lane, "sk-test-key", upstream.baseUrl);
  } finally {
    upstream.stop();
  }
}

describe("probe classification", () => {
  test("200 -> AUTH_PASS_LIVE", async () => {
    const r = await probeWith(() => Response.json({ id: "x", choices: [] }, { status: 200 }));
    expect(r.verdict).toBe("AUTH_PASS_LIVE");
  });

  test("401 AuthError -> AUTH_FAIL (invalid credential)", async () => {
    const r = await probeWith(() =>
      Response.json({ type: "error", error: { type: "AuthError", message: "Invalid API key." } }, { status: 401 }),
    );
    expect(r.verdict).toBe("AUTH_FAIL");
  });

  test("429 GoUsageLimitError -> AUTH_PASS_QUOTA_STATE (auth passed, quota state)", async () => {
    const r = await probeWith(() =>
      Response.json(
        { type: "error", error: { type: "GoUsageLimitError", message: "Monthly usage limit reached.", metadata: { workspace: "wrk_x" } } },
        { status: 429 },
      ),
    );
    expect(r.verdict).toBe("AUTH_PASS_QUOTA_STATE");
    expect(r.workspaceHint).toBe("wrk_x");
  });

  test("400 server_error (model unavailable) -> UNKNOWN (H0 narrow: 400-class validation failures are never credential evidence)", async () => {
    const r = await probeWith(() =>
      Response.json({ error: { type: "server_error", message: "Error from provider (Console Go): Model is unavailable." } }, { status: 400 }),
    );
    expect(r.verdict).toBe("UNKNOWN");
  });

  test("404 with structured error type -> UNKNOWN (routing failure, not key evidence; D-10)", async () => {
    const r = await probeWith(() =>
      Response.json({ error: { type: "NotFoundError", message: "Model mimo-v2.5-free does not exist." } }, { status: 404 }),
    );
    expect(r.verdict).toBe("UNKNOWN");
  });

  test("generic 500 without error type -> UNKNOWN (not proof)", async () => {
    const r = await probeWith(() => new Response("boom", { status: 500 }));
    expect(r.verdict).toBe("UNKNOWN");
  });

  test("network failure -> UNKNOWN", async () => {
    const upstream = await startMockUpstream();
    const port = upstream.port;
    upstream.stop();
    const r = await probeAccountKey("zen", "sk-test-key", `http://127.0.0.1:${port}`);
    expect(r.verdict).toBe("UNKNOWN");
  });

  test("go probe uses the go model; zen probe uses the free model", async () => {
    let seenModel = "";
    const upstream = await startMockUpstream(async (req) => {
      const body = JSON.parse(await req.text()) as { model: string };
      seenModel = body.model;
      return Response.json({ ok: true }, { status: 200 });
    });
    try {
      await probeAccountKey("go", "k", upstream.baseUrl);
      expect(seenModel).toBe("minimax-m3");
      await probeAccountKey("zen", "k", upstream.baseUrl);
      expect(seenModel).toBe("mimo-v2.5-free");
    } finally {
      upstream.stop();
    }
  });

  test("probe returns RAW upstream error fields (redaction lives only at the CLI/desktop boundary)", async () => {
    // classify() compares errorType against AuthError/GoUsageLimitError/
    // CreditsError verbatim, so probeAccountKey must never pre-redact the
    // provider-controlled fields — the CLI and desktop control service redact
    // at their own output boundaries instead.
    const upstream = await startMockUpstream(() =>
      Response.json(
        {
          type: "error",
          error: {
            type: "GoUsageLimitError",
            message: "quota exceeded: sk-raw-boundary-secret-0123456789",
            metadata: { workspace: "wrk_x" },
          },
        },
        { status: 429 },
      ),
    );
    try {
      const r = await probeAccountKey("zen", "sk-probe-key-raw", upstream.baseUrl);
      expect(r.verdict).toBe("AUTH_PASS_QUOTA_STATE");
      expect(r.errorType).toBe("GoUsageLimitError");
      expect(r.errorMessageBrief).toBe("quota exceeded: sk-raw-boundary-secret-0123456789");
      expect(r.workspaceHint).toBe("wrk_x");
      expect(r.errorType).not.toContain("[REDACTED]");
      expect(r.errorMessageBrief).not.toContain("[REDACTED]");
      expect(r.workspaceHint).not.toContain("[REDACTED]");
    } finally {
      upstream.stop();
    }
  });
});
