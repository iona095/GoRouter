/**
 * R4-004 generation test.
 */
import { describe, test, expect } from "bun:test";
import net from "node:net";
import { createHmac } from "node:crypto";
import { createRouterSupervisor } from "../src/desktop/supervisor.ts";

const SECRET = "r4004-test-secret";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function proofBody(challenge: string): string {
  const proof = createHmac("sha256", SECRET).update(challenge, "utf8").digest("hex");
  return JSON.stringify({ status: "ok", version: "1.0.0-fake", challenge, proof });
}

function extractChallenge(raw: string): string | null {
  const m = /x-gorouter-challenge:\s*([^\r\n]+)/i.exec(raw);
  return m ? m[1]!.trim() : null;
}

async function startDelayedResponder(mode: "proof" | "foreign404") {
  let releaseGate: () => void = () => {};
  const gate = new Promise<void>((r) => { releaseGate = r; });
  let accepted = false;
  const srv = net.createServer((sock) => {
    accepted = true;
    let buf = "";
    sock.setEncoding("utf8");
    sock.on("data", (d: string) => {
      buf += d;
      if (buf.indexOf("\r\n\r\n") !== -1) {
        sock.removeAllListeners("data");
        void (async () => {
          await gate;
          if (mode === "proof") {
            const ch = extractChallenge(buf) || "";
            const body = proofBody(ch);
            sock.write("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: " + Buffer.byteLength(body) + "\r\nConnection: close\r\n\r\n" + body);
          } else {
            sock.write("HTTP/1.1 404 Not Found\r\nContent-Length: 9\r\nConnection: close\r\n\r\nnot found");
          }
          sock.end();
        })();
      }
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = (srv.address() as net.AddressInfo).port;
  return { port, accepted: () => accepted, release: () => releaseGate(), close: () => new Promise<void>((r) => srv.close(() => r())) };
}

async function startImmediateResponder(mode: "proof" | "foreign404") {
  const srv = net.createServer((sock) => {
    let buf = "";
    sock.setEncoding("utf8");
    sock.on("data", (d: string) => {
      buf += d;
      if (buf.indexOf("\r\n\r\n") !== -1) {
        sock.removeAllListeners("data");
        if (mode === "proof") {
          const ch = extractChallenge(buf) || "";
          const body = proofBody(ch);
          sock.write("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: " + Buffer.byteLength(body) + "\r\nConnection: close\r\n\r\n" + body);
        } else {
          sock.write("HTTP/1.1 404 Not Found\r\nContent-Length: 9\r\nConnection: close\r\n\r\nnot found");
        }
        sock.end();
      }
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = (srv.address() as net.AddressInfo).port;
  return { port, close: () => new Promise<void>((r) => srv.close(() => r())) };
}

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() >= deadline) throw new Error("waitFor timed out");
    await sleep(25);
  }
}

describe("R4-004 supervisor generation", () => {
  test("stale success cannot overwrite new port_conflict", async () => {
    const oldDelayed = await startDelayedResponder("proof");
    const fresh = await startImmediateResponder("foreign404");
    let currentPort = oldDelayed.port;
    const sup = createRouterSupervisor({
      port: () => currentPort,
      localCredential: () => SECRET,
      routerCmd: () => ({ argv: ["node", "-e", "setInterval(()=>{},1000000)"], cwd: process.cwd() }),
      stateDir: process.cwd(),
      probeIntervalMs: 60_000,
      backoffMs: [5_000, 10_000],
    });
    try {
      sup.start();
      await waitFor(() => oldDelayed.accepted(), 5_000);
      await sup.stop();
      currentPort = fresh.port;
      sup.start();
      await waitFor(() => sup.snapshot().state === "port_conflict", 5_000);
      oldDelayed.release();
      await sleep(600);
      expect(sup.snapshot().state).toBe("port_conflict");
    } finally {
      await sup.stop();
      await sup.close(true);
      await oldDelayed.close();
      await fresh.close();
    }
  }, 30000);

  test("stale failure cannot disturb new valid attach", async () => {
    const oldDelayed = await startDelayedResponder("foreign404");
    const fresh = await startImmediateResponder("proof");
    let currentPort = oldDelayed.port;
    const sup = createRouterSupervisor({
      port: () => currentPort,
      localCredential: () => SECRET,
      routerCmd: () => ({ argv: ["node", "-e", "setInterval(()=>{},1000000)"], cwd: process.cwd() }),
      stateDir: process.cwd(),
      probeIntervalMs: 60_000,
      backoffMs: [5_000, 10_000],
    });
    try {
      sup.start();
      await waitFor(() => oldDelayed.accepted(), 5_000);
      await sup.stop();
      currentPort = fresh.port;
      sup.start();
      await waitFor(() => sup.snapshot().state === "attached", 5_000);
      const pidBefore = sup.snapshot().pid;
      oldDelayed.release();
      await sleep(600);
      expect(sup.snapshot().state).toBe("attached");
      expect(sup.snapshot().pid).toBe(pidBefore);
    } finally {
      await sup.stop();
      await sup.close(true);
      await oldDelayed.close();
      await fresh.close();
    }
  }, 30000);
});
