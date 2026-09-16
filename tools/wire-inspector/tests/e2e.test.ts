import { describe, test, expect } from "bun:test";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { wireInspectorRun, WI01_LOCAL_KEY, WI01_ACCOUNT_KEY } from "../src/run.ts";

describe("WI01 synthetic end-to-end flow", () => {
  test("client -> GoRouter -> loopback upstream -> sanitized diff", async () => {
    const outDir = join(import.meta.dir, "..", "output");
    const r = await wireInspectorRun({ outDir, scenario: "chat-completions-stream" });
    try {
      for (const f of ["run-summary.md", "inbound.sanitized.json", "outbound.sanitized.json", "diff.sanitized.json", "diff.txt", "runtime-record.md"]) {
        expect(existsSync(join(r.outPath, f)), f + " exists").toBe(true);
      }
      const inbound = JSON.parse(readFileSync(join(r.outPath, "inbound.sanitized.json"), "utf8")) as Record<string, unknown>;
      const outbound = JSON.parse(readFileSync(join(r.outPath, "outbound.sanitized.json"), "utf8")) as Record<string, unknown>;
      const diff = JSON.parse(readFileSync(join(r.outPath, "diff.sanitized.json"), "utf8")) as Record<string, unknown>;
      const summary = readFileSync(join(r.outPath, "run-summary.md"), "utf8");
      const runtime = readFileSync(join(r.outPath, "runtime-record.md"), "utf8");
      const diffTxt = readFileSync(join(r.outPath, "diff.txt"), "utf8");

      // Inbound determinism
      const inHeaders = inbound["headers"] as Record<string, string>;
      // headers are lowercased by Headers iteration; accept either case key
      const sessKey = Object.keys(inHeaders).find((k) => k.toLowerCase() === "x-opencode-session")!;
      expect(inHeaders[sessKey]).toBe("WI01-SESSION-001");
      const body = inbound["body"] as Record<string, unknown>;
      expect(body["model"]).toBe("wi01-synthetic-model");
      expect(body["stream"]).toBe(true);

      // Outbound reached loopback only
      const outEndpoint = String(outbound["syntheticUpstreamEndpoint"] ?? "");
      expect(outEndpoint.startsWith("http://127.0.0.1:")).toBe(true);
      expect(summary).toContain("External network:\nNONE");
      expect(runtime.toLowerCase()).toContain("external network: none");
      expect(runtime.toLowerCase()).toContain("real provider contact: none");

      // Session / UA / auth observations available + sanitized
      expect(JSON.stringify(diff)).toContain("x-opencode-session");
      expect(summary).toContain("x-opencode-session:");
      expect(summary).toContain("User-Agent:");
      expect(summary).toContain("Authorization:");
      expect(summary).toContain("(values redacted)");

      // Raw secrets never reach disk
      for (const f of ["inbound.sanitized.json", "outbound.sanitized.json", "diff.sanitized.json", "diff.txt", "run-summary.md", "runtime-record.md"]) {
        const text = readFileSync(join(r.outPath, f), "utf8");
        expect(text.includes(WI01_LOCAL_KEY), f + " must not contain local key").toBe(false);
        expect(text.includes(WI01_ACCOUNT_KEY), f + " must not contain account key").toBe(false);
      }
      expect(diffTxt.length).toBeGreaterThan(200);

      // No raw capture archives
      const files = readdirSync(r.outPath);
      for (const f of files) {
        expect(f.endsWith(".bin")).toBe(false);
        expect(f.endsWith(".pcap")).toBe(false);
        expect(f.endsWith(".har")).toBe(false);
        expect(f.startsWith("raw-")).toBe(false);
      }
    } finally {
      // Keep the e2e output as the sample sanitized evidence (do not delete).
      // State temp dirs are already removed by run(); only output/<run-id> remains.
    }
  }, 60_000);
});
