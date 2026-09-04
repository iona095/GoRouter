/**
 * GoRouter V1.5 — control service core.
 *
 * Owns the router supervisor, the 1s state.json/journal.db mtime poll (CLI
 * coherence), snapshot assembly (exact protocol shape), debounced snapshot
 * event emission (<=500ms, min 250ms gap), desktop settings, and the
 * first-run / localCred.once lifecycle. Domain mutations are performed by
 * the caller through src/domain.ts (shared with the CLI); the core reflects
 * them into snapshots and events.
 */
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import type { Paths } from '../paths.ts'
import type { SecretStore } from '../secret-store.ts'
import type { Domain } from '../domain.ts'
import { createRouterSupervisor, defaultRouterCommand, type RouterCommand, type RouterMode, type RouterState, type RouterSupervisor } from './supervisor.ts'
import {
  loadDesktopSettings,
  type DesktopSettings,
  type DesktopSettingsFile,
} from './desktop-settings.ts'
import { ADMIN_TOKEN_REF } from './admin-token.ts'
import {
  SERVICE_VERSION,
  type JournalRowView,
  type RouterSnapshotMode,
  type RouterSnapshotState,
  type Snapshot,
  type SnapshotJournal,
  type SnapshotRouter,
} from './protocol.ts'

export interface ControlServiceOptions {
  paths: Paths
  secrets: SecretStore
  domain: Domain
  pipeName: string
  routerCmd?: RouterCommand
  /** Test-only overrides (defaults match the contract). */
  probeIntervalMs?: number
  pollIntervalMs?: number
  backoffMs?: number[]
  desktop?: DesktopSettings
}

export interface ControlService {
  start(): void
  /** Teardown; stopRouter=false leaves a managed router child running (app.exit stopRouter:false). */
  stop(stopRouter?: boolean): void
  snapshot(): Snapshot
  onSnapshot(cb: (snap: Snapshot) => void): () => void
  router: RouterSupervisor
  /** Wire-shaped router view (state mapped to running/… per protocol). */
  routerView(): SnapshotRouter
  journalRecent(limit: number): { rows: JournalRowView[]; degraded: boolean; error: string | null }
  journalStats(): SnapshotJournal
  setDesktop(partial: { startAtLogin?: boolean; minimizeToTray?: boolean; firstRunDone?: boolean }): DesktopSettingsFile
  /** localCred.once product: the local credential while armed, else null (consumes it). */
  localCredOnce(): string | null
  /** Schedule a debounced snapshot event (after a mutation / external change). */
  noteChange(): void
}

const DEFAULT_POLL_INTERVAL_MS = 1_000
const SECRET_PROBE_TTL_MS = 5_000
const JOURNAL_RECENT_LIMIT_MAX = 1_000

function mapRouterState(state: RouterState): RouterSnapshotState {
  if (state === 'attached' || state === 'managed') return 'running'
  return state
}

function mapRouterMode(mode: RouterMode): RouterSnapshotMode {
  return mode
}

interface JournalDbRow {
  router_request_id: string
  started_at_utc: string
  completed_at_utc: string | null
  duration_ms: number | null
  lane: string
  selected_account_alias_snapshot: string | null
  method: string
  endpoint_family: string
  terminal_outcome: string
  http_status: number | null
  upstream_request_ids: string
  model: string | null
  client_correlation_id: string | null
}

function parseIds(raw: unknown): string[] {
  if (typeof raw !== 'string') return []
  try {
    const v = JSON.parse(raw) as unknown
    if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v
    return []
  } catch {
    return []
  }
}

export function createControlService(opts: ControlServiceOptions): ControlService {
  const { paths, secrets, domain } = opts
  const desktop = opts.desktop ?? loadDesktopSettings(paths.state)
  const listeners = new Set<(snap: Snapshot) => void>()

  let started = false
  let freshInit = false
  let armedCredential: string | null = null
  let onceConsumed = false
  let supervisor: RouterSupervisor | null = null
  let pollTimer: ReturnType<typeof setInterval> | null = null

  // secret-store health probe cache (dpapiUnprotect of the admin token blob)
  let secretProbeAt = 0
  let secretProbeOk = false

  // mtime poll baselines
  let stateBaseline = false
  let lastStateMtime = 0
  let lastStateSize = -1
  let journalBaseline = false
  let lastJournalMtime = 0
  let lastJournalSize = -1

  // debounced emission
  let emitScheduled = false
  let emitTimer: ReturnType<typeof setTimeout> | null = null
  let lastEmitAt = 0
  let lastEmittedJson: string | null = null

  // ------------------------------------------------------------------
  // secret-store health
  // ------------------------------------------------------------------

  function probeSecretStore(): 'ok' | 'unavailable' {
    const now = Date.now()
    if (now - secretProbeAt > SECRET_PROBE_TTL_MS) {
      secretProbeAt = now
      try {
        secrets.get(ADMIN_TOKEN_REF)
        secretProbeOk = true
      } catch {
        secretProbeOk = false
      }
    }
    return secretProbeOk ? 'ok' : 'unavailable'
  }

  // ------------------------------------------------------------------
  // read-only journal access (WAL-compatible, never blocks routing)
  // ------------------------------------------------------------------

  function openReadonly(): Database | null {
    if (!existsSync(paths.journalDb)) return null
    try {
      return new Database(paths.journalDb, { readonly: true })
    } catch {
      return null
    }
  }

  function journalStats(): SnapshotJournal {
    const settings = domain.configShow()
    const base: SnapshotJournal = {
      schemaVersion: 1,
      records: 0,
      oldestRecordAtUtc: null,
      newestRecordAtUtc: null,
      degraded: false,
      lastError: null,
      retentionDays: settings.journalRetentionDays,
      maxRecords: settings.journalMaxRecords,
    }
    const db = openReadonly()
    if (!db) return base
    try {
      const meta = db.query('SELECT value FROM journal_meta WHERE key = ?').get('schema_version') as
        | { value: string }
        | undefined
      const count = db.query('SELECT COUNT(*) AS n FROM request_journal').get() as { n: number }
      const oldest = db.query('SELECT MIN(started_at_utc) AS v FROM request_journal').get() as { v: string | null }
      const newest = db.query('SELECT MAX(started_at_utc) AS v FROM request_journal').get() as { v: string | null }
      return {
        ...base,
        schemaVersion: meta ? Number(meta.value) || 1 : 1,
        records: count.n,
        oldestRecordAtUtc: oldest.v,
        newestRecordAtUtc: newest.v,
      }
    } catch (e) {
      return { ...base, degraded: true, lastError: e instanceof Error ? e.message : String(e) }
    } finally {
      db.close()
    }
  }

  function journalRecent(limit: number): { rows: JournalRowView[]; degraded: boolean; error: string | null } {
    const n = Math.max(1, Math.min(JOURNAL_RECENT_LIMIT_MAX, Number.isFinite(limit) ? Math.floor(limit) : 100))
    const db = openReadonly()
    if (!db) return { rows: [], degraded: false, error: null }
    try {
      const rows = db
        .query(
          `SELECT router_request_id, started_at_utc, completed_at_utc, duration_ms, lane,
                  selected_account_alias_snapshot, method, endpoint_family, terminal_outcome,
                  http_status, upstream_request_ids, model, client_correlation_id
           FROM request_journal
           ORDER BY started_at_utc DESC, id DESC
           LIMIT ?`,
        )
        .all(n) as unknown as JournalDbRow[]
      const out: JournalRowView[] = rows.map((r) => ({
        routerRequestId: r.router_request_id,
        startedAtUtc: r.started_at_utc,
        completedAtUtc: r.completed_at_utc,
        durationMs: r.duration_ms,
        lane: r.lane,
        selectedAccountAliasSnapshot: r.selected_account_alias_snapshot,
        method: r.method,
        endpointFamily: r.endpoint_family,
        terminalOutcome: r.terminal_outcome,
        httpStatus: r.http_status,
        upstreamRequestIds: parseIds(r.upstream_request_ids),
        model: r.model,
        clientCorrelationId: r.client_correlation_id,
      }))
      return { rows: out, degraded: false, error: null }
    } catch (e) {
      return { rows: [], degraded: true, error: e instanceof Error ? e.message : String(e) }
    } finally {
      db.close()
    }
  }

  // ------------------------------------------------------------------
  // snapshot assembly (single authoritative shape)
  // ------------------------------------------------------------------

  function firstRunNow(): boolean {
    const desk = desktop.read()
    // PS-05/INV-07: firstRun derives from the PERSISTED fresh-state marker so
    // a service restart mid-onboarding does not silently lose the one-time
    // local-credential display; adopted V1 state never sets the marker.
    return desk.freshStateCreatedAtUtc !== null && desk.firstRunDoneAtUtc === null
  }

  function routerView(): SnapshotRouter {
    const sup = supervisor?.snapshot()
    if (!sup) {
      return { state: 'stopped', mode: 'none', pid: null, port: domain.configShow().port, restartCount: 0 }
    }
    return {
      state: mapRouterState(sup.state),
      mode: mapRouterMode(sup.mode),
      pid: sup.pid,
      port: sup.port,
      restartCount: sup.restartCount,
    }
  }

  function snapshot(): Snapshot {
    const st = domain.status()
    const desk = desktop.read()
    return {
      serviceVersion: SERVICE_VERSION,
      initialized: st.initialized,
      firstRun: firstRunNow(),
      stateCorrupt: st.stateCorrupt,
      secretStore: probeSecretStore(),
      settings: {
        port: st.settings.port,
        journalRetentionDays: st.settings.journalRetentionDays,
        journalMaxRecords: st.settings.journalMaxRecords,
      },
      routes: Object.fromEntries(
        st.routes.map((r) => [r.lane, { accountId: r.accountId, alias: r.alias }]),
      ) as Record<string, { accountId: string | null; alias: string | null }>,
      accounts: st.accounts.map((a) => ({
        id: a.id,
        alias: a.alias,
        secretPresent: a.secretPresent,
        usedBy: a.usedBy,
        createdAtUtc: a.createdAtUtc,
        updatedAtUtc: a.updatedAtUtc,
      })),
      router: routerView(),
      journal: journalStats(),
      desktop: {
        startAtLogin: desk.startAtLogin,
        minimizeToTray: desk.minimizeToTray,
        firstRunDoneAtUtc: desk.firstRunDoneAtUtc,
      },
      stateDir: paths.state,
      localCredentialConfigured: st.localCredentialConfigured,
    }
  }

  // ------------------------------------------------------------------
  // debounced event emission (<=500ms, min 250ms gap, dedup)
  // ------------------------------------------------------------------

  function pushSnapshot(): void {
    const snap = snapshot()
    const json = JSON.stringify(snap)
    if (json === lastEmittedJson) return
    lastEmittedJson = json
    for (const cb of [...listeners]) cb(snap)
  }

  function noteChange(): void {
    // Post-teardown emissions are the exact hole F-28 closes: stop() cancels
    // the pending timer, and anything scheduled afterwards (external callers,
    // or a synchronous supervisor.close() callback racing the clear) must not
    // invoke detached listeners against a closed supervisor.
    if (!started) return
    if (emitScheduled) return
    emitScheduled = true
    const gap = Date.now() - lastEmitAt
    let wait = 250 // debounce window
    if (gap < 250) wait += 250 - gap // respect the min inter-event gap
    emitTimer = setTimeout(() => {
      emitScheduled = false
      emitTimer = null
      lastEmitAt = Date.now()
      pushSnapshot()
    }, wait)
  }

  // ------------------------------------------------------------------
  // mtime poll (CLI coherence)
  // ------------------------------------------------------------------

  function statSafe(p: string): { mtimeMs: number; size: number } | null {
    try {
      const st = statSync(p)
      return { mtimeMs: st.mtimeMs, size: st.size }
    } catch {
      return null
    }
  }

  function poll(): void {
    const sj = statSafe(paths.stateJson)
    if (sj) {
      if (!stateBaseline) {
        stateBaseline = true
        lastStateMtime = sj.mtimeMs
        lastStateSize = sj.size
      } else if (sj.mtimeMs !== lastStateMtime || sj.size !== lastStateSize) {
        lastStateMtime = sj.mtimeMs
        lastStateSize = sj.size
        noteChange()
      }
    }
    const jd = statSafe(paths.journalDb)
    if (jd) {
      if (!journalBaseline) {
        journalBaseline = true
        lastJournalMtime = jd.mtimeMs
        lastJournalSize = jd.size
      } else if (jd.mtimeMs !== lastJournalMtime || jd.size !== lastJournalSize) {
        lastJournalMtime = jd.mtimeMs
        lastJournalSize = jd.size
        noteChange()
      }
    }
  }

  // ------------------------------------------------------------------
  // lifecycle
  // ------------------------------------------------------------------

  function start(): void {
    if (started) return
    started = true
    if (!existsSync(paths.stateJson)) {
      // genuinely fresh state: create it (local credential printed once)
      const { created, credential } = domain.setup()
      freshInit = created
      if (created && credential !== null) {
        const desk = desktop.read()
        if (desk.freshStateCreatedAtUtc === null) {
          desktop.write({ ...desk, freshStateCreatedAtUtc: new Date().toISOString() })
        }
      }
    } else {
      // adopted state: never silently rotate a missing/corrupt local
      // credential here (INV-07) — snapshot.localCredentialConfigured=false
      // surfaces it and the CLI `setup` is the documented repair path
      freshInit = false
    }
    const desk = desktop.read()
    if (firstRunNow()) {
      // arm localCred.once; re-armed across service restarts until onboarding
      // completes (the credential is retrievable via the CLI as well)
      try {
        armedCredential = domain.localCredential()
        onceConsumed = false
      } catch {
        armedCredential = null
        onceConsumed = true
      }
    } else {
      armedCredential = null
      onceConsumed = true
    }
    supervisor = createRouterSupervisor({
      port: () => domain.configShow().port,
      routerCmd: () => opts.routerCmd ?? defaultRouterCommand(),
      stateDir: paths.state,
      probeIntervalMs: opts.probeIntervalMs,
      backoffMs: opts.backoffMs,
      onStateChange: () => noteChange(),
    })
    // Auto-start policy: stay stopped while onboarding (firstRun) is pending
    // or while desktop.json is unreadable (corrupt settings must not drive a
    // router crash-loop — STATE-03); setDesktop({firstRunDone:true}) starts
    // the router.
    if (!firstRunNow() && !desktop.corrupt()) supervisor.start()
    if (pollTimer === null) {
      pollTimer = setInterval(poll, opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS)
    }
  }

  function stop(stopRouter = true): void {
    if (!started) return
    started = false
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
    // A debounced emission must never fire after teardown (F-28): it would
    // invoke detached listeners against a closed supervisor.
    if (emitTimer) {
      clearTimeout(emitTimer)
      emitTimer = null
    }
    emitScheduled = false
    // Reset dedup state with the lifecycle: a stop->start cycle whose first
    // snapshot serializes identically to pre-stop must still emit to
    // (possibly re-attached) listeners, or the UI goes stale silently.
    lastEmittedJson = null
    supervisor?.close(stopRouter)
  }

  function onSnapshot(cb: (snap: Snapshot) => void): () => void {
    listeners.add(cb)
    return () => {
      listeners.delete(cb)
    }
  }

  function setDesktop(partial: { startAtLogin?: boolean; minimizeToTray?: boolean; firstRunDone?: boolean }): DesktopSettingsFile {
    const current = desktop.read()
    const next: DesktopSettingsFile = {
      schemaVersion: 1,
      startAtLogin: partial.startAtLogin ?? current.startAtLogin,
      minimizeToTray: partial.minimizeToTray ?? current.minimizeToTray,
      firstRunDoneAtUtc:
        partial.firstRunDone === true && current.firstRunDoneAtUtc === null
          ? new Date().toISOString()
          : current.firstRunDoneAtUtc,
      freshStateCreatedAtUtc: current.freshStateCreatedAtUtc,
    }
    desktop.write(next)
    if (partial.firstRunDone === true) {
      armedCredential = null // permanently unavailable for this state
      onceConsumed = true
      // onboarding completed: apply the auto-start policy now
      if (supervisor && supervisor.snapshot().state === 'stopped') supervisor.start()
    }
    noteChange()
    return next
  }

  function localCredOnce(): string | null {
    if (armedCredential !== null && !onceConsumed) {
      const c = armedCredential
      onceConsumed = true
      return c
    }
    return null
  }

  return {
    start,
    stop,
    snapshot,
    onSnapshot,
    router: {
      start: () => supervisor?.start(),
      stop: () => supervisor?.stop(),
      restart: () => supervisor?.restart(),
      snapshot: () => supervisor?.snapshot() ?? { state: 'stopped' as const, mode: 'none' as const, pid: null, port: domain.configShow().port, restartCount: 0 },
      close: (stopChild: boolean) => supervisor?.close(stopChild),
    },
    routerView,
    journalRecent,
    journalStats,
    setDesktop,
    localCredOnce,
    noteChange,
  }
}
