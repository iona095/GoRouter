/**
 * GoRouter V1.5 — control-channel wire protocol (summary in
 * docs/desktop-architecture.md, "Control-channel protocol (summary)").
 *
 * Types shared by the transport, the control service, and the TS test
 * client, plus `createPipeClient` (node:net) used by tests and tooling.
 *
 * Framing: newline-delimited UTF-8 JSON, one object per line, max 1 MiB.
 * Every client message carries the admin token; responses and events never
 * do. Events are server->client objects without an id.
 */
import net from 'node:net'

export const SERVICE_VERSION = '1.5.0'
export const PROTOCOL_VERSION = 1
export const MAX_LINE_BYTES = 1024 * 1024

export type ErrorCode =
  | 'validation'
  | 'not_found'
  | 'conflict'
  | 'auth'
  | 'unsupported'
  | 'external'
  | 'unavailable'
  | 'internal'

/** Error carrying a wire error.code (never contains secrets). */
export class ControlError extends Error {
  code: ErrorCode
  constructor(code: ErrorCode, message: string) {
    super(message)
    this.name = 'ControlError'
    this.code = code
  }
}

export function controlError(code: ErrorCode, message: string): ControlError {
  return new ControlError(code, message)
}

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

export interface WireRequest {
  id: number
  token: string
  op: string
  params?: Record<string, unknown>
}

export interface WireError {
  code: ErrorCode
  message: string
}

export interface WireResponse {
  id: number
  ok: boolean
  data?: unknown
  error?: WireError
}

export interface WireEvent {
  event: string
  data: unknown
}

// ---------------------------------------------------------------------------
// Snapshot (single authoritative shape)
// ---------------------------------------------------------------------------

export interface SnapshotSettings {
  port: number
  journalRetentionDays: number
  journalMaxRecords: number
}

export interface SnapshotRoute {
  accountId: string | null
  alias: string | null
}

export interface SnapshotAccount {
  id: string
  alias: string
  secretPresent: boolean
  usedBy: string[]
  createdAtUtc: string
  updatedAtUtc: string
}

export type RouterSnapshotState =
  | 'running'
  | 'degraded'
  | 'stopped'
  | 'starting'
  | 'port_conflict'
  | 'failed'

export type RouterSnapshotMode = 'attached' | 'managed' | 'none'

export interface SnapshotRouter {
  state: RouterSnapshotState
  mode: RouterSnapshotMode
  pid: number | null
  port: number
  restartCount: number
}

export interface SnapshotJournal {
  schemaVersion: number
  records: number
  oldestRecordAtUtc: string | null
  newestRecordAtUtc: string | null
  degraded: boolean
  lastError: string | null
  retentionDays: number
  maxRecords: number
}

export interface SnapshotDesktop {
  startAtLogin: boolean
  minimizeToTray: boolean
  theme: 'light' | 'dark'
  firstRunDoneAtUtc: string | null
}

export interface Snapshot {
  serviceVersion: string
  initialized: boolean
  firstRun: boolean
  stateCorrupt: boolean
  /** On-disk state.json schema version when it is not ours (R3-004 gate active). */
  stateUnsupportedVersion: number | null
  /** On-disk desktop.json schema version when it is not ours (R3-004 gate active). */
  desktopUnsupportedVersion: number | null
  secretStore: 'ok' | 'unavailable'
  settings: SnapshotSettings
  routes: Record<'go' | 'zen', SnapshotRoute>
  accounts: SnapshotAccount[]
  router: SnapshotRouter
  journal: SnapshotJournal
  desktop: SnapshotDesktop
  stateDir: string
  localCredentialConfigured: boolean
}

/** journal.recent row — only the safe fields from the protocol spec. */
export interface JournalRowView {
  routerRequestId: string
  startedAtUtc: string
  completedAtUtc: string | null
  durationMs: number | null
  lane: string
  selectedAccountAliasSnapshot: string | null
  method: string
  endpointFamily: string
  terminalOutcome: string
  httpStatus: number | null
  upstreamRequestIds: string[]
  model: string | null
  clientCorrelationId: string | null
}

// ---------------------------------------------------------------------------
// TS pipe client (tests + tooling)
// ---------------------------------------------------------------------------

export interface PipeClient {
  /** Send a request; resolves with response data, rejects with {code,message}. */
  request<T = unknown>(op: string, params?: Record<string, unknown>): Promise<T>
  /** Subscribe to server->client events. */
  onEvent(cb: (event: string, data: unknown) => void): void
  close(): Promise<void>
}

export function createPipeClient(pipeName: string, token: string): PipeClient {
  const listeners = new Set<(event: string, data: unknown) => void>()
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  let nextId = 1
  let connected = false
  let closed = false
  let buf = Buffer.alloc(0)
  const outbox: string[] = []

  const socket = net.connect({ path: pipeName })

  socket.on('connect', () => {
    connected = true
    const queued = outbox.splice(0)
    for (const line of queued) socket.write(line)
  })

  socket.on('data', (chunk) => {
    const data = Buffer.isBuffer(chunk)
      ? chunk
      : typeof chunk === 'string'
        ? Buffer.from(chunk, 'utf8')
        : Buffer.from(chunk)
    buf = buf.length === 0 ? data : Buffer.concat([buf, data])
    let nl: number
    while ((nl = buf.indexOf(0x0a)) >= 0) {
      // byte-accurate cap: nl is the byte index of the newline in the raw buffer
      if (nl > MAX_LINE_BYTES) {
        socket.destroy()
        break
      }
      const line = buf.subarray(0, nl).toString('utf8')
      buf = buf.subarray(nl + 1)
      if (line.trim().length === 0) continue
      let msg: { event?: unknown; data?: unknown; id?: unknown; ok?: unknown; error?: unknown }
      try {
        msg = JSON.parse(line) as { event?: unknown; data?: unknown; id?: unknown; ok?: unknown; error?: unknown }
      } catch {
        continue
      }
      if (msg.event !== undefined) {
        const cbList = [...listeners]
        for (const cb of cbList) cb(String(msg.event), msg.data)
        continue
      }
      if (typeof msg.id === 'number') {
        const p = pending.get(msg.id)
        if (!p) continue
        pending.delete(msg.id)
        if (msg.ok === true) {
          p.resolve(msg.data)
        } else {
          const err = msg.error as { code?: unknown; message?: unknown } | undefined
          const e = new Error(typeof err?.message === 'string' ? err.message : 'request failed') as Error & {
            code?: string
          }
          e.code = typeof err?.code === 'string' ? err.code : 'internal'
          p.reject(e)
        }
      }
    }
    // only the partial line remains here: bound it
    if (buf.length > MAX_LINE_BYTES) {
      socket.destroy()
    }
  })

  socket.on('end', () => {
    // the server closed its side; without a local destroy the socket would
    // stay half-open and pending/queued requests would hang forever
    socket.destroy()
  })
  socket.on('close', () => {
    closed = true
    const err = new Error('control pipe connection closed') as Error & { code?: string }
    err.code = 'internal'
    const entries = [...pending.entries()]
    pending.clear()
    for (const [, p] of entries) p.reject(err)
  })
  socket.on('error', () => {
    /* close handler settles everything */
  })

  function request<T>(op: string, params?: Record<string, unknown>): Promise<T> {
    if (closed) return Promise.reject(Object.assign(new Error('control pipe connection closed'), { code: 'internal' }))
    const id = nextId++
    const msg: Record<string, unknown> = { id, token, op }
    if (params !== undefined && params !== null) msg.params = params
    const line = JSON.stringify(msg) + '\n'
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: (v) => resolve(v as T), reject })
      if (connected) {
        try {
          socket.write(line)
        } catch (e) {
          pending.delete(id)
          reject(e instanceof Error ? e : new Error(String(e)))
        }
      } else {
        outbox.push(line)
      }
    })
  }

  function onEvent(cb: (event: string, data: unknown) => void): void {
    listeners.add(cb)
  }

  function close(): Promise<void> {
    return new Promise((resolve) => {
      if (closed) {
        resolve()
        return
      }
      socket.once('close', () => resolve())
      socket.destroy()
    })
  }

  return { request, onEvent, close }
}
