/**
 * R4-003 — corrupt-state health must remain latched until explicit repair (R3-AUD-002).
 * Full control-core lifecycle: adopted corrupt state.json -> quarantine evidence,
 * stateCorrupt=true, supervisor auto-start stopped, repeated snapshots stay true,
 * explicit setup repairs without process restart.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolvePaths, ensureStateDirs } from "../src/paths.ts";
import { createDomain } from "../src/domain.ts";
import { createControlService } from "../src/desktop/control-core.ts";
import { loadDesktopSettings } from "../src/desktop/desktop-settings.ts";
import { memSecrets } from "./harness.ts";

const ROOT = resolve(import.meta.dir, "..");
const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { await new Promise((r) => setTimeout(r, 200)); try { rmSync(d, { recursive: true, force: true }); } catch {} }
  }
});

async function freePort(): Promise<number> {
  const srv = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("x") });
  const p = srv.port ?? 0;
  srv.stop(true);
  return p;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("R4-003 corrupt-state latch + auto-start", () => {
  test("quarantine latches corrupt, suppresses auto-start, explicit setup repairs", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "gorouter-r4003-"));
    dirs.push(stateDir);
    const paths = resolvePaths(stateDir);
    ensureStateDirs(paths);
    // Onboarding complete so auto-start is otherwise eligible.
    loadDesktopSettings(stateDir).write({
      schemaVersion: 1, startAtLogin: false, minimizeToTray: false, theme: "light",
      firstRunDoneAtUtc: "2026-01-01T00:00:00.000Z", freshStateCreatedAtUtc: null,
    });
    // Seed a valid supported state on a free port, then adopt corruption.
    const port = await freePort();
    const seedSecrets = memSecrets({ sec_desktop_admin: "test-admin-token" });
    const seedDomain = createDomain(paths, seedSecrets);
    seedDomain.setup();
    seedDomain.configSet("port", String(port));
    writeFileSync(paths.stateJson, "{adopted-corrupt-state!!");

    // Fresh process view: new domain + core with a spawn-proving fake router.
    const secrets = memSecrets({ sec_desktop_admin: "test-admin-token" });
    const domain = createDomain(paths, secrets);
    const marker = join(stateDir, "router.marker");
    const core = createControlService({
      paths, secrets, domain, pipeName: "inproc-r4003",
      routerCmd: { argv: [process.execPath, "test/fake-router.ts", "<port>", "--marker", marker], cwd: ROOT },
      probeIntervalMs: 200, backoffMs: [100, 200, 400],
    });
    core.start();
    try {
      await sleep(900);
      // Exactly one quarantine artifact.
      const backups = readdirSync(stateDir).filter((f) => f.startsWith("state.json.corrupt-"));
      expect(backups.length).toBe(1);
      // Health latched.
      expect(core.snapshot().stateCorrupt).toBe(true);
      // Auto-start suppressed.
      expect(core.router.snapshot().state).toBe("stopped");
      expect(existsSync(marker)).toBe(false);
      // Repeated snapshots must NOT self-clear.
      await sleep(600);
      expect(core.snapshot().stateCorrupt).toBe(true);
      expect(domain.status().stateCorrupt).toBe(true);
      expect(core.router.snapshot().state).toBe("stopped");

      // Explicit supported repair without process restart.
      const repair = domain.setup();
      expect(domain.status().stateCorrupt).toBe(false);
      expect(existsSync(paths.stateJson)).toBe(true);
      // Quarantine evidence preserved for forensics.
      const after = readdirSync(stateDir).filter((f) => f.startsWith("state.json.corrupt-"));
      expect(after.length).toBe(1);
      void repair;
    } finally {
      await core.stop(false);
    }
  }, 30000);
});
