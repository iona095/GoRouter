import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync, readdirSync, rmSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { wireInspectorMatrix, MATRIX_HEADERS, MATRIX_BODY_FIELDS } from "../src/matrix.ts";
import { REQUIRED_WI02_SCENARIO_IDS } from "../src/scenarios.ts";
import { ALL_SYNTHETIC_LITERALS, wireInspectorRun } from "../src/run.ts";

const WI_ROOT = resolve(import.meta.dir, "..");

function tempOut(): string {
  // Writable-only inside WireInspector: use output/.test-tmp-*
  const base = join(WI_ROOT, "output", ".test-tmp-matrix");
  try { rmSync(base, { recursive: true, force: true }); } catch {}
  const { mkdirSync } = require("node:fs") as typeof import("node:fs");
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, "m-"));
}

describe("WI02 matrix", () => {
  test("matrix runs each supported required scenario exactly once", async () => {
    const outDir = tempOut();
    try {
      const r = await wireInspectorMatrix({ outDir, matrixId: "matrix-wi02-test-001" });
      expect(r.scenarioIds).toEqual([...REQUIRED_WI02_SCENARIO_IDS]);
      for (const id of REQUIRED_WI02_SCENARIO_IDS) {
        const dir = join(r.matrixRoot, id);
        expect(existsSync(dir), id + " dir").toBe(true);
        for (const f of ["run-summary.md", "inbound.sanitized.json", "outbound.sanitized.json", "diff.sanitized.json", "diff.txt", "runtime-record.md", "scenario.json"]) {
          expect(existsSync(join(dir, f)), id + "/" + f).toBe(true);
        }
      }
      for (const f of ["matrix-summary.md", "matrix.sanitized.json", "go-zen-compare.md"]) {
        expect(existsSync(join(r.matrixRoot, f)), f).toBe(true);
      }
      // No extra scenario dirs.
      const subdirs = readdirSync(r.matrixRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
      expect(subdirs).toEqual([...REQUIRED_WI02_SCENARIO_IDS].sort());
    } finally {
      try { rmSync(outDir, { recursive: true, force: true }); } catch {}
    }
  }, 120_000);

  test("matrix handles released families honestly (all six captured, none manufactured)", async () => {
    const outDir = tempOut();
    try {
      const r = await wireInspectorMatrix({ outDir, matrixId: "matrix-wi02-test-002" });
      for (const id of REQUIRED_WI02_SCENARIO_IDS) {
        const meta = JSON.parse(readFileSync(join(r.matrixRoot, id, "scenario.json"), "utf8")) as { outcome: string; support: string };
        expect(meta.outcome).toBe("SUPPORTED_CAPTURED");
        expect(meta.support).toBe("SUPPORTED_CAPTURED");
      }
      const matrix = JSON.parse(readFileSync(join(r.matrixRoot, "matrix.sanitized.json"), "utf8")) as { scenarios: Array<{ outcome: string }> };
      expect(matrix.scenarios.every((s) => s.outcome === "SUPPORTED_CAPTURED")).toBe(true);
    } finally {
      try { rmSync(outDir, { recursive: true, force: true }); } catch {}
    }
  }, 120_000);

  test("aggregate header/body matrices derive from retained per-scenario diffs", async () => {
    const outDir = tempOut();
    try {
      const r = await wireInspectorMatrix({ outDir, matrixId: "matrix-wi02-test-003" });
      const matrix = JSON.parse(readFileSync(join(r.matrixRoot, "matrix.sanitized.json"), "utf8")) as {
        scenarios: Array<{ id: string; session: string; userAgent: string; auth: string; headerRow: Record<string, string> }>;
      };
      for (const row of matrix.scenarios) {
        const diff = JSON.parse(readFileSync(join(r.matrixRoot, row.id, "diff.sanitized.json"), "utf8")) as {
          session: { verdict: string }; userAgent: { verdict: string }; authorization: { classification: string };
        };
        expect(row.session).toBe(diff.session.verdict);
        expect(row.userAgent).toBe(diff.userAgent.verdict);
        expect(row.auth).toBe(diff.authorization.classification);
        for (const h of MATRIX_HEADERS) {
          expect(row.headerRow[h], row.id + ":" + h).toBeTruthy();
        }
      }
      const summary = readFileSync(join(r.matrixRoot, "matrix-summary.md"), "utf8");
      expect(summary).toContain("| Scenario | Lane | Client path | Upstream path | Session | User-Agent | Auth | Body |");
      for (const id of REQUIRED_WI02_SCENARIO_IDS) expect(summary).toContain(id);
      void MATRIX_BODY_FIELDS;
    } finally {
      try { rmSync(outDir, { recursive: true, force: true }); } catch {}
    }
  }, 120_000);

  test("per-scenario evidence matches scenario definitions (no cosmetic labels)", async () => {
    const outDir = tempOut();
    try {
      const r = await wireInspectorMatrix({ outDir, matrixId: "matrix-wi02-test-004" });
      const expectations: Record<string, { path: string; marker: string }> = {
        "chat-completions-stream": { path: "/go/v1/chat/completions", marker: "wi01-synthetic-model" },
        "responses-basic": { path: "/go/v1/responses", marker: "wire inspector responses test" },
        "messages-basic": { path: "/go/v1/messages", marker: "wire inspector messages test" },
        "chat-completions-rich": { path: "/go/v1/chat/completions", marker: "wi02_weather" },
        "header-matrix": { path: "/go/v1/chat/completions", marker: "WI02-SESSION-MATRIX" },
        "zen-chat-baseline": { path: "/zen/v1/chat/completions", marker: "wi02-synthetic-zen-model" },
      };
      for (const [id, exp] of Object.entries(expectations)) {
        const inbound = JSON.parse(readFileSync(join(r.matrixRoot, id, "inbound.sanitized.json"), "utf8")) as { path: string };
        const outbound = JSON.parse(readFileSync(join(r.matrixRoot, id, "outbound.sanitized.json"), "utf8")) as { path: string };
        expect(inbound.path, id + " inbound path").toBe(exp.path);
        expect(outbound.path, id + " upstream path").not.toContain("/go/v1");
        expect(outbound.path, id + " upstream path").not.toContain("/zen/v1");
        const blob = readFileSync(join(r.matrixRoot, id, "inbound.sanitized.json"), "utf8") +
          readFileSync(join(r.matrixRoot, id, "outbound.sanitized.json"), "utf8");
        expect(blob.includes(exp.marker), id + " marker").toBe(true);
      }
      // responses/messages bodies must differ from chat baseline (not relabeled chat).
      const chatBody = readFileSync(join(r.matrixRoot, "chat-completions-stream", "inbound.sanitized.json"), "utf8");
      const respBody = readFileSync(join(r.matrixRoot, "responses-basic", "inbound.sanitized.json"), "utf8");
      const msgBody = readFileSync(join(r.matrixRoot, "messages-basic", "inbound.sanitized.json"), "utf8");
      expect(respBody).not.toBe(chatBody);
      expect(msgBody).not.toBe(chatBody);
    } finally {
      try { rmSync(outDir, { recursive: true, force: true }); } catch {}
    }
  }, 120_000);

  test("redaction holds for rich + header-matrix; matrix literal scan is zero", async () => {
    const outDir = tempOut();
    try {
      const r = await wireInspectorMatrix({ outDir, matrixId: "matrix-wi02-test-005" });
      const walk: string[] = [];
      const rec = (dir: string): void => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          const p = join(dir, e.name);
          if (e.isDirectory()) { rec(p); continue; }
          if (/\.(json|md|txt)$/.test(p)) walk.push(readFileSync(p, "utf8"));
        }
      };
      rec(r.matrixRoot);
      const blob = walk.join("\n");
      for (const lit of ALL_SYNTHETIC_LITERALS) {
        expect(blob.includes(lit), "literal absent").toBe(false);
      }
      expect(blob).toContain("Bearer <REDACTED>");
      void tmpdir;
    } finally {
      try { rmSync(outDir, { recursive: true, force: true }); } catch {}
    }
  }, 120_000);

  test("loopback-only holds across matrix + Main identities unchanged", async () => {
    const outDir = tempOut();
    try {
      const r = await wireInspectorMatrix({ outDir, matrixId: "matrix-wi02-test-006" });
      for (const id of REQUIRED_WI02_SCENARIO_IDS) {
        const outbound = JSON.parse(readFileSync(join(r.matrixRoot, id, "outbound.sanitized.json"), "utf8")) as { syntheticUpstreamEndpoint: string };
        expect(outbound.syntheticUpstreamEndpoint.startsWith("http://127.0.0.1:"), id + " loopback").toBe(true);
        const runtime = readFileSync(join(r.matrixRoot, id, "runtime-record.md"), "utf8");
        expect(runtime.toLowerCase()).toContain("real provider contact: none");
      }
      // Main preservation (read-only git + hash; never modified by WI code).
      const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
      const head = spawnSync("git", ["-C", "M:\\AIFUN\\GoRouter\\Main", "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
      expect(head).toBe("9ace47b9a52aa800b8ba9f2f61c8e3d84d7dd19e");
      void wireInspectorRun;
    } finally {
      try { rmSync(outDir, { recursive: true, force: true }); } catch {}
    }
  }, 120_000);
});
