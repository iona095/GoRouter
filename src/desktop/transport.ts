/**
 * GoRouter V1.5 — control-channel transport (named pipe JSON-lines server).
 *
 * node:net server on a Windows named pipe. Framing: newline-delimited UTF-8
 * JSON, max 1 MiB per line (larger -> close). EVERY client message must
 * carry the admin token: missing/wrong token -> auth error response then the
 * connection is closed. Op dispatch is concurrent — responses are matched by
 * id and may return out of order. `push(event, data)` broadcasts to all
 * authenticated clients.
 */
import net, { type Server, type Socket } from 'node:net'
import { log } from '../util.ts'
import { MAX_LINE_BYTES, type ErrorCode } from './protocol.ts'

export interface TransportHandle {
  (op: string, params: Record<string, unknown>): Promise<unknown>
}

export interface ControlTransport {
  /** Broadcast an event to all authenticated clients. */
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

export function serveControlPipe(
  pipeName: string,
  token: string,
  handle: TransportHandle,
  onHello?: () => void,
  onError?: (err: Error) => void,
): ControlTransport {
  const clients = new Set<Socket>()
  const server: Server = net.createServer((socket) => {
    // Byte-accurate framing: the buffer holds only the current partial line;
    // the cap applies to raw bytes BEFORE waiting for a newline, so a client
    // streaming data without '\n' cannot grow memory without limit.
    let buf = Buffer.alloc(0)
    let helloSeen = false

    function send(obj: unknown): void {
      if (socket.destroyed) return
      try {
        socket.write(JSON.stringify(obj) + '\n')
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
        // EVERY message must carry the matching admin token
        if (typeof msg.token !== 'string' || msg.token !== token) {
          send({
            id: typeof msg.id === 'number' ? msg.id : 0,
            ok: false,
            error: { code: 'auth', message: 'authentication failed' },
          })
          socket.destroy()
          return
        }
        clients.add(socket)
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
              if (msg.op === 'hello' && onHello) onHello()
            },
            (err) => {
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
    const line = JSON.stringify({ event, data }) + '\n'
    for (const c of [...clients]) {
      try {
        c.write(line)
      } catch {
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
