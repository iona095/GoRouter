/**
 * GR-005 regression: public /healthz JSON is liveness, not identity.
 *
 * With a credential provider, the probe is ok only for a valid HMAC proof
 * over its own fresh challenge. Static public JSON stays port_conflict;
 * replayed and wrong-state proofs fail; without a provider the legacy
 * public-signature check applies (framing unit tests only).
 */
import { describe, test, expect } from "bun:test";
import net from "node:net";
import { createHmac } from "node:crypto";
import { probeRouterHealth } from "../src/desktop/supervisor.ts";

const SECRET = "gr005-test-local-credential";
const WRONG = "gr005-wrong-state-credential";
const REPLAY_CHALLENGE = "replaychallenge0001";
const REPLAY_PROOF = createHmac("sha256", SECRET).update(REPLAY_CHALLENGE, "utf8").digest("hex");

type Responder = (requestHead: string) => { headers: string; body: string };

function withResponder(responder: Responder, fn: (port: number) => Promise<void>): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    let head = "";
    socket.on("data", (chunk) => {
      head += chunk.toString("utf8");
      if (head.includes("\r\n\r\n")) {
        const r = responder(head);
        const body = Buffer.from(r.body, "utf8");
        socket.write("HTTP/1.1 200 OK\r\n" + r.headers + "content-length: " + body.length + "\r\n\r\n");
        socket.write(body);
        socket.end();
      }
    });
    socket.on("close", () => sockets.delete(socket));
  });
  const cleanup = (err?: unknown): void => {
    for (const s of sockets) s.destroy();
    server.close(() => (err ? reject(err) : resolve()));
  };
  server.on("error", (e) => reject(e));
  server.listen(0, "127.0.0.1", () => {
    const addr = server.address();
    if (!addr || typeof addr !== "object") { reject(new Error("no port")); return; }
    Promise.resolve(fn(addr.port)).then(() => cleanup(), (e) => cleanup(e));
  });
  return promise;
}

function challengeOf(head: string): string | null {
  const m = /^x-gorouter-challenge:\s*(.+?)\s*$/im.exec(head);
  return m ? m[1]! : null;
}

function proofResponder(secret: string): Responder {
  return (head) => {
    const c = challengeOf(head);
    if (c !== null && /^[A-Za-z0-9._~-]{8,128}$/.test(c)) {
      const proof = createHmac("sha256", secret).update(c, "utf8").digest("hex");
      return { headers: "content-type: application/json\r\n", body: JSON.stringify({ status: "ok", version: "9.9.9", challenge: c, proof }) };
    }
    return { headers: "content-type: application/json\r\n", body: JSON.stringify({ status: "ok", version: "9.9.9" }) };
  };
}

const JSON_HEADERS = "content-type: application/json\r\n";
const withCred = { localCredential: () => SECRET as string | null };

describe("GR-005 supervisor challenge-response identity", () => {
  test("exact public JSON with a provider stays foreign (port_conflict)", async () => {
    await withResponder(
      () => ({ headers: JSON_HEADERS, body: JSON.stringify({ status: "ok", version: "1.0.0-fake" }) }),
      async (port) => {
        const r = await probeRouterHealth(port, withCred);
        expect(r.ok).toBe(false);
        expect(r.busy).toBe(true);
      },
    );
  });

  test("valid proof over the fresh challenge attaches", async () => {
    await withResponder(proofResponder(SECRET), async (port) => {
      const r = await probeRouterHealth(port, withCred);
      expect(r.ok).toBe(true);
      expect(r.busy).toBe(true);
    });
  });

  test("replayed proof for a stale challenge fails", async () => {
    await withResponder(
      () => ({ headers: JSON_HEADERS, body: JSON.stringify({ status: "ok", version: "9.9.9", challenge: REPLAY_CHALLENGE, proof: REPLAY_PROOF }) }),
      async (port) => {
        const r = await probeRouterHealth(port, withCred);
        expect(r.ok).toBe(false);
        expect(r.busy).toBe(true);
      },
    );
  });

  test("proof from another state fails", async () => {
    await withResponder(proofResponder(WRONG), async (port) => {
      const r = await probeRouterHealth(port, withCred);
      expect(r.ok).toBe(false);
      expect(r.busy).toBe(true);
    });
  });

  test("unconfigured provider (null credential) fails closed", async () => {
    await withResponder(proofResponder(SECRET), async (port) => {
      const r = await probeRouterHealth(port, { localCredential: () => null });
      expect(r.ok).toBe(false);
      expect(r.busy).toBe(true);
    });
  });

  test("no provider keeps the legacy public-signature check (framing tests)", async () => {
    await withResponder(
      () => ({ headers: JSON_HEADERS, body: JSON.stringify({ status: "ok", version: "1.0.0-fake" }) }),
      async (port) => {
        const r = await probeRouterHealth(port);
        expect(r.ok).toBe(true);
        expect(r.busy).toBe(true);
      },
    );
  });
});
