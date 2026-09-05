/**
 * GoRouter V1.5 — control-channel transport (named pipe JSON-lines server).
 *
 * node:net server on a Windows named pipe. Framing: newline-delimited UTF-8
 * JSON, max 1 MiB per line (larger -> close). EVERY client message must
 * carry the admin token: missing/wrong token -> auth error response then the
 * connection is closed. Op dispatch is concurrent — responses are matched by
 * id and may return out of order. `push(event, data)` broadcasts to all
 * hello-completed clients (token auth gates frames; hello gates pushes).
 */
import net, { type Server, type Socket } from 'node:net'
import { timingSafeEqual } from 'node:crypto'
import { log } from '../util.ts'
import { MAX_LINE_BYTES, type ErrorCode } from './protocol.ts'

export interface TransportHandle {
  (op: string, params: Record<string, unknown>): Promise<unknown>
}

export interface ControlTransport {
  /** Broadcast an event to all hello-completed clients. */
  push(event: string, data: unknown): void
  /** Stop accepting, destroy sockets, resolve when fully closed. */
  close(): Promise<void>
  /**
   * Resolves once the pipe is bound and accepting connections; rejects when
   * the bind fails (e.g. EADDRINUSE). Callers must await this before starting
   * supervision so a losing duplicate instance can never spawn a router child.
   */
  listening: Promise<void>
}

/** Constant-time admin-token comparison (lengths are not secret). */
function tokensMatch(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

const ERROR_CODES: Record<ErrorCode, true> = {
  validation: true,
  not_found: true,
  conflict: true,
  auth: true,
  unsupported: true,
  external: true,
  unavailable: true,
  internal: true,
}

/**
 * R3-007: symmetric outbound queued-bytes ceiling (inbound lines are
 * capped at MAX_LINE_BYTES). A single queued frame above the inbound cap
 * is already suspicious, and an accumulation above it means a stalled
 * consumer — either way the socket is dropped instead of grown.
 */
export const MAX_QUEUED_OUTBOUND_BYTES = 1024 * 1024;

export function serveControlPipe(
  pipeName: string,
  token: string,
  handle: TransportHandle,
  onHello?: () => void,
  onError?: (err: Error) => void,
  // R3-007: observability seam for the backpressure gate (tests + operator
  // metrics): invoked once per stalled socket dropped instead of queued for.
  onStalledDrop?: () => void,
): ControlTransport {
  const clients = new Set<Socket>()
  const server: Server = net.createServer((socket) => {
    // Byte-accurate framing: the buffer holds only the current partial line;
    // the cap applies to raw bytes BEFORE waiting for a newline, so a client
    // streaming data without '\n' cannot grow memory without limit.
    let buf = Buffer.alloc(0)
    let helloSeen = false
    // A hello that completed keeps the subscription even if a LATER hello
    // fails (out-of-order pipelined hellos, stray retries): only a hello
    // that never succeeded leaves the socket unsubscribed.
    let helloOk = false

    // R3-007: outbound backpressure. Inbound framing is capped at 1 MiB
    // per line, but queued outbound bytes were unbounded: an
    // authenticated-but-stalled client could grow control-service memory
    // without limit. A frame that would push the queued bytes past the cap
    // destroys the socket instead of queueing more.
    function send(obj: unknown): void {
      if (socket.destroyed) return
      let line: string
      try {
        line = JSON.stringify(obj) + '\n'
      } catch {
        socket.destroy()
        return
      }
      if (socket.writableLength + Buffer.byteLength(line) > MAX_QUEUED_OUTBOUND_BYTES) {
        log.warn('control pipe client stalled: dropping connection instead of queueing unbounded output')
        try { onStalledDrop?.() } catch { /* observability only */ }
        socket.destroy()
        return
      }
      try {
        socket.write(line)
      } catch {
        socket.destroy()
      }
    }

    socket.on('data', (chunk) => {
      const data = Buffer.isBuffer(chunk)
        ? chunk
        : typeof chunk === 'string'
          ? Buffer.from(chunk, 'utf8')
          : Buffer.from(chunk)
      buf = buf.length === 0 ? data : Buffer.concat([buf, data])
      let nl: number
      while ((nl = buf.indexOf(0x0a)) >= 0) {
        const line = buf.subarray(0, nl)
        buf = buf.subarray(nl + 1)
        // per-line byte cap: a single frame larger than the cap kills the
        // connection, no matter how many valid frames shared the chunk
        if (line.length > MAX_LINE_BYTES) {
          socket.destroy()
          return
        }
        const text = line.toString('utf8')
        if (text.trim().length === 0) continue
        let msg: { id?: unknown; token?: unknown; op?: unknown; params?: unknown }
        try {
          msg = JSON.parse(text) as { id?: unknown; token?: unknown; op?: unknown; params?: unknown }
        } catch {
          send({ id: 0, ok: false, error: { code: 'validation', message: 'malformed request' } })
          continue
        }
        // EVERY message must carry the matching admin token, compared in
        // constant time (F-30) so a local attacker cannot byte-guess it.
        if (typeof msg.token !== 'string' || !tokensMatch(msg.token, token)) {
          send({
            id: typeof msg.id === 'number' ? msg.id : 0,
            ok: false,
            error: { code: 'auth', message: 'authentication failed' },
          })
          socket.destroy()
          return
        }
        // Broadcast membership is granted on completed hello (F-29), not on
        // connect or first authenticated frame: a socket that never finishes
        // the handshake must not receive push events. Token auth above still
        // gates every frame; this only scopes the push set.
        const id = typeof msg.id === 'number' ? msg.id : 0
        if (typeof msg.op !== 'string' || msg.op.length === 0) {
          send({ id, ok: false, error: { code: 'validation', message: 'missing op' } })
          continue
        }
        if (!helloSeen && msg.op !== 'hello') {
          send({ id, ok: false, error: { code: 'validation', message: 'hello must be the first message' } })
          continue
        }
        if (msg.op === 'hello') helloSeen = true
        const params =
          msg.params && typeof msg.params === 'object' && !Array.isArray(msg.params)
            ? (msg.params as Record<string, unknown>)
            : {}
        Promise.resolve()
          .then(() => handle(msg.op as string, params))
          .then(
            (data) => {
              send({ id, ok: true, data })
              if (msg.op === 'hello') {
                helloOk = true
                clients.add(socket)
                if (onHello) onHello()
              }
            },
            (err) => {
              // A FAILED hello must not subscribe (F-29): the socket stays
              // usable for a retry, but receives no pushes until one succeeds
              // — unless an earlier hello already completed (helloOk).
              if (msg.op === 'hello' && !helloOk) clients.delete(socket)
              const e = err as { code?: unknown; message?: unknown }
              const code =
                typeof e.code === 'string' && ERROR_CODES[e.code as ErrorCode] ? (e.code as ErrorCode) : 'internal'
              const message = typeof e.message === 'string' && e.message.length > 0 ? e.message : 'internal error'
              send({ id, ok: false, error: { code, message } })
            },
          )
      }
      // only the partial line remains here: bound it so a no-newline flood
      // cannot grow memory without limit
      if (buf.length > MAX_LINE_BYTES) {
        socket.destroy()
      }
    })

    socket.on('end', () => clients.delete(socket))
    socket.on('close', () => clients.delete(socket))
    socket.on('error', () => {
      /* close follows; error is expected on auth-close */
    })
  })

  let bindSettled = false
  let resolveListening!: () => void
  let rejectListening!: (err: Error) => void
  const listening = new Promise<void>((res, rej) => {
    resolveListening = res
    rejectListening = rej
  })

  server.once('listening', () => {
    bindSettled = true
    resolveListening()
  })
  server.on('error', (err) => {
    log.error(`control pipe server error: ${err.message}`)
    if (!bindSettled) {
      bindSettled = true
      rejectListening(err)
    }
    onError?.(err)
  })

  server.listen(pipeName)

  function push(event: string, data: unknown): void {
    let line: string
    try {
      line = JSON.stringify({ event, data }) + '\n'
    } catch {
      return
    }
    const pending = Buffer.byteLength(line)
    for (const c of [...clients]) {
      try {
        // R3-007: drop (do not queue for) a subscriber whose queued bytes
        // already exceed the ceiling — it stopped reading — or a single
        // frame larger than the ceiling, which mirrors the inbound line
        // cap and has no legitimate broadcast use. Either condition alone
        // drops; ordinary small events always reach healthy subscribers.
        // (Under runtimes that report queue growth honestly the backlog
        // rule also trips on gradual accumulation of small events.)
        if (c.destroyed || c.writableLength > MAX_QUEUED_OUTBOUND_BYTES || pending > MAX_QUEUED_OUTBOUND_BYTES) {
          log.warn('control pipe push subscriber stalled: dropping instead of queueing unbounded output')
          try { onStalledDrop?.() } catch { /* observability only */ }
          clients.delete(c)
          c.destroy()
        } else {
          c.write(line)
        }
      } catch {
        clients.delete(c)
        c.destroy()
      }
    }
  }

  function close(): Promise<void> {
    return new Promise((resolve) => {
      let settled = false
      const done = (): void => {
        if (settled) return
        settled = true
        resolve()
      }
      for (const c of [...clients]) c.destroy()
      clients.clear()
      server.close(() => done())
      // safety: if the server never bound (listen error), close() may not
      // invoke its callback; never hang the shutdown path.
      setTimeout(done, 1_000)
    })
  }

  return { push, close, listening }
}
