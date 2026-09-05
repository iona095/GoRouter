import { describe, test, expect } from "bun:test";
import net from "node:net";
import { createRouterSupervisor, shouldRecycleChild } from "../src/desktop/supervisor.ts";
import { Logger } from "../src/util.ts";

const GRACE = 10_000; // mirrors CHILD_HEALTH_GRACE_MS
const silent = new Logger("error");

describe("F-03: recycle decision (pure seam)", () => {
  test("mature child, one failed probe -> no recycle", () => {
    const now = 100_000;
    expect(shouldRecycleChild({ nowMs: now, childBornAtMs: now - 60_000, unhealthySinceMs: now - 1_000, consecutiveFailures: 1 })).toBe(false);
  });
  test("mature child, two consecutive failures -> recycle", () => {
    const now = 100_000;
    expect(shouldRecycleChild({ nowMs: now, childBornAtMs: now - 60_000, unhealthySinceMs: now - 2_000, consecutiveFailures: 2 })).toBe(true);
  });
  test("newborn child failing inside grace -> no recycle", () => {
    const now = 100_000;
    expect(shouldRecycleChild({ nowMs: now, childBornAtMs: now - 3_000, unhealthySinceMs: now - 3_000, consecutiveFailures: 2 })).toBe(false);
  });
  test("never-healthy child past grace -> recycle", () => {
    const now = 100_000;
    expect(shouldRecycleChild({ nowMs: now, childBornAtMs: now - 12_000, unhealthySinceMs: now - 12_000, consecutiveFailures: 6 })).toBe(true);
  });
  test("healthy child (no unhealthiness) -> no recycle", () => {
    const now = 100_000;
    expect(shouldRecycleChild({ nowMs: now, childBornAtMs: now - 60_000, unhealthySinceMs: 0, consecutiveFailures: 0 })).toBe(false);
  });
});

test("F-03 integration: one failed probe never kills a mature managed child; sustained failure recycles", async () => {
  const BODY = JSON.stringify({ status: "ok", version: "9.9-test" });
  const sockets = new Set<net.Socket>();
  let blackholed = false;
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    socket.on("data", () => {
      if (blackholed) return; // accept but never answer: probe fails
      socket.write("HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: " + Buffer.byteLength(BODY) + "\r\nconnection: close\r\n\r\n" + BODY);
      socket.end();
    });
  });
  const port: number = await new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const a = server.address();
      if (!a || typeof a !== "object") { reject(new Error("no port")); return; }
      resolve(a.port);
    });
  });
  const sup = createRouterSupervisor({
    port: () => port,
    routerCmd: () => ({ argv: ["bun", "-e", "setInterval(() => {}, 1000)"], cwd: process.cwd() }),
    stateDir: "",
    probeIntervalMs: 1000,
    backoffMs: [200, 200, 200, 200, 200],
    log: silent,
  });
  const cleanup = (): void => {
    try { void sup.stop(); } catch { /* gone */ }
    for (const s of sockets) s.destroy();
    server.close();
  };
  try {
    // Rebind sequence: close the responder so the port is DOWN, start the
    // supervisor (spawns a managed child), then reopen on the same port.
    await new Promise<void>((res) => server.close(() => res()));
    sup.start();
    const tSpawn = Date.now();
    while (sup.snapshot().pid === null && Date.now() - tSpawn < 10000) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(sup.snapshot().pid).not.toBeNull(); // managed child exists
    // Reopen the healthy responder on the same port.
    await new Promise<void>((res, rej) => {
      server.on("error", rej);
      server.listen(port, "127.0.0.1", () => res());
    });
    const tManaged = Date.now();
    while (sup.snapshot().state !== "managed" && Date.now() - tManaged < 10000) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(sup.snapshot().state).toBe("managed");
    const childPid = sup.snapshot().pid;
    // Mature the child past the grace window.
    await new Promise((r) => setTimeout(r, GRACE + 1000));
    expect(sup.snapshot().state).toBe("managed");
    // Phase A: exactly one failed probe must NOT kill the mature child.
    blackholed = true;
    await new Promise((r) => setTimeout(r, 1200));
    blackholed = false;
    await new Promise((r) => setTimeout(r, 1500)); // let the next probe land
    expect(sup.snapshot().restartCount).toBe(0);
    expect(sup.snapshot().pid).toBe(childPid);
    // Phase B: sustained failure must recycle (consecutive-failure hysteresis).
    blackholed = true;
    const tRec = Date.now();
    while (sup.snapshot().restartCount === 0 && Date.now() - tRec < 15000) {
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(sup.snapshot().restartCount).toBeGreaterThan(0);
  } finally {
    blackholed = false;
    cleanup();
  }
}, 90000);
