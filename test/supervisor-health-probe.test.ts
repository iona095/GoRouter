/**
 * Supervisor health-probe framing tests: the raw /healthz probe must accept
 * both Content-Length and chunked HTTP/1.1 framing. The node:http inbound
 * adapter emits chunked when no Content-Length is known (Response.json sets
 * only content-type), so the probe must decode that framing — not just
 * Content-Length. Regression guard for the managed-router startup failure
 * where a chunked /healthz left the router stuck in "starting".
 */
import { test, expect } from "bun:test";
import net from "node:net";
import { probeRouterHealth } from "../src/desktop/supervisor.ts";

/** Frame a body as a single HTTP/1.1 chunk (size CRLF data CRLF 0 CRLF CRLF). */
function chunked(body: string): string {
  const size = Buffer.byteLength(body, "utf8").toString(16);
  return `${size}\r\n${body}\r\n0\r\n\r\n`;
}

/**
 * Run `fn` against a raw TCP responder that answers every request with a
 * fixed HTTP/1.1 200 response (given headers + body). The responder is
 * torn down (sockets destroyed, server closed) before resolving.
 */
function withRawResponder(
  responseHeaders: string,
  body: string,
  fn: (port: number) => Promise<void>,
): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("data", () => {
      socket.write(`HTTP/1.1 200 OK\r\n${responseHeaders}\r\n\r\n${body}`);
      socket.end();
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
    if (!addr || typeof addr !== "object") {
      reject(new Error("no port"));
      return;
    }
    Promise.resolve(fn(addr.port)).then(
      () => cleanup(),
      (e) => cleanup(e),
    );
  });
  return promise;
}

const HEALTH_OK = { status: "ok", version: "1.5.3" };

test("chunked /healthz decodes to ok=true (node:http framing)", async () => {
  await withRawResponder(
    "content-type: application/json; charset=utf-8\r\ntransfer-encoding: chunked",
    chunked(JSON.stringify(HEALTH_OK)),
    async (port) => {
      const r = await probeRouterHealth(port);
      expect(r.ok).toBe(true);
      expect(r.busy).toBe(true);
    },
  );
});

test("chunked /healthz with non-ASCII body decodes to ok=true (byte-aware framing)", async () => {
  // Chunk sizes are BYTE counts; a non-ASCII body (multi-byte UTF-8) has a
  // byte length that differs from its JS code-unit length. A code-unit
  // decoder mis-slices the chunk and mis-parses a healthy response (e.g. a
  // real router whose /healthz carries a Unicode workspace alias).
  const note = "é".repeat(100);
  const body = JSON.stringify({ ...HEALTH_OK, note });
  expect(Buffer.byteLength(body, "utf8")).not.toBe(body.length); // precondition
  await withRawResponder(
    "content-type: application/json; charset=utf-8\r\ntransfer-encoding: chunked",
    chunked(body),
    async (port) => {
      const r = await probeRouterHealth(port);
      expect(r.ok).toBe(true);
      expect(r.busy).toBe(true);
    },
  );
});

test("malformed chunk framing does not classify a port as healthy", async () => {
  // A malformed size (parseInt prefix like "1z"), truncated chunk data, and a
  // missing terminal 0-chunk must NOT decode as a healthy body — otherwise an
  // occupied foreign port could be misclassified as ours.
  const body = JSON.stringify(HEALTH_OK);
  const sizeHex = Buffer.byteLength(body, "utf8").toString(16);
  const malformedSize = `${sizeHex}z\r\n${body}\r\n0\r\n\r\n`;
  const missingZero = `${sizeHex}\r\n${body}\r\n`;
  const truncated = `${sizeHex}\r\n${body.slice(0, 4)}`;
  const trailingJunk = `${sizeHex}\r\n${body}\r\n0\r\n\r\nJUNK`;
  const whitespaceSize = ` ${sizeHex} ;foo\r\n${body}\r\n0\r\n\r\n`;
  const badTrailerField = `${sizeHex}\r\n${body}\r\n0\r\nBad Header: x\r\n\r\n`;
  const badChunkExt = `${sizeHex};=bad\r\n${body}\r\n0\r\n\r\n`;
  for (const raw of [malformedSize, missingZero, truncated, trailingJunk, whitespaceSize, badTrailerField, badChunkExt]) {
    await withRawResponder(
      "content-type: application/json; charset=utf-8\r\ntransfer-encoding: chunked",
      raw,
      async (port) => {
        const r = await probeRouterHealth(port);
        expect(r.ok).toBe(false);
        expect(r.busy).toBe(true);
      },
    );
  }
});

test("a valid quoted chunk extension is accepted", async () => {
  const body = JSON.stringify(HEALTH_OK);
  const sizeHex = Buffer.byteLength(body, "utf8").toString(16);
  await withRawResponder(
    "content-type: application/json; charset=utf-8\r\ntransfer-encoding: chunked",
    `${sizeHex};foo="bar baz"\r\n${body}\r\n0\r\n\r\n`,
    async (port) => {
      const r = await probeRouterHealth(port);
      expect(r.ok).toBe(true);
      expect(r.busy).toBe(true);
    },
  );
});

test("obs-fold, control-byte extensions and trailer values are rejected", async () => {
  const body = JSON.stringify(HEALTH_OK);
  const sizeHex = Buffer.byteLength(body, "utf8").toString(16);
  const framed = `${sizeHex}\r\n${body}\r\n0\r\n\r\n`;
  const ctrlExt = `${sizeHex};foo="\x01"\r\n${body}\r\n0\r\n\r\n`;
  const ctrlTrailer = `${sizeHex}\r\n${body}\r\n0\r\nX: \x01\r\n\r\n`;
  // obs-fold continuation combines with the previous field: chunked + gzip
  await withRawResponder(
    "content-type: application/json; charset=utf-8\r\ntransfer-encoding: chunked\r\n transfer-encoding: gzip",
    framed,
    async (port) => {
      const r = await probeRouterHealth(port);
      expect(r.ok).toBe(false);
      expect(r.busy).toBe(true);
    },
  );
  for (const raw of [ctrlExt, ctrlTrailer]) {
    await withRawResponder(
      "content-type: application/json; charset=utf-8\r\ntransfer-encoding: chunked",
      raw,
      async (port) => {
        const r = await probeRouterHealth(port);
        expect(r.ok).toBe(false);
        expect(r.busy).toBe(true);
      },
    );
  }
});

test("a foreign X-Transfer-Encoding header does not trigger chunked decoding", async () => {
  // The chunked detection must anchor to the actual Transfer-Encoding field:
  // a header named X-Transfer-Encoding must not flip the response into
  // chunked mode (a content-length body then parses normally).
  const body = JSON.stringify(HEALTH_OK);
  await withRawResponder(
    `content-type: application/json; charset=utf-8\r\nx-transfer-encoding: chunked\r\ncontent-length: ${Buffer.byteLength(body, "utf8")}`,
    body,
    async (port) => {
      const r = await probeRouterHealth(port);
      expect(r.ok).toBe(true);
      expect(r.busy).toBe(true);
    },
  );
});

test("chunked /healthz with a valid trailer section decodes to ok=true", async () => {
  // HTTP allows trailer fields after the terminal 0-chunk: 0\r\n<field>\r\n\r\n.
  // A clean chunked response with trailers must still decode as healthy.
  const body = JSON.stringify(HEALTH_OK);
  const sizeHex = Buffer.byteLength(body, "utf8").toString(16);
  const withTrailers = `${sizeHex}\r\n${body}\r\n0\r\nX-Trace: yes\r\n\r\n`;
  await withRawResponder(
    "content-type: application/json; charset=utf-8\r\ntransfer-encoding: chunked",
    withTrailers,
    async (port) => {
      const r = await probeRouterHealth(port);
      expect(r.ok).toBe(true);
      expect(r.busy).toBe(true);
    },
  );
});

test("Transfer-Encoding values other than the exact chunked token are not decoded", async () => {
  // chunkedness / chunked;foo / chunked, gzip are NOT the exact chunked coding:
  // a foreign server advertising them must not be classified as healthy even
  // if it happens to frame the body in a chunked-looking shape.
  const body = JSON.stringify(HEALTH_OK);
  const sizeHex = Buffer.byteLength(body, "utf8").toString(16);
  const framed = `${sizeHex}\r\n${body}\r\n0\r\n\r\n`;
  for (const te of ["chunkedness", "chunked;foo", "chunked, gzip", "gzip, chunked"]) {
    await withRawResponder(
      `content-type: application/json; charset=utf-8\r\ntransfer-encoding: ${te}`,
      framed,
      async (port) => {
        const r = await probeRouterHealth(port);
        expect(r.ok).toBe(false);
        expect(r.busy).toBe(true);
      },
    );
  }
  // duplicate Transfer-Encoding fields combine (gzip + chunked == "gzip, chunked")
  await withRawResponder(
    "content-type: application/json; charset=utf-8\r\ntransfer-encoding: gzip\r\ntransfer-encoding: chunked",
    framed,
    async (port) => {
      const r = await probeRouterHealth(port);
      expect(r.ok).toBe(false);
      expect(r.busy).toBe(true);
    },
  );
});

test("content-length /healthz still decodes to ok=true", async () => {
  const body = JSON.stringify(HEALTH_OK);
  await withRawResponder(
    `content-type: application/json; charset=utf-8\r\ncontent-length: ${Buffer.byteLength(body, "utf8")}`,
    body,
    async (port) => {
      const r = await probeRouterHealth(port);
      expect(r.ok).toBe(true);
      expect(r.busy).toBe(true);
    },
  );
});

test("multi-chunk /healthz body reassembles to ok=true", async () => {
  const body = JSON.stringify(HEALTH_OK);
  // Split into two chunks to exercise the accumulation path.
  const half = Math.floor(body.length / 2);
  const c1 = Buffer.byteLength(body.slice(0, half), "utf8").toString(16);
  const c2 = Buffer.byteLength(body.slice(half), "utf8").toString(16);
  const framed = `${c1}\r\n${body.slice(0, half)}\r\n${c2}\r\n${body.slice(half)}\r\n0\r\n\r\n`;
  await withRawResponder(
    "content-type: application/json; charset=utf-8\r\ntransfer-encoding: chunked",
    framed,
    async (port) => {
      const r = await probeRouterHealth(port);
      expect(r.ok).toBe(true);
      expect(r.busy).toBe(true);
    },
  );
});

test("non-healthy /healthz -> ok=false (busy stays true)", async () => {
  const body = JSON.stringify({ status: "degraded", version: "1.5.3" });
  await withRawResponder(
    `content-type: application/json; charset=utf-8\r\ncontent-length: ${Buffer.byteLength(body, "utf8")}`,
    body,
    async (port) => {
      const r = await probeRouterHealth(port);
      expect(r.ok).toBe(false);
      expect(r.busy).toBe(true);
    },
  );
});

test("malformed chunked /healthz -> ok=false (no crash)", async () => {
  // Truncated chunk (declared size exceeds available bytes) must not throw.
  await withRawResponder(
    "content-type: application/json; charset=utf-8\r\ntransfer-encoding: chunked",
    "21\r\n{\"status\":\"ok\"",
    async (port) => {
      const r = await probeRouterHealth(port);
      expect(r.ok).toBe(false);
      expect(r.busy).toBe(true);
    },
  );
});
