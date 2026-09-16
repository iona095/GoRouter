import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, readFileSync, readdirSync, rmSync, mkdirSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { wireResponseMatrix } from "../src/response-matrix.ts";
import { REQUIRED_WI03_SCENARIO_IDS } from "../src/response-scenarios.ts";
import { ALL_SYNTHETIC_LITERALS } from "../src/run.ts";

const WI_ROOT = resolve(import.meta.dir, "..");
let matrixRoot = "";

function readJson(rel: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(matrixRoot, rel), "utf8")) as Record<string, unknown>;
}

beforeAll(async () => {
  const base = join(WI_ROOT, "output", ".test-tmp-response");
  try { rmSync(base, { recursive: true, force: true }); } catch {}
  mkdirSync(base, { recursive: true });
  const outDir = mkdtempSync(join(base, "m-"));
  const r = await wireResponseMatrix({ outDir, matrixId: "response-matrix-wi03-test-001" });
  matrixRoot = r.matrixRoot;
}, 180_000);

afterAll(() => {
  try { rmSync(join(WI_ROOT, "output", ".test-tmp-response"), { recursive: true, force: true }); } catch {}
});

describe("WI03 response matrix", () => {
  test("runs all ten scenarios with full retained evidence", () => {
    for (const id of REQUIRED_WI03_SCENARIO_IDS) {
      const dir = join(matrixRoot, id);
      expect(existsSync(dir), id + " dir").toBe(true);
      for (const f of [
        "request-inbound.sanitized.json",
        "request-outbound.sanitized.json",
        "request-diff.sanitized.json",
        "upstream-response.sanitized.json",
        "client-response.sanitized.json",
        "response-diff.sanitized.json",
        "response-diff.txt",
        "runtime-response-record.md",
        "response-scenario.json",
        "response-summary.md",
      ]) {
        expect(existsSync(join(dir, f)), id + "/" + f).toBe(true);
      }
    }
    for (const f of ["response-matrix-summary.md", "response-matrix.sanitized.json", "go-zen-response-compare.md", "family-response-compare.md"]) {
      expect(existsSync(join(matrixRoot, f)), f).toBe(true);
    }
  });

  test("400/401/422/429/500 statuses propagate to the client", () => {
    for (const [id, status] of [["error-400", 400], ["error-401", 401], ["error-422", 422], ["error-429", 429], ["error-500", 500]] as const) {
      const diff = readJson(id + "/response-diff.sanitized.json") as { status: { upstream: number; client: number; verdict: string } };
      expect(diff.status.upstream, id).toBe(status);
      expect(diff.status.client, id).toBe(status);
      expect(diff.status.verdict, id).toBe("STATUS_PRESERVED");
    }
  });

  test("429 retry-after and rate-limit headers reach the client", () => {
    const diff = readJson("error-429/response-diff.sanitized.json") as {
      headers: Array<{ header: string; verdict: string; upstream: string | null; client: string | null }>;
    };
    const by = Object.fromEntries(diff.headers.map((h) => [h.header, h]));
    expect(by["retry-after"]!.verdict).toBe("PRESERVED_UNCHANGED");
    expect(by["retry-after"]!.client).toBe("7");
    for (const h of ["x-ratelimit-limit-requests", "x-ratelimit-remaining-requests", "x-ratelimit-reset-requests"]) {
      expect(by[h]!.verdict, h).toBe("PRESERVED_UNCHANGED");
    }
    expect(by["x-ratelimit-limit-requests"]!.client).toBe("100");
    expect(by["x-ratelimit-remaining-requests"]!.client).toBe("0");
    expect(by["x-ratelimit-reset-requests"]!.client).toBe("7s");
  });

  test("error bodies propagate byte-identical", () => {
    for (const id of ["error-400", "error-401", "error-422", "error-429", "error-500"]) {
      const diff = readJson(id + "/response-diff.sanitized.json") as { json: { verdict: string } | null };
      expect(diff.json?.verdict, id).toBe("BYTE_IDENTICAL");
    }
  });

  test("chat JSON 200 propagates byte-identical with provider id preserved", () => {
    const diff = readJson("chat-json-200/response-diff.sanitized.json") as {
      status: { verdict: string };
      json: { verdict: string };
      headers: Array<{ header: string; verdict: string; client: string | null }>;
    };
    expect(diff.status.verdict).toBe("STATUS_PRESERVED");
    expect(diff.json.verdict).toBe("BYTE_IDENTICAL");
    const by = Object.fromEntries(diff.headers.map((h) => [h.header, h]));
    expect(by["x-request-id"]!.verdict).toBe("PRESERVED_UNCHANGED");
    expect(by["x-request-id"]!.client).toBe("WI03-UPSTREAM-REQ-CHAT-200");
    expect(by["x-wi03-upstream"]!.client).toBe("chat-json-200");
  });

  test("SSE logical bytes and event order identical in all four streams", () => {
    for (const id of ["chat-sse-200", "responses-sse-200", "messages-sse-200", "zen-chat-sse-200"]) {
      const diff = readJson(id + "/response-diff.sanitized.json") as {
        sse: { bytesVerdict: string; sequenceVerdict: string; upstreamWrites: number[]; clientReads: number[] } | null;
      };
      expect(diff.sse?.bytesVerdict, id).toBe("LOGICAL_BYTES_IDENTICAL");
      expect(diff.sse?.sequenceVerdict, id).toBe("SSE_EVENT_SEQUENCE_IDENTICAL");
      expect(diff.sse!.upstreamWrites.length).toBeGreaterThan(0);
      expect(diff.sse!.clientReads.length).toBeGreaterThan(0);
    }
  });

  test("messages SSE stays messages-shaped through GoRouter", () => {
    const client = readJson("messages-sse-200/client-response.sanitized.json") as {
      sseEvents: Array<{ event: string | null; data: string }>;
      logicalText: string;
    };
    const names = client.sseEvents.map((e) => e.event);
    for (const n of ["message_start", "content_block_delta", "message_stop"]) {
      expect(names, n).toContain(n);
    }
    expect(client.logicalText).not.toContain("chat.completion.chunk");
  });

  test("responses SSE stays responses-shaped through GoRouter", () => {
    const client = readJson("responses-sse-200/client-response.sanitized.json") as { logicalText: string };
    for (const frag of ["response.created", "response.output_text.delta", "response.completed"]) {
      expect(client.logicalText).toContain(frag);
    }
  });

  test("GO vs ZEN comparison derives from retained evidence", () => {
    const goZen = readFileSync(join(matrixRoot, "go-zen-response-compare.md"), "utf8");
    expect(goZen).toContain("chat-sse-200");
    expect(goZen).toContain("zen-chat-sse-200");
    const go = readJson("chat-sse-200/response-diff.sanitized.json") as { sse: { bytesVerdict: string } };
    const zen = readJson("zen-chat-sse-200/response-diff.sanitized.json") as { sse: { bytesVerdict: string } };
    expect(go.sse.bytesVerdict).toBe("LOGICAL_BYTES_IDENTICAL");
    expect(zen.sse.bytesVerdict).toBe("LOGICAL_BYTES_IDENTICAL");
  });

  test("aggregate summary derives from per-scenario diffs", () => {
    const summary = readFileSync(join(matrixRoot, "response-matrix-summary.md"), "utf8");
    expect(summary).toContain("| Scenario | Family | Lane | Upstream status | Client status | Content-Type | Request-ID | Body/SSE verdict |");
    for (const id of REQUIRED_WI03_SCENARIO_IDS) expect(summary).toContain(id);
    expect(summary).toContain("429");
    expect(summary).toContain("LOGICAL_BYTES_IDENTICAL");
  });

  test("transport headers separated from application headers", () => {
    const diff = readJson("chat-sse-200/response-diff.sanitized.json") as {
      headers: Array<{ header: string; verdict: string }>;
    };
    const by = Object.fromEntries(diff.headers.map((h) => [h.header, h.verdict]));
    expect(by["content-type"]).toBe("PRESERVED_UNCHANGED");
    expect(by["x-gorouter-request-id"]).toBe("ADDED_BY_GOROUTER");
    expect(["TRANSPORT_DERIVED", "ABSENT_BOTH"]).toContain(by["transfer-encoding"]);
    expect(["TRANSPORT_DERIVED", "ABSENT_BOTH"]).toContain(by["content-length"]);
  });

  test("sensitive response headers redacted; literals absent; loopback only", () => {
    const texts: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (/\.(json|md|txt)$/.test(p)) texts.push(readFileSync(p, "utf8"));
      }
    };
    walk(matrixRoot);
    const blob = texts.join("\n");
    for (const lit of ALL_SYNTHETIC_LITERALS) {
      expect(blob.includes(lit)).toBe(false);
    }
    for (const id of REQUIRED_WI03_SCENARIO_IDS) {
      const rt = readFileSync(join(matrixRoot, id, "runtime-response-record.md"), "utf8");
      expect(rt).toContain("127.0.0.1");
      expect(rt.toLowerCase()).toContain("real provider contact: none");
      const req = readJson(id + "/request-outbound.sanitized.json") as { upstreamHost?: string; captured?: boolean };
      if (req.captured !== false) expect(req.upstreamHost!.startsWith("127.0.0.1:")).toBe(true);
    }
  });

  test("Main identities unchanged", () => {
    const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
    const head = spawnSync("git", ["-C", "M:\\AIFUN\\GoRouter\\Main", "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
    const tree = spawnSync("git", ["-C", "M:\\AIFUN\\GoRouter\\Main", "write-tree"], { encoding: "utf8" }).stdout.trim();
    expect(head).toBe("967c98c0cb6df08950b52bba4981942eef702994");
    expect(tree).toBe("747d74d861401b25b91f855889950d870042024a");
  });
});
