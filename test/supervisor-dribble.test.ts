/**
 * F-02 — a dribbling loopback listener must not permanently brick supervision.
 *
 * net.connect({timeout}) is an INACTIVITY timer: a responder that dribbles
 * 1 byte periodically resets it forever. Pre-fix the probe never settled,
 * the tick() latch (cleared only in its own finally) stranded, and
 * teardown() never reset it — start/stop/restart became permanent no-ops
 * while the buffer grew without bound.
 */
import { test, expect } from "bun:test";
import net from "node:net";
import { createRouterSupervisor, probeRouterHealth } from "../src/desktop/supervisor.ts";

function listenOn(fn: (port: number) => Promise<void>): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    // Dribbler: 1 byte every 200ms, never a full response, never closes.
    const t = setInterval(() => {
      try { socket.write("x"); } catch { /* gone */ }
    }, 200);
    socket.on("close", () => { clearInterval(t); sockets.delete(socket); });
  });
  const cleanup = (err?: unknown): void => {
    // Destroy server-side sockets first: the dribble interval otherwise
    // keeps half-closed sockets alive and server.close() never fires.
    for (const s of sockets) s.destroy();
    server.close(() => (err ? reject(err) : resolve()));
  };
  server.on("error", (e) => reject(e));
  server.listen(0, "127.0.0.1", () => {
    const addr = server.address();
    if (!addr || typeof addr !== "object") { reject(new Error("no port")); return; }
    Promise.resolve(fn(addr.port)).then(
      () => cleanup(),
      (e) => cleanup(e),
    );
  });
  return promise;
}

async function waitFor(cond: () => boolean, ms: number): Promise<boolean> {
  const t0 = Date.now();
  while (!cond() && Date.now() - t0 < ms) {
    await new Promise((r) => setTimeout(r, 100));
  }
  return cond();
}

test("F-02: probeRouterHealth settles against a dribbling responder", async () => {
  await listenOn(async (port) => {
    const r = await probeRouterHealth(port);
    expect(r.ok).toBe(false);
    expect(r.busy).toBe(true);
  });
}, 15000);

test("F-02: probeRouterHealth caps accumulation against a flooding responder", async () => {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    // Flood 1 MiB fast, never close: the byte cap must settle the probe anyway.
    const chunk = Buffer.alloc(64 * 1024, "y");
    for (let i = 0; i < 16; i++) socket.write(chunk);
  });
  const cleanupFlood = (): void => {
    for (const s of sockets) s.destroy();
    server.close(() => resolve());
  };
  server.on("error", (e) => reject(e));
  server.listen(0, "127.0.0.1", () => {
    const addr = server.address();
    if (!addr || typeof addr !== "object") { reject(new Error("no port")); return; }
    probeRouterHealth(addr.port).then(
      (r) => { expect(r.ok).toBe(false); expect(r.busy).toBe(true); cleanupFlood(); },
      (e) => server.close(() => reject(e)),
    );
  });
  await promise;
}, 15000);

test("F-02: supervisor recovers after stop/start against a dribbling port", async () => {
  await listenOn(async (port) => {
    const states: string[] = [];
    const sup = createRouterSupervisor({
      port: () => port,
      routerCmd: () => { throw new Error("must not spawn while port is busy"); },
      stateDir: "",
      probeIntervalMs: 100,
      onStateChange: (s) => states.push(s.state),
    });
    sup.start();
    // The dribbled probe must settle: supervisor leaves 'starting'.
    expect(await waitFor(() => states.includes("port_conflict"), 8000)).toBe(true);
    // stop/start must trigger a NEW probe cycle, not strand on the latch.
    states.length = 0;
    await sup.stop();
    sup.start();
    expect(await waitFor(() => states.includes("port_conflict"), 8000)).toBe(true);
    await sup.stop();
  });
}, 30000);
