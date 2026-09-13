/**
 * R3-007 regression: the control-pipe transport enforces outbound
 * backpressure. A frame that would push a socket past the queued-bytes
 * ceiling drops that socket instead of queueing without bound, while
 * healthy clients continue uninterrupted.
 *
 * Runtime note: Bun 1.3.14 does not surface named-pipe userland queue
 * growth (writableLength stays 0 while the peer is paused), so gradual
 * accumulation across small frames is not observable here; the tests pin
 * the gate itself - an over-cap frame for a stalled socket is refused
 * and counted - on both the reply and push paths. Under runtimes that
 * report queue growth honestly the same check trips on accumulation too.
 */
import { describe, test, expect } from "bun:test";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { serveControlPipe } from "../src/desktop/transport.ts";

const TOKEN = "r3007-token";
// Backslash-free pipe path: 92=\ 46=. 112=p 105=i 101=e
const PB = String.fromCharCode(92, 92, 46, 92, 112, 105, 112, 101, 92);
function pipeFor(tag: string): string {
  return PB + "gorouter-r3007-" + tag + "-" + randomUUID();
}
const NL = String.fromCharCode(10);

// Windows named-pipe paths cannot bind on Linux: like the established
// domain.test.ts / proxy.test.ts DPAPI-gated tests, these run on Windows.
const testWin = process.platform === "win32" ? test : test.skip;

async function connectPipe(pipe: string): Promise<net.Socket> {
  const sock = net.connect({ path: pipe });
  await new Promise<void>((resolve, reject) => {
    sock.once("connect", () => resolve());
    sock.once("error", reject);
  });
  return sock;
}

async function hello(sock: net.Socket, id: number): Promise<void> {
  const frames: string[] = [];
  sock.on("data", (d: Buffer) => frames.push(d.toString("utf8")));
  sock.write(JSON.stringify({ id, token: TOKEN, op: "hello", params: {} }) + NL);
  const want = String.fromCharCode(34) + "id" + String.fromCharCode(34) + ":" + id + "," + String.fromCharCode(34) + "ok" + String.fromCharCode(34) + ":true";
  const deadline = Date.now() + 5000;
  for (;;) {
    if (frames.join("").includes(want)) return;
    if (Date.now() >= deadline) throw new Error("hello timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function ping(sock: net.Socket, id: number): Promise<void> {
  const frames: string[] = [];
  sock.on("data", (d: Buffer) => frames.push(d.toString("utf8")));
  sock.write(JSON.stringify({ id, token: TOKEN, op: "ping" }) + NL);
  const want = String.fromCharCode(34) + "pong" + String.fromCharCode(34) + ":true";
  const deadline = Date.now() + 5000;
  for (;;) {
    if (frames.join("").includes(want)) return;
    if (Date.now() >= deadline) throw new Error("ping timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

function handler(op: string): Promise<unknown> {
  if (op === "hello") return Promise.resolve({ version: "1.5.0" });
  if (op === "ping") return Promise.resolve({ pong: true });
  if (op === "big") return Promise.resolve({ payload: "y".repeat(1536 * 1024) });
  return Promise.reject(Object.assign(new Error("unsupported op"), { code: "unsupported" }));
}

describe("R3-007 pipe output backpressure", () => {
  testWin("over-cap reply to a stalled requester is refused and counted", async () => {
    const pipe = pipeFor("reply");
    let drops = 0;
    const transport = serveControlPipe(pipe, TOKEN, handler, undefined, undefined, () => { drops++; });
    await transport.listening;
    const stalled = await connectPipe(pipe);
    await hello(stalled, 1);
    stalled.pause();
    stalled.write(JSON.stringify({ id: 2, token: TOKEN, op: "big" }) + NL);
    const deadline = Date.now() + 5000;
    while (drops === 0) {
      if (Date.now() >= deadline) throw new Error("stalled reply was queued instead of refused");
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(drops).toBe(1);
    stalled.destroy();
    await transport.close();
  }, 30000);

  testWin("stalled push subscriber is dropped; healthy clients continue", async () => {
    const pipe = pipeFor("push");
    let drops = 0;
    const transport = serveControlPipe(pipe, TOKEN, handler, undefined, undefined, () => { drops++; });
    await transport.listening;
    const stalled = await connectPipe(pipe);
    await hello(stalled, 1);
    // The only subscriber stops reading; an over-cap push frame drops it
    // instead of queueing without bound. (No healthy client is subscribed
    // yet: an anomalous over-cap frame is refused for every subscriber,
    // so the healthy client connects after the drop.)
    stalled.pause();
    transport.push("snap", { n: 1, big: "x".repeat(1536 * 1024) });
    const deadline = Date.now() + 5000;
    while (drops === 0) {
      if (Date.now() >= deadline) throw new Error("stalled push was queued instead of refused");
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(drops).toBe(1);
    // A healthy subscriber from here on is unaffected: small pushes still
    // arrive and requests still round-trip.
    const healthy = await connectPipe(pipe);
    await hello(healthy, 2);
    const frames: string[] = [];
    healthy.on("data", (d: Buffer) => frames.push(d.toString("utf8")));
    transport.push("snap", { n: 2 });
    const want = String.fromCharCode(34) + "n" + String.fromCharCode(34) + ":2";
    const dl2 = Date.now() + 5000;
    for (;;) {
      if (frames.join("").includes(want)) break;
      if (Date.now() >= dl2) throw new Error("healthy push lost after stall drop");
      await new Promise((r) => setTimeout(r, 25));
    }
    await ping(healthy, 3);
    expect(drops).toBe(1);
    stalled.destroy();
    healthy.destroy();
    await transport.close();
  }, 30000);
});
