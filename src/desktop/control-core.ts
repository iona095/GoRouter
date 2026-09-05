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
import { log } from '../util.ts'
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
  let lastStateIno = -1
  let journalBaseline = false
  const lastJournalSig = new Map<string, string>()

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

  // Slice C: one persistent readonly handle + compiled statements for the
  // service lifetime. Reopened when the DB file is replaced/reset (sig
  // mismatch) or after any query error; closed on stop(). Readers never
  // block the routing writer (WAL), and each query is its own read so no
  // stale snapshot is held across checkpoints.
  interface RoHandle {
    db: Database;
    sig: string;
    metaStmt: ReturnType<Database['query']>;
    countStmt: ReturnType<Database['query']>;
    oldestStmt: ReturnType<Database['query']>;
    newestStmt: ReturnType<Database['query']>;
    recentStmt: ReturnType<Database['query']>;
  }
  let roHandle: RoHandle | null = null

  // CURRENT-010: sibling sigs include ino (same-keyed cache family).
  function dbSig(): string | null {
    try {
      const st = statSync(paths.journalDb)
      return `${st.mtimeMs}:${st.size}:${st.ino}`
    } catch {
      return null
    }
  }

  // C1 fix: WAL commits move only the -wal/-shm siblings (the T-D04 premise),
  // so a main-file key cannot heal the stats TTL after a sibling-only commit.
  // The TTL key covers all three siblings; any journal write busts it.
  function journalDirtSig(): string | null {
    const sigPart = (p: string): string => {
      try {
        const st = statSync(p)
        return `${st.mtimeMs}:${st.size}:${st.ino}`
      } catch {
        return '-'
      }
    }
    const main = dbSig()
    if (main === null) return null
    return `${main}|${sigPart(paths.journalDb + '-wal')}|${sigPart(paths.journalDb + '-shm')}`
  }

  // BL-001: finalize statements BEFORE db.close (same GC-finalization
  // dependence as the writer journal — the readonly handle lingered too).
  function closeRoHandle(): void {
    if (roHandle) {
      const h = roHandle
      roHandle = null
      for (const s of [h.metaStmt, h.countStmt, h.oldestStmt, h.newestStmt, h.recentStmt]) {
        try {
          s.finalize()
        } catch {
          /* already finalized */
        }
      }
      try {
        h.db.close()
      } catch {
        /* already closed */
      }
    }
  }

  function openReadonly(): RoHandle | null {
    const sig = dbSig()
    if (sig === null) {
      closeRoHandle() // DB deleted/reset: drop the stale handle
      return null
    }
    if (roHandle && roHandle.sig === sig) return roHandle
    closeRoHandle() // replaced under us: reopen against the new file
    // NB: the file EXISTS here, so open/prepare failure is corruption, not
    // absence — it throws and callers report degraded (never null).
    try {
      const db = new Database(paths.journalDb, { readonly: true })
      const h: RoHandle = {
        db,
        sig,
        metaStmt: db.query('SELECT value FROM journal_meta WHERE key = ?'),
        countStmt: db.query('SELECT COUNT(*) AS n FROM request_journal'),
        oldestStmt: db.query('SELECT MIN(started_at_utc) AS v FROM request_journal'),
        newestStmt: db.query('SELECT MAX(started_at_utc) AS v FROM request_journal'),
        recentStmt: db.query(
          `SELECT router_request_id, started_at_utc, completed_at_utc, duration_ms, lane,
                  selected_account_alias_snapshot, method, endpoint_family, terminal_outcome,
                  http_status, upstream_request_ids, model, client_correlation_id
           FROM request_journal
           ORDER BY started_at_utc DESC, id DESC
           LIMIT ?`,
        ),
      }
      roHandle = h
      return h
    } catch (e) {
      throw e
    }
  }

  // Aggregate TTL: the poll already samples at 1s + 250ms debounce, so a 2s
  // stats cache is invisible in the UI and skips the COUNT(*) scan per tick.
  // Only successes cache — degraded results always re-probe next tick.
  const STATS_TTL_MS = 2000
  let statsCache: { at: number; sig: string | null; value: SnapshotJournal } | null = null

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
    const now = Date.now()
    // TTL hit requires a quiet journal: any sibling move since cache time
    // busts the cache so a fresh push is never dedup-suppressed (C1).
    const dirt = journalDirtSig()
    if (statsCache && dirt !== null && statsCache.sig === dirt && now - statsCache.at < STATS_TTL_MS) {
      return { ...statsCache.value, retentionDays: base.retentionDays, maxRecords: base.maxRecords }
    }
    let h: RoHandle | null
    try {
      h = openReadonly()
    } catch (e) {
      return { ...base, degraded: true, lastError: e instanceof Error ? e.message : String(e) }
    }
    if (!h) return base
    try {
      const meta = h.metaStmt.get('schema_version') as { value: string } | undefined
      const count = h.countStmt.get() as { n: number }
      const oldest = h.oldestStmt.get() as { v: string | null }
      const newest = h.newestStmt.get() as { v: string | null }
      const value: SnapshotJournal = {
        ...base,
        schemaVersion: meta ? Number(meta.value) || 1 : 1,
        records: count.n,
        oldestRecordAtUtc: oldest.v,
        newestRecordAtUtc: newest.v,
      }
      statsCache = { at: now, sig: journalDirtSig(), value }
      return value
    } catch (e) {
      closeRoHandle() // poisoned handle (e.g. schema mid-migration): reopen next tick
      return { ...base, degraded: true, lastError: e instanceof Error ? e.message : String(e) }
    }
  }

  function journalRecent(limit: number): { rows: JournalRowView[]; degraded: boolean; error: string | null } {
    const n = Math.max(1, Math.min(JOURNAL_RECENT_LIMIT_MAX, Number.isFinite(limit) ? Math.floor(limit) : 100))
    let h: RoHandle | null
    try {
      h = openReadonly()
    } catch (e) {
      return { rows: [], degraded: true, error: e instanceof Error ? e.message : String(e) }
    }
    if (!h) return { rows: [], degraded: false, error: null }
    try {
      const rows = h.recentStmt.all(n) as unknown as JournalDbRow[]
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
      closeRoHandle()
      return { rows: [], degraded: true, error: e instanceof Error ? e.message : String(e) }
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
        theme: desk.theme,
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

  // CURRENT-010: identity includes ino (atomic replaces mint a new file
  // identity — same-size/same-tick replacements are still detected).
  function statSafe(p: string): { mtimeMs: number; size: number; ino: number } | null {
    try {
      const st = statSync(p)
      return { mtimeMs: st.mtimeMs, size: st.size, ino: st.ino }
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
        lastStateIno = sj.ino
      } else if (sj.mtimeMs !== lastStateMtime || sj.size !== lastStateSize || sj.ino !== lastStateIno) {
        lastStateMtime = sj.mtimeMs
        lastStateSize = sj.size
        lastStateIno = sj.ino
        noteChange()
      }
    }
    // WAL mode (T-D04): commits land in -wal/-shm while the main DB file
    // sits unchanged until checkpoint — watch the siblings too, or change
    // notifications stall until the next checkpoint.
    for (const p of [paths.journalDb, `${paths.journalDb}-wal`, `${paths.journalDb}-shm`]) {
      const jd = statSafe(p)
      if (!jd) continue
      const key = `${jd.mtimeMs}:${jd.size}:${jd.ino}`
      const prev = lastJournalSig.get(p)
      if (prev === undefined) {
        if (!journalBaseline) lastJournalSig.set(p, key)
        // A sibling appearing mid-run (first WAL commit) is itself a change.
        else {
          lastJournalSig.set(p, key)
          noteChange()
        }
      } else if (prev !== key) {
        lastJournalSig.set(p, key)
        noteChange()
      }
    }
    journalBaseline = true
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
          // GR-004: a version-gated desktop.json refuses this best-effort
          // marker — the service must still start (the refusal, not a dead
          // service, is the fail-closed behavior).
          try {
            desktop.write({ ...desk, freshStateCreatedAtUtc: new Date().toISOString() })
          } catch (e) {
            log.warn(`fresh-state marker not recorded: ${e instanceof Error ? e.message : String(e)}`)
          }
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
      // GR-005: the supervisor proves router identity per probe against the
      // same DPAPI-held credential a legitimate router serves proofs with.
      localCredential: () => {
        try {
          return domain.localCredential()
        } catch {
          return null
        }
      },
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
    // Slice C: drop the persistent journal handle + stats TTL with the
    // lifecycle so a restart reopens against the live file.
    closeRoHandle()
    statsCache = null
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

  function setDesktop(partial: { startAtLogin?: boolean; minimizeToTray?: boolean; firstRunDone?: boolean; theme?: 'light' | 'dark' }): DesktopSettingsFile {
    const current = desktop.read()
    const next: DesktopSettingsFile = {
      schemaVersion: 1,
      startAtLogin: partial.startAtLogin ?? current.startAtLogin,
      minimizeToTray: partial.minimizeToTray ?? current.minimizeToTray,
      theme: partial.theme ?? current.theme,
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
