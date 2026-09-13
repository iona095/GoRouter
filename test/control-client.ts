/**
 * Minimal named-pipe control client for GoRouter V1.5 integration tests.
 *
 * Deliberately independent from src/desktop/protocol.ts: this module exists
 * to drive the REAL control service from the outside (bun test suite and the
 * desktop evidence scenario), so it re-implements the wire contract
 * (newline-delimited JSON over \\.\pipe\..., admin token in every request)
 * per local://v15-protocol.md. If the service and this client disagree, the
 * tests fail — that is the point.
 */
import { createConnection, type Socket } from "node:net";

export interface SnapshotRouter {
  state: string
  mode: string
  pid: number | null
  port: number
  restartCount: number
}

export interface SnapshotAccount {
  id: string
  alias: string
  secretPresent: boolean
  usedBy: string[]
  createdAtUtc: string
  updatedAtUtc: string
  version: number
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

export interface LaneSelection {
  accountId: string | null
  alias: string | null
  version: number
}

export interface SnapshotData {
  serviceVersion: string
  stateGeneration: string
  initialized: boolean
  firstRun: boolean
  stateCorrupt: boolean
  stateUnsupportedVersion?: number | null
  desktopUnsupportedVersion?: number | null
  secretStore: string
  settings: { port: number; journalRetentionDays: number; journalMaxRecords: number }
  routes: { go: LaneSelection; zen: LaneSelection }
  accounts: SnapshotAccount[]
  router: SnapshotRouter
  journal: SnapshotJournal
  desktop: { startAtLogin: boolean; minimizeToTray: boolean; firstRunDoneAtUtc: string | null }
  stateDir: string
  localCredentialConfigured: boolean
}

export interface ControlError {
  code: string
  message: string
  reason?: string
}

export interface ControlResponse {
  id: number
  ok: boolean
  data?: any
  error?: ControlError
}

export interface SnapshotEvent {
  event: "snapshot"
  data: SnapshotData
}

export interface JournalRow {
  routerRequestId: string
  startedAtUtc: string
  completedAtUtc: string
  durationMs: number
  lane: string
  selectedAccountAliasSnapshot: string
  method: string
  endpointFamily: string
  terminalOutcome: string
  httpStatus: number
  upstreamRequestIds: string[]
  model: string | null
  clientCorrelationId: string | null
}

export class ControlClient {
  socket: Socket | null = null
  private buffer = ""
  private nextId = 1
  private pending = new Map<number, { resolve: (r: ControlResponse) => void }>()
  private helloAck: Promise<ControlResponse>
  private helloResolve!: (r: ControlResponse) => void
  private closed = false
  latest: SnapshotData | null = null
  events: SnapshotEvent[] = []
  private eventListeners = new Set<(ev: SnapshotEvent) => void>()
  readonly pipePath: string
  readonly token: string

  constructor(pipePath: string, token: string) {
    this.pipePath = pipePath
    this.token = token
    this.helloAck = new Promise((resolve) => { this.helloResolve = resolve })
  }

  private makeSocket(): Socket {
    const socket = createConnection({ path: this.pipePath })
    socket.setEncoding("utf8")
    socket.on("data", (chunk: string) => this.onData(chunk))
    socket.on("close", () => {
      // only the current socket's close counts: failed connect attempts
      // destroy their own socket and must not poison client state
      if (socket !== this.socket) return
      this.closed = true
      const err: ControlResponse = { id: 0, ok: false, error: { code: "closed", message: "pipe closed" } }
      for (const p of this.pending.values()) p.resolve(err)
      this.pending.clear()
    })
    socket.on("error", () => { /* surfaced via close/request failure */ })
    this.socket = socket
    return socket
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    let nl: number
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl)
      this.buffer = this.buffer.slice(nl + 1)
      if (line.trim().length === 0) continue
      this.handleLine(line)
    }
  }

  private handleLine(line: string): void {
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(line)
    } catch {
      return // non-JSON line: ignore (server never sends these)
    }
    if (msg.event === "snapshot") {
      const ev = msg as unknown as SnapshotEvent
      this.latest = ev.data
      this.events.push(ev)
      for (const fn of this.eventListeners) fn(ev)
      return
    }
    const id = typeof msg.id === "number" ? msg.id : 0
    if (id === 1 && this.pending.has(1)) {
      this.helloResolve(msg as unknown as ControlResponse)
    }
    const p = this.pending.get(id)
    if (p) {
      this.pending.delete(id)
      p.resolve(msg as unknown as ControlResponse)
    }
  }

  onEvent(fn: (ev: SnapshotEvent) => void): () => void {
    this.eventListeners.add(fn)
    return () => { this.eventListeners.delete(fn) }
  }

  /**
   * Connect and complete the protocol handshake (hello + initial snapshot
   * event). The named pipe may not exist yet while the service is still
   * starting (it creates the admin token blob before listening), so the
   * connect is retried until `timeoutMs` — a single ENOENT is not a failure.
   */
  async connect(timeoutMs = 10_000, helloParams?: Record<string, unknown>): Promise<SnapshotData> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const socket = this.makeSocket()
      try {
        await new Promise<void>((resolve, reject) => {
          socket.once("connect", () => resolve())
          socket.once("error", (e) => reject(e))
        })
        break
      } catch (e) {
        socket.destroy()
        this.socket = null
        if (Date.now() >= deadline) {
          throw new Error(`pipe connect timeout to ${this.pipePath}: ${e instanceof Error ? e.message : String(e)}`)
        }
        await Bun.sleep(100)
      }
    }
    const ack = await this.request("hello", helloParams ?? { app: "GoRouterDesktop", version: "1.5.0", protocol: 2 }, timeoutMs)
    if (!ack.ok) throw new Error(`hello failed: ${ack.error?.code} ${ack.error?.message}`)
    const initial = await this.waitSnapshot(() => true, timeoutMs)
    return initial
  }

  /** Send one request and await its response (auto id/token envelope). */
  async request(op: string, params?: Record<string, unknown>, timeoutMs = 15_000): Promise<ControlResponse> {
    if (this.closed || !this.socket) return { id: 0, ok: false, error: { code: "closed", message: "pipe closed" } }
    const id = this.nextId++
    const body = JSON.stringify({ id, token: this.token, op, params: params ?? {} })
    return new Promise<ControlResponse>((resolve) => {
      this.pending.set(id, { resolve })
      this.socket!.write(body + "\n")
      setTimeout(() => {
        if (this.pending.delete(id)) {
          resolve({ id, ok: false, error: { code: "timeout", message: `request '${op}' timed out` } })
        }
      }, timeoutMs)
    })
  }

  async snapshot(timeoutMs = 10_000): Promise<SnapshotData> {
    const r = await this.request("snapshot", {}, timeoutMs)
    if (!r.ok) throw new Error(`snapshot failed: ${r.error?.code} ${r.error?.message}`)
    return r.data as SnapshotData
  }

  /**
   * Poll (explicit snapshot requests, plus any pushed events) until `pred`
   * holds for the latest snapshot, or fail after `timeoutMs`.
   */
  async waitSnapshot(pred: (s: SnapshotData) => boolean, timeoutMs = 8_000): Promise<SnapshotData> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      if (this.latest && pred(this.latest)) return this.latest
      if (Date.now() >= deadline) {
        const got = this.latest ? JSON.stringify(this.latest).slice(0, 400) : "(no snapshot yet)"
        throw new Error(`snapshot condition not met within ${timeoutMs}ms; latest=${got}`)
      }
      try {
        const s = await this.snapshot(3_000)
        if (pred(s)) return s
      } catch { /* service may be mid-restart; keep polling */ }
      await Bun.sleep(250)
    }
  }

  /** Wait for a pushed event satisfying `pred` (proves the push path). */
  async waitEvent(pred: (s: SnapshotData) => boolean, timeoutMs = 8_000): Promise<SnapshotEvent> {
    const deadline = Date.now() + timeoutMs
    for (const ev of this.events) if (pred(ev.data)) return ev
    return await new Promise<SnapshotEvent>((resolve, reject) => {
      const off = this.onEvent((ev) => {
        if (pred(ev.data)) {
          off()
          clearTimeout(t)
          resolve(ev)
        }
      })
      const t = setTimeout(() => {
        off()
        reject(new Error(`event condition not met within ${timeoutMs}ms`))
      }, timeoutMs)
      void deadline
    })
  }

  close(): void {
    this.closed = true
    if (this.socket) this.socket.destroy()
  }
}

/** Read the service-created admin token blob (DPAPI) for a state dir. */
export function readAdminToken(stateDir: string): string {
  const { readFileSync } = require("node:fs") as typeof import("node:fs")
  const { join } = require("node:path") as typeof import("node:path")
  const { dpapiUnprotect } = require("../src/secret-store.ts") as typeof import("../src/secret-store.ts")
  const blobPath = join(stateDir, "secrets", "sec_desktop_admin.bin")
  return dpapiUnprotect(readFileSync(blobPath, "utf8").trim())
}
