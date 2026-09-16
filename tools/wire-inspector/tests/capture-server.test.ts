import { describe, test, expect } from "bun:test";
import { startCaptureServer } from "../src/capture-server.ts";
import { isAllowedSyntheticUpstream } from "../src/loopback.ts";

describe("WI01 capture server is endpoint-only", () => {
  test("binds loopback only and answers without proxying", async () => {
    const srv = await startCaptureServer();
    try {
      expect(isAllowedSyntheticUpstream(srv.baseUrl)).toBe(true);
      expect(srv.baseUrl.startsWith("http://127.0.0.1:")).toBe(true);
      const res = await fetch(srv.baseUrl + "/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "m", stream: false }),
        redirect: "manual",
      });
      expect(res.status).toBe(200);
      // Never redirects.
      expect(res.headers.get("location")).toBeNull();
      expect(srv.requests.length).toBe(1);
      expect(srv.requests[0]!.method).toBe("POST");
      expect(srv.requests[0]!.path).toBe("/chat/completions");
    } finally {
      srv.stop();
    }
  });

  test("CONNECT is refused (no proxy semantics)", async () => {
    const srv = await startCaptureServer();
    try {
      // Raw TCP CONNECT (fetch cannot send CONNECT): open a socket and speak HTTP.
      const { connect } = await import("node:net");
      const result: { status: number; body: string } = await new Promise((resolve) => {
        const sock = connect(srv.port, "127.0.0.1");
        let data = "";
        sock.setEncoding("utf8");
        sock.on("connect", () => {
          sock.write("CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\nConnection: close\r\n\r\n");
        });
        sock.on("data", (d) => { data += d; });
        sock.on("end", () => {
          const m = /^HTTP\/\d\.\d\s+(\d{3})/.exec(data);
          resolve({ status: m ? Number(m[1]) : 0, body: data });
        });
        sock.on("error", () => resolve({ status: 0, body: data }));
        setTimeout(() => { try { sock.destroy(); } catch {} resolve({ status: 0, body: data }); }, 5000);
      });
      // Bun's HTTP layer rejects CONNECT at framing level (400/405/0) — any of
      // these proves no tunnel was established; a 200 with tunnel would fail.
      expect([0, 400, 405, 501]).toContain(result.status);
    } finally {
      srv.stop();
    }
  });

  test("redirect following disabled: client uses manual and server never emits Location", async () => {
    const srv = await startCaptureServer();
    try {
      const res = await fetch(srv.baseUrl + "/any", { redirect: "manual" });
      expect([200, 404, 405].includes(res.status)).toBe(true);
      expect(res.headers.get("location")).toBeNull();
    } finally {
      srv.stop();
    }
  });

  test("refuses public/provider URLs as upstream", () => {
    for (const u of ["https://opencode.ai/zen/v1", "http://8.8.8.8/", "https://example.com/"]) {
      expect(isAllowedSyntheticUpstream(u)).toBe(false);
    }
  });
});
