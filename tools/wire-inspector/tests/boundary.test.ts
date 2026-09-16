import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const TOOL_ROOT = resolve(import.meta.dir, "..");
const MAIN_ROOT = resolve(TOOL_ROOT, "..", "..");

function toolFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(join(TOOL_ROOT, dir), { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) toolFiles(p, out);
    else out.push(p);
  }
  return out;
}

describe("WI P01 integration boundary", () => {
  test("production CLI gains no diagnostic authority", () => {
    const cli = readFileSync(join(MAIN_ROOT, "src", "cli.ts"), "utf8");
    for (const token of ["wire-inspector", "gorouter inspect", "debug-provider"]) {
      expect(cli.includes(token), "prod cli must not contain '" + token + "'").toBe(false);
    }
  });

  test("no duplicated production source inside the tool", () => {
    // NOTE: the tool legitimately owns its own diagnostic entrypoint
    // src/cli.ts (companion command surface), which is not a production fork.
    const names = toolFiles("src").map((p) => p.split(/[\\/]/).pop()!).filter((n) => n !== "cli.ts");
    for (const prod of ["server.ts", "state.ts", "journal.ts", "secret-store.ts", "lock.ts", "paths.ts", "domain.ts", "probe.ts", "inbound-http.ts"]) {
      expect(names.includes(prod), "must not vendor " + prod).toBe(false);
    }
  });

  test("tool imports resolve to canonical Main/src (relative, no forks)", () => {
    const allowedMain = new Set(["paths.ts", "state.ts", "secret-store.ts", "lock.ts", "journal.ts", "server.ts"]);
    for (const rel of toolFiles("src")) {
      const text = readFileSync(join(TOOL_ROOT, rel), "utf8");
      expect(text.includes("../Main/"), rel + " must not reference the sibling tree").toBe(false);
      for (const m of text.matchAll(/from\s+["']([^"']+)["']/g)) {
        const spec = m[1]!;
        if (spec.startsWith("../../../src/")) {
          const base = spec.split("/").pop()!;
          expect(allowedMain.has(base), rel + " imports unexpected Main module " + spec).toBe(true);
          expect(existsSync(join(MAIN_ROOT, "src", base)), spec + " must exist in canonical src").toBe(true);
        } else if (spec.startsWith(".")) {
          expect(spec.startsWith("./") || spec.startsWith("../"), rel).toBe(true);
        }
      }
    }
  });

  test("no static import of historical output into tool source", () => {
    for (const rel of toolFiles("src")) {
      const text = readFileSync(join(TOOL_ROOT, rel), "utf8");
      expect(/from\s+["'][^"']*output\//.test(text), rel + " must not import from output/").toBe(false);
      expect(text.includes("matrix-2026") || text.includes("run-2026"), rel + " must not embed run dirs").toBe(false);
    }
  });

  test("desktop release manifest untouched by this feature", () => {
    const ps1 = readFileSync(join(MAIN_ROOT, "scripts", "build-desktop.ps1"), "utf8");
    expect(ps1.includes("gorouter-wire-inspector")).toBe(false);
    expect(ps1.includes("GoRouterDesktop.exe', 'gorouter-control.exe', 'gorouter-router.exe'") || ps1.includes("'gorouter-router.exe'")).toBe(true);
  });

  test("companion entrypoint exists and production entrypoint unchanged", () => {
    expect(existsSync(join(TOOL_ROOT, "src", "cli.ts"))).toBe(true);
    const prod = readFileSync(join(MAIN_ROOT, "src", "cli.ts"), "utf8");
    expect(prod.includes("unknown command")).toBe(true);
  });
});
