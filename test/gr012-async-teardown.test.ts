/**
 * GR-012 regression: supervisor teardown is asynchronous.
 *
 * stop()/close()/restart() transition state synchronously but wait out the
 * SIGTERM grace WITHOUT blocking the event loop (the old Bun.sleepSync
 * poll froze the control service for the full grace on every stop). A slow
 * child is still force-killed after the grace — but only the same child.
 */
import { describe, test, expect } from "bun:test";
import net from "node:net";
import { createRouterSupervisor, waitForChildExit } from "../src/desktop/supervisor.ts";
import type { Logger } from "../src/util.ts";

const silent = { debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (!addr || typeof addr !== "object") { reject(new Error("no port")); return; }
      const port = addr.port;
      srv.close(() => resolve(port));
    });
  });
}

async function waitForPid(sup: ReturnType<typeof createRouterSupervisor>): Promise<number> {
  const deadline = Date.now() + 10000;
  for (;;) {
    const pid = sup.snapshot().pid;
    if (pid !== null) return pid;
    if (Date.now() >= deadline) throw new Error("managed child never spawned");
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("GR-012 asynchronous supervisor teardown", () => {
  test("stop() returns a promise and transitions synchronously", async () => {
    const sup = createRouterSupervisor({
      port: () => 1,
      routerCmd: () => ({ argv: ["sleep-forever"], cwd: process.cwd() }),
      stateDir: "",
      probeIntervalMs: 60_000,
      backoffMs: [60_000],
      log: silent,
    });
    const p = sup.stop();
    expect(typeof (p as unknown as { then?: unknown })?.then).toBe("function");
    expect(sup.snapshot().state).toBe("stopped");
    await p;
  }, 15000);

  test("cooperative managed child: prompt stop,loop alive,child reaped", async () => {
    const port = await freePort();
    const sup = createRouterSupervisor({
      port: () => port,
      routerCmd: () => ({ argv: [process.execPath, "-e", "setInterval(() => {}, 100);"], cwd: process.cwd() }),
      stateDir: "",
      probeIntervalMs: 60_000,
      backoffMs: [50],
      log: silent,
    });
    sup.start();
    const pid = await waitForPid(sup);
    expect(isAlive(pid)).toBe(true);
    let ticks = 0;
    const ticker = setInterval(() => { ticks++; }, 5);
    const started = Date.now();
    await sup.stop();
    const elapsed = Date.now() - started;
    clearInterval(ticker);
    expect(elapsed).toBeLessThan(2000);
    if (elapsed >= 100) expect(ticks).toBeGreaterThan(0);
    expect(sup.snapshot().pid).toBeNull();
    expect(isAlive(pid)).toBe(false);
  }, 30000);

  test("slow managed child: loop stays alive across the grace,then force-kill", async () => {
    // A SIGTERM-ignoring child exercises the full grace where the platform
    // delivers SIGTERM to handlers; where SIGTERM terminates outright the
    // child simply exits fast. Either way the loop must stay alive and the
    // same child must be dead afterwards.
    const port = await freePort();
    const sup = createRouterSupervisor({
      port: () => port,
      routerCmd: () => ({ argv: [process.execPath, "-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 100);"], cwd: process.cwd() }),
      stateDir: "",
      probeIntervalMs: 60_000,
      backoffMs: [50],
      log: silent,
    });
    sup.start();
    const pid = await waitForPid(sup);
    let ticks = 0;
    const ticker = setInterval(() => { ticks++; }, 50);
    const started = Date.now();
    await sup.stop();
    const elapsed = Date.now() - started;
    clearInterval(ticker);
    expect(sup.snapshot().pid).toBeNull();
    expect(isAlive(pid)).toBe(false);
    // The grace path (slow child) must show a live loop; a fast platform
    // kill resolves too quickly to tick — only assert when the grace ran.
    if (elapsed > 300) expect(ticks).toBeGreaterThan(0);
  }, 30000);

  test("grace wait never blocks the loop, even for a live child", async () => {
    // node:child_process, like the supervisor's own managed children.
    const { spawn } = await import("node:child_process");
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 100);"], { stdio: "ignore", windowsHide: true });
    const exited = new Promise<void>((r) => child.once("exit", () => r()));
    try {
      let ticks = 0;
      const ticker = setInterval(() => { ticks++; }, 5);
      const started = Date.now();
      await waitForChildExit(child, 500);
      const elapsed = Date.now() - started;
      clearInterval(ticker);
      expect(elapsed).toBeGreaterThanOrEqual(400);
      expect(elapsed).toBeLessThan(1500);
      expect(ticks).toBeGreaterThan(10);
    } finally {
      try { child.kill("SIGKILL"); } catch {}
      await exited;
    }
  }, 15000);
});
