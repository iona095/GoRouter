/**
 * WI01 loopback capture upstream — an ENDPOINT, not a proxy.
 * - binds 127.0.0.1 only, ephemeral port by default
 * - records the exact inbound HTTP request (method/url/headers/body)
 * - NEVER proxies, relays, CONNECTs, or follows redirects
 * - answers synthetically (JSON or SSE for stream:true)
 */
import { assertLoopbackUrl } from "./loopback.ts";

export interface CapturedRequest {
  seq: number;
  timestampUtc: string;
  method: string;
  url: string;
  path: string;
  query: string;
  headers: Record<string, string>;
  bodyText: string;
  remoteAddr: string | null;
}

export interface CaptureServer {
  port: number;
  baseUrl: string;
  requests: CapturedRequest[];
  stop: () => void;
}

function headersToRecord(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((v, k) => { out[k] = v; });
  return out;
}

function syntheticReply(bodyText: string): Response {
  let stream = false;
  try {
    const parsed = JSON.parse(bodyText) as { stream?: unknown };
    stream = parsed.stream === true;
  } catch { /* non-JSON -> plain JSON reply */ }
  if (stream) {
    // Minimal SSE stream: two data chunks + DONE. Exercises GoRouter's
    // streaming passthrough without contacting any real provider.
    const sse =
      'data: {"id":"wi01-synth-1","object":"chat.completion.chunk","choices":[{"delta":{"content":"wire"}}]}\n\n' +
      'data: {"id":"wi01-synth-1","object":"chat.completion.chunk","choices":[{"delta":{"content":" inspector"}}]}\n\n' +
      "data: [DONE]\n\n";
    return new Response(sse, {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        "x-request-id": "wi01-synth-req-001",
      },
    });
  }
  return Response.json(
    {
      id: "wi01-synth-1",
      object: "chat.completion",
      created: 0,
      model: "wi01-synthetic-model",
      choices: [{ index: 0, message: { role: "assistant", content: "wire inspector synthetic reply" }, finish_reason: "stop" }],
    },
    { headers: { "x-request-id": "wi01-synth-req-001" } },
  );
}

/**
 * WI03 scripted response profile. When present, the selected profile — and
 * nothing else — controls the emitted response. No request-body sniffing.
 */
export interface ScriptedResponseProfile {
  status: number;
  headers: Record<string, string>;
  /** Exact serialized bytes for kind "json". */
  jsonText?: string;
  /** Exact ordered stream writes for kind "sse" (each its own write). */
  sseWrites?: string[];
  /** Delay between SSE writes in ms (deterministic, small). */
  sseWriteDelayMs?: number;
}

export interface ScriptedWriteRecord {
  index: number;
  bytes: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function streamedResponse(profile: ScriptedResponseProfile, onWrite: (rec: ScriptedWriteRecord) => void): Response {
  const writes = profile.sseWrites ?? [];
  const delay = profile.sseWriteDelayMs ?? 5;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for (let i = 0; i < writes.length; i++) {
          if (i > 0 && delay > 0) await sleep(delay);
          const bytes = encoder.encode(writes[i]!);
          onWrite({ index: i, bytes: bytes.byteLength });
          controller.enqueue(bytes);
        }
        controller.close();
      } catch {
        try { controller.close(); } catch { /* already closed */ }
      }
    },
  });
  return new Response(stream, { status: profile.status, headers: profile.headers });
}

export async function startCaptureServer(opts: { port?: number; responseProfile?: ScriptedResponseProfile } = {}): Promise<CaptureServer & { scriptedWrites: ScriptedWriteRecord[] }> {
  const requests: CapturedRequest[] = [];
  const scriptedWrites: ScriptedWriteRecord[] = [];
  let seq = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: opts.port ?? 0,
    idleTimeout: 10,
    fetch: async (req, srv) => {
      const url = new URL(req.url);
      // Endpoint-only hardening:
      // - CONNECT can never arrive via fetch/Bun.serve as a method, but refuse
      //   it explicitly if it ever does (no proxy semantics).
      if (req.method.toUpperCase() === "CONNECT") {
        return new Response("WI capture server is an endpoint, not a proxy (CONNECT refused)", { status: 405 });
      }
      // - Never redirect: answer the scripted status directly (no Location header).
      // - Never relay: no fetch() to any other host happens here.
      const clone = req.clone();
      const bodyText = await clone.text().catch(() => "");
      const rec: CapturedRequest = {
        seq: ++seq,
        timestampUtc: new Date().toISOString(),
        method: req.method,
        url: req.url,
        path: url.pathname,
        query: url.search,
        headers: headersToRecord(req.headers),
        bodyText,
        remoteAddr: srv.requestIP(req)?.address ?? null,
      };
      requests.push(rec);
      // WI03: an explicit profile owns the response. Otherwise (WI01/WI02)
      // keep the legacy body-sniffing synthetic reply unchanged.
      const profile = opts.responseProfile;
      if (profile) {
        if (profile.sseWrites !== undefined) return streamedResponse(profile, (w) => scriptedWrites.push(w));
        const text = profile.jsonText ?? "";
        scriptedWrites.push({ index: 0, bytes: new TextEncoder().encode(text).byteLength });
        return new Response(text, { status: profile.status, headers: profile.headers });
      }
      return syntheticReply(bodyText);
    },
  });
  const port = server.port ?? 0;
  const baseUrl = "http://127.0.0.1:" + port;
  // Prove loopback before exposing.
  assertLoopbackUrl(baseUrl);
  return {
    port,
    baseUrl,
    requests,
    scriptedWrites,
    stop: () => { try { server.stop(true); } catch { /* already stopped */ } },
  };
}
