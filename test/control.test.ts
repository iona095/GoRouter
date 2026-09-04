/**
 * GoRouter V1.5 — desktop control service tests (slice B).
 *
 * (a) in-process core: snapshot shape, op handlers against a real domain
 *     with a memSecrets store, journal reads, config/desktop/localCred
 *     lifecycle, app.exit stopping the managed child.
 * (b) real pipe integration: control-service.ts as a subprocess (dev mode)
 *     against a temp state dir seeded through the CLI (real DPAPI), with
 *     the shared fake router; auth, concurrency/mutation-lock, attach,
 *     port_conflict, crash/backoff, and CLI coherence.
 *
 * No fixed ports (ports come from a temporary listener), temp dirs are
 * cleaned up, and every mutation goes through the same domain layer the CLI
 * uses.
 */
import { describe, test, expect, afterEach, beforeEach, setDefaultTimeout } from 'bun:test'

// Integration tests spawn real subprocesses (CLI DPAPI seeding, the control
// service, fake routers); the 5s bun default is too short.
setDefaultTimeout(120_000)
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import net from 'node:net'
import type { Subprocess } from 'bun'
import { createControlService } from '../src/desktop/control-core.ts'
import { loadDesktopSettings } from '../src/desktop/desktop-settings.ts'
import { createOpHandlers, resolveRouterCommand } from '../src/desktop/control-service.ts'
import { createPipeClient } from '../src/desktop/protocol.ts'
import { hardenPipeDacl, inspectPipeDacl } from '../src/desktop/pipe-acl.ts'
import type { JournalRowView, Snapshot } from '../src/desktop/protocol.ts'
import { createDomain } from '../src/domain.ts'
import { resolvePaths, ensureStateDirs } from '../src/paths.ts'
import { dpapiUnprotect } from '../src/secret-store.ts'
import { createJournal } from '../src/journal.ts'
import { memSecrets } from './harness.ts'
import type { RouterCommand } from '../src/desktop/supervisor.ts'

const ROOT = resolve(import.meta.dir, '..')
const dirs: string[] = []

afterEach(async () => {
  for (const d of dirs.splice(0)) {
    // bun:sqlite WAL -shm/-wal handles release asynchronously on Windows;
    // under parallel worker load the release can take many seconds — retry
    // generously (non-blocking sleeps so the release can actually run).
    // Verified: core.stop() clears the poll timer synchronously and the
    // tests close their journal handles; the residual lock is the async
    // WAL release, so a bounded wait is the correct mitigation.
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        rmSync(d, { recursive: true, force: true })
        break
      } catch (err) {
        if (attempt === 29) {
          const listing = Bun.spawnSync(['cmd', '/c', 'dir', '/s', '/b', d]).stdout?.toString() ?? ''
          throw new Error(`cleanup failed for ${d}; contents: ${listing.slice(0, 500)}`)
        }
        await sleep(Math.min(200 * (attempt + 1), 2000))
      }
    }
  }
})

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function freshStateDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'gorouter-ctrl-'))
  dirs.push(d)
  return d
}

function uniquePipe(prefix: string): string {
  return `\\\\.\\pipe\\gorouter-ctrl-${prefix}-${randomUUID().replace(/-/g, '')}`
}

async function freePort(): Promise<number> {
  const srv = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('x') })
  const p = srv.port ?? 0
  srv.stop(true)
  return p
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms))
}

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs: number, stepMs = 100): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await cond()) return
    if (Date.now() >= deadline) throw new Error('waitFor timed out')
    await sleep(stepMs)
  }
}

async function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port, timeout: 1000 })
    sock.once('connect', () => {
      sock.destroy()
      resolve(false)
    })
    sock.once('error', () => resolve(true))
  })
}

function markerLines(marker: string): string[] {
  if (!existsSync(marker)) return []
  return readFileSync(marker, 'utf8').trim().split('\n').filter(Boolean)
}

/** In-process core with a memSecrets store and the real domain. */
function freshCore(opts?: {
  firstRunDone?: boolean
  port?: number
  routerCmd?: RouterCommand
  backoffMs?: number[]
  probeIntervalMs?: number
}): {
  core: ReturnType<typeof createControlService>
  handlers: ReturnType<typeof createOpHandlers>
  paths: ReturnType<typeof resolvePaths>
  stateDir: string
  secrets: ReturnType<typeof memSecrets>
} {
  const stateDir = freshStateDir()
  const paths = resolvePaths(stateDir)
  ensureStateDirs(paths)
  const secrets = memSecrets({ sec_desktop_admin: 'test-admin-token' })
  const domain = createDomain(paths, secrets)
  if (opts?.firstRunDone) {
    loadDesktopSettings(stateDir).write({
      schemaVersion: 1,
      startAtLogin: false,
      minimizeToTray: false,
      firstRunDoneAtUtc: '2026-01-01T00:00:00.000Z',
      freshStateCreatedAtUtc: null,
    })
  }
  if (opts?.port !== undefined) domain.configSet('port', String(opts.port))
  const core = createControlService({
    paths,
    secrets,
    domain,
    pipeName: 'inproc',
    routerCmd: opts?.routerCmd,
    backoffMs: opts?.backoffMs,
    probeIntervalMs: opts?.probeIntervalMs,
  })
  const handlers = createOpHandlers({ core, domain })
  return { core, handlers, paths, stateDir, secrets }
}

// ---------------------------------------------------------------------------
// (a) in-process core
// ---------------------------------------------------------------------------

describe('router command resolution (F-01)', () => {
  const KEY = 'GOROUTER_DESKTOP_ROUTER_CMD_JSON'
  let saved: string | undefined
  beforeEach(() => { saved = process.env[KEY]; });
  afterEach(() => {
    if (saved === undefined) delete process.env[KEY];
    else process.env[KEY] = saved;
  });
  test('dev honors the env override', () => {
    process.env[KEY] = JSON.stringify([' C:\\evil\\router.exe ', 'serve']);
    const cmd = resolveRouterCommand({ packaged: false });
    expect(cmd.argv).toEqual([' C:\\evil\\router.exe ', 'serve']);
  });
  test('packaged ignores the env override (fixed bundled router)', () => {
    process.env[KEY] = JSON.stringify(['C:\\evil\\router.exe', 'serve']);
    const cmd = resolveRouterCommand({ packaged: true });
    expect(cmd.argv).not.toContain('C:\\evil\\router.exe');
  });
  test('packaged ignores even malformed JSON (no throw, bundled default)', () => {
    process.env[KEY] = 'not-json{';
    expect(() => resolveRouterCommand({ packaged: true })).not.toThrow();
  });
  test('dev still rejects malformed JSON loudly', () => {
    process.env[KEY] = 'not-json{';
    expect(() => resolveRouterCommand({ packaged: false })).toThrow(/not valid JSON/);
  });
});

describe('in-process control core', () => {
  test('journal WAL commit surfaces a snapshot push even when the main DB file is untouched (T-D04)', async () => {
    const { core, paths, stateDir } = freshCore({ firstRunDone: true })
    dirs.push(stateDir)
    // Seed one row pre-start so journal.db exists before the poll baselines.
    // Both handles stay pinned (holders) for the whole test: a GC-collected
    // handle closes its connection, and last-close checkpoints the WAL,
    // moving the main file under us and voiding the attribution.
    const holders: unknown[] = []
    const seed = createJournal(paths.journalDb, 30, 100000)
    holders.push(seed)
    const se = seed.begin({
      lane: 'go',
      selectedAccountId: null,
      selectedAccountAliasSnapshot: 'seed',
      method: 'POST',
      endpointFamily: 'chat/completions',
      terminalOutcome: 'ok',
      httpStatus: null,
      upstreamRequestIds: [],
      model: null,
      clientCorrelationId: null,
    })
    seed.complete(se, {
      completedAtUtc: '2026-01-01T00:00:00.000Z',
      durationMs: 1,
      terminalOutcome: 'ok',
      httpStatus: 200,
      upstreamRequestIds: [],
    })
    core.start()
    const seen: string[] = []
    const unsub = core.onSnapshot((s) => {
      seen.push(JSON.stringify(s))
    })
    try {
      await sleep(1500) // let the poll establish its baselines silently
      seen.length = 0
      // ms-floored: utimesSync restores only ms precision, and the poll
      // itself compares raw floats — flooring here is test-side tolerance.
      const sig = () => {
        const st = statSync(paths.journalDb)
        return `${Math.floor(st.mtimeMs)}:${st.size}`
      }
      const mainBefore = sig()
      const mainBytes = readFileSync(paths.journalDb)
      const mainMtime = statSync(paths.journalDb).mtime
      // A real commit, then the main DB file is restored byte-and-stamp
      // identical: the -wal/-shm siblings alone must surface the push
      // (the pre-checkpoint WAL shape T-D04 is about).
      const j = createJournal(paths.journalDb, 30, 100000)
      holders.push(j)
      const e = j.begin({
        lane: 'go',
        selectedAccountId: null,
        selectedAccountAliasSnapshot: 'alpha',
        method: 'POST',
        endpointFamily: 'chat/completions',
        terminalOutcome: 'ok',
        httpStatus: null,
        upstreamRequestIds: [],
        model: null,
        clientCorrelationId: null,
      })
      j.complete(e, {
        completedAtUtc: '2026-01-01T00:00:01.000Z',
        durationMs: 10,
        terminalOutcome: 'ok',
        httpStatus: 200,
        upstreamRequestIds: ['x-request-id: r1'],
      })
      const { utimesSync } = await import('node:fs')
      writeFileSync(paths.journalDb, mainBytes)
      utimesSync(paths.journalDb, mainMtime, mainMtime)
      expect(sig()).toBe(mainBefore) // main file indistinguishable from baseline
      let sigAtEmission = ""
      // Generous window: under full-suite parallel load the 1s poll + GC
      // pauses stretch far beyond solo timing (observed 10s+ starvation).
      await waitFor(() => {
        if (seen.length > 0) {
          sigAtEmission = sig()
          return true
        }
        return false
      }, 60_000)
      expect(seen.length).toBeGreaterThanOrEqual(1)
      // The push fired while the main file was still pristine: only the
      // -wal/-shm siblings could have surfaced it (later snapshot reads
      // may move the main file via WAL recovery — irrelevant post-proof).
      expect(sigAtEmission).toBe(mainBefore)
      expect(holders.length).toBe(2) // handles survived: no GC-close checkpoint
    } finally {
      unsub()
      core.stop()
    }
  })

  test('journalStats TTL heals when a sibling-only commit lands inside the window (C1)', () => {
    const { core, paths, stateDir } = freshCore({ firstRunDone: true })
    dirs.push(stateDir)
    const j = createJournal(paths.journalDb, 30, 100000)
    const row = (alias: string, at: string) => {
      const e = j.begin({
        lane: 'go',
        selectedAccountId: null,
        selectedAccountAliasSnapshot: alias,
        method: 'POST',
        endpointFamily: 'chat/completions',
        terminalOutcome: 'ok',
        httpStatus: null,
        upstreamRequestIds: [],
        model: null,
        clientCorrelationId: null,
      })
      j.complete(e, {
        completedAtUtc: at,
        durationMs: 10,
        terminalOutcome: 'ok',
        httpStatus: 200,
        upstreamRequestIds: [],
      })
    }
    core.start()
    try {
      row('a', '2026-01-01T00:00:01.000Z')
      expect(core.journalStats().records).toBe(1) // warms the TTL cache
      row('b', '2026-01-01T00:00:02.000Z') // second commit inside the 2s window
      // The sibling move busts the TTL: no stale N served, so a poll push
      // built on this stats call can never dedup-suppress fresh content.
      expect(core.journalStats().records).toBe(2)
    } finally {
      core.stop()
    }
  })

  test('snapshot has the exact protocol shape', () => {
    const { core, paths } = freshCore()
    core.start()
    const snap = core.snapshot()
    expect(Object.keys(snap).sort()).toEqual([
      'accounts',
      'desktop',
      'firstRun',
      'initialized',
      'journal',
      'localCredentialConfigured',
      'router',
      'routes',
      'secretStore',
      'serviceVersion',
      'settings',
      'stateCorrupt',
      'stateDir',
    ])
    expect(snap.serviceVersion).toBe('1.5.0')
    expect(snap.initialized).toBe(true)
    expect(snap.firstRun).toBe(true) // state freshly created by this service start
    expect(snap.stateCorrupt).toBe(false)
    expect(snap.secretStore).toBe('ok')
    expect(snap.settings).toEqual({ port: 8787, journalRetentionDays: 30, journalMaxRecords: 100000 })
    expect(snap.routes).toEqual({ go: { accountId: null, alias: null }, zen: { accountId: null, alias: null } })
    expect(snap.accounts).toEqual([])
    expect(snap.router).toEqual({ state: 'stopped', mode: 'none', pid: null, port: 8787, restartCount: 0 })
    expect(snap.journal).toMatchObject({
      schemaVersion: 1,
      records: 0,
      oldestRecordAtUtc: null,
      newestRecordAtUtc: null,
      degraded: false,
      lastError: null,
      retentionDays: 30,
      maxRecords: 100000,
    })
    expect(snap.desktop).toEqual({ startAtLogin: false, minimizeToTray: false, firstRunDoneAtUtc: null })
    expect(snap.stateDir).toBe(paths.state)
    expect(snap.localCredentialConfigured).toBe(true)
    core.stop()
  })

  test('route.set/route.clear via op handlers reflect in the snapshot', async () => {
    const { core, handlers } = freshCore()
    core.start()
    await handlers('account.add', { alias: 'alpha', secret: 'sk-alpha' })
    const r = (await handlers('route.set', { lane: 'go', accountId: 'alpha' })) as { lane: string; alias: string }
    expect(r.lane).toBe('go')
    expect(r.alias).toBe('alpha')
    expect(core.snapshot().routes.go.alias).toBe('alpha')
    await handlers('route.clear', { lane: 'go' })
    expect(core.snapshot().routes.go).toEqual({ accountId: null, alias: null })
    await expect(handlers('route.set', { lane: 'go', accountId: 'missing' })).rejects.toMatchObject({
      code: 'not_found',
    })
    await expect(handlers('route.set', { lane: 'gopher', accountId: 'alpha' })).rejects.toMatchObject({
      code: 'validation',
    })
    core.stop()
  })

  test('onSnapshot unsubscribe detaches; stop() cancels a pending debounced emission (F-28)', async () => {
    const { core } = freshCore()
    core.start()
    const seen: unknown[] = []
    const unsub = core.onSnapshot((snap) => seen.push(snap))
    core.noteChange()
    await new Promise((r) => setTimeout(r, 650))
    expect(seen.length).toBe(1)
    unsub()
    core.noteChange()
    await new Promise((r) => setTimeout(r, 650))
    expect(seen.length).toBe(1) // detached: no further calls
    // A debounced emission pending at stop() must never fire.
    let post = 0
    core.onSnapshot(() => post++)
    core.noteChange()
    core.stop(false)
    await new Promise((r) => setTimeout(r, 650))
    expect(post).toBe(0)
    // And noteChange() after stop() must not re-arm anything.
    core.noteChange()
    await new Promise((r) => setTimeout(r, 650))
    expect(post).toBe(0)
    // Unsubscribe is idempotent; double-stop is safe.
    unsub()
    core.stop(false)
  }, { timeout: 15000 })

  test('journal.recent returns seeded rows newest-first with only safe fields', () => {
    const { core, paths } = freshCore()
    core.start()
    const j = createJournal(paths.journalDb, 30, 100000)
    const e1 = j.begin({
      lane: 'go',
      selectedAccountId: null,
      selectedAccountAliasSnapshot: 'alpha',
      method: 'POST',
      endpointFamily: 'chat/completions',
      terminalOutcome: 'ok',
      httpStatus: null,
      upstreamRequestIds: [],
      model: null,
      clientCorrelationId: null,
    })
    j.complete(e1, {
      completedAtUtc: '2026-01-01T00:00:01.000Z',
      durationMs: 10,
      terminalOutcome: 'ok',
      httpStatus: 200,
      upstreamRequestIds: ['x-request-id: r1'],
    })
    const e2 = j.begin({
      lane: 'zen',
      selectedAccountId: null,
      selectedAccountAliasSnapshot: 'beta',
      method: 'GET',
      endpointFamily: 'models',
      terminalOutcome: 'ok',
      httpStatus: null,
      upstreamRequestIds: [],
      model: 'm1',
      clientCorrelationId: 'c2',
    })
    j.complete(e2, {
      completedAtUtc: '2026-01-01T00:00:02.000Z',
      durationMs: 20,
      terminalOutcome: 'ok',
      httpStatus: 200,
      upstreamRequestIds: [],
    })
    // checkpoint + truncate the WAL before close so no -wal/-shm debris holds
    // the temp dir open on Windows under parallel load
    j.prune()
    j.close()

    const res = core.journalRecent(10)
    expect(res.degraded).toBe(false)
    expect(res.error).toBeNull()
    expect(res.rows.length).toBe(2)
    expect(res.rows[0]!.lane).toBe('zen') // newest first
    expect(res.rows[1]!.lane).toBe('go')
    expect(res.rows[0]!.clientCorrelationId).toBe('c2')
    expect(res.rows[1]!.upstreamRequestIds).toEqual(['x-request-id: r1'])
    expect(Object.keys(res.rows[0]!).sort()).toEqual([
      'clientCorrelationId',
      'completedAtUtc',
      'durationMs',
      'endpointFamily',
      'httpStatus',
      'lane',
      'method',
      'model',
      'routerRequestId',
      'selectedAccountAliasSnapshot',
      'startedAtUtc',
      'terminalOutcome',
      'upstreamRequestIds',
    ])
    core.stop()
  })

  test('journal.recent degrades gracefully and clamps the limit', () => {
    const { core, paths } = freshCore()
    core.start()
    // no journal -> empty, not degraded
    expect(core.journalRecent(10)).toEqual({ rows: [], degraded: false, error: null })
    // corrupt journal file -> degraded with error, never throws
    writeFileSync(paths.journalDb, 'this is not a sqlite database at all')
    const res = core.journalRecent(2000)
    expect(res.rows).toEqual([])
    expect(res.degraded).toBe(true)
    expect(res.error).toBeTruthy()
    expect(core.journalStats().degraded).toBe(true)
    core.stop()
  })

  test('config.set allowlist + domain validation', async () => {
    const { core, handlers } = freshCore()
    core.start()
    await expect(handlers('config.set', { key: 'host', value: '0.0.0.0' })).rejects.toMatchObject({
      code: 'unsupported',
    })
    await expect(handlers('config.set', { key: 'upstreamGo', value: 'https://evil.example' })).rejects.toMatchObject({
      code: 'unsupported',
    })
    await expect(handlers('config.set', { key: 'bogus', value: '1' })).rejects.toMatchObject({ code: 'unsupported' })
    await expect(handlers('config.set', { key: 'port', value: '70000' })).rejects.toMatchObject({ code: 'validation' })
    await expect(handlers('config.set', { key: 'port', value: 'abc' })).rejects.toMatchObject({ code: 'validation' })
    await handlers('config.set', { key: 'port', value: '8899' })
    await handlers('config.set', { key: 'journalRetentionDays', value: '60' })
    await handlers('config.set', { key: 'journalMaxRecords', value: '5000' })
    expect(core.snapshot().settings).toEqual({ port: 8899, journalRetentionDays: 60, journalMaxRecords: 5000 })
    core.stop()
  })

  test('desktop.set is partial and firstRunDone completes onboarding', async () => {
    const { core, handlers } = freshCore()
    core.start()
    expect(core.snapshot().firstRun).toBe(true)
    await handlers('desktop.set', { startAtLogin: true })
    let snap = core.snapshot()
    expect(snap.desktop.startAtLogin).toBe(true)
    expect(snap.desktop.minimizeToTray).toBe(false)
    expect(snap.desktop.firstRunDoneAtUtc).toBeNull()
    expect(snap.firstRun).toBe(true)
    await handlers('desktop.set', { minimizeToTray: true })
    await handlers('desktop.set', { firstRunDone: true })
    snap = core.snapshot()
    expect(snap.firstRun).toBe(false)
    expect(snap.desktop.minimizeToTray).toBe(true)
    expect(snap.desktop.firstRunDoneAtUtc).toBeTruthy()
    await expect(handlers('desktop.set', {})).rejects.toMatchObject({ code: 'validation' })
    core.stop()
  })

  test('localCred.once: armed on fresh init, consumed once, then unavailable', async () => {
    const { core, handlers, paths, secrets } = freshCore()
    core.start()
    const once = (await handlers('localCred.once', {})) as { credential: string }
    expect(once.credential.length).toBeGreaterThan(20)
    // the armed credential IS the domain local credential for this fresh state
    const domain = createDomain(paths, secrets)
    expect(once.credential).toBe(domain.localCredential())
    await expect(handlers('localCred.once', {})).rejects.toMatchObject({ code: 'unavailable' })
    core.stop()
  })

  test('localCred.once unavailable for adopted state and after onboarding', async () => {
    const { core: core2, handlers: h2, paths, secrets, stateDir } = freshCore()
    core2.start()
    const cred = (await h2('localCred.once', {})) as { credential: string }
    expect(cred.credential.length).toBeGreaterThan(20)
    await h2('desktop.set', { firstRunDone: true })
    core2.stop()
    // a fresh service over the SAME state dir adopts it: firstRun false,
    // localCred.once permanently unavailable
    const core3 = createControlService({
      paths,
      secrets,
      domain: createDomain(paths, secrets),
      pipeName: 'inproc-adopted',
    })
    const h3 = createOpHandlers({ core: core3, domain: createDomain(paths, secrets) })
    core3.start()
    expect(core3.snapshot().firstRun).toBe(false)
    await expect(h3('localCred.once', {})).rejects.toMatchObject({ code: 'unavailable' })
    core3.stop()
    expect(stateDir.length).toBeGreaterThan(0)
  })

  test('app.exit stops the managed child', async () => {
    const port = await freePort()
    const { core, handlers, stateDir } = freshCore({
      firstRunDone: true,
      port,
      routerCmd: { argv: [process.execPath, 'test/fake-router.ts', '<port>'], cwd: ROOT },
      backoffMs: [100, 200],
    })
    core.start()
    // adopted state -> auto-start spawns the managed router
    await waitFor(() => core.snapshot().router.state === 'running' && core.snapshot().router.mode === 'managed', 10_000)
    expect(core.snapshot().router.pid).toBeTruthy()
    await handlers('app.exit', { stopRouter: true })
    expect(core.snapshot().router.state).toBe('stopped')
    expect(core.snapshot().router.pid).toBeNull()
    await waitFor(() => portIsFree(port), 5_000)
    core.stop()
    expect(existsSync(join(stateDir, 'state.json'))).toBe(true)
  })

  test('supervisor backoff: crashes -> restartCount grows -> failed, bounded spawns', async () => {
    const port = await freePort()
    const marker = join(freshStateDir(), 'spawns.log')
    const { core } = freshCore({
      firstRunDone: true,
      port,
      routerCmd: {
        argv: [process.execPath, 'test/fake-router.ts', '<port>', '--die-after-ms', '300', '--marker', marker],
        cwd: ROOT,
      },
      backoffMs: [50, 100, 200, 400, 800],
    })
    core.start()
    await waitFor(() => core.snapshot().router.state === 'failed', 15_000)
    const snap = core.snapshot()
    expect(snap.router.restartCount).toBeGreaterThanOrEqual(5)
    expect(snap.router.restartCount).toBeLessThanOrEqual(6)
    const lines = markerLines(marker)
    expect(lines.length).toBeGreaterThanOrEqual(6)
    expect(lines.length).toBeLessThanOrEqual(7)
    // no uncontrolled loop: stays failed without further spawns
    await sleep(1500)
    expect(markerLines(marker).length).toBe(lines.length)
    core.stop()
  })

  test('router.stop on an attached router -> external error', async () => {
    const port = await freePort()
    const fake = Bun.spawn([process.execPath, 'test/fake-router.ts', String(port)], {
      cwd: ROOT,
      stdout: 'ignore',
      stderr: 'ignore',
    })
    try {
      await waitFor(
        async () => {
          try {
            const r = await fetch(`http://127.0.0.1:${port}/healthz`)
            return r.ok
          } catch {
            return false
          }
        },
        10_000,
      )
      const { core, handlers } = freshCore({ firstRunDone: true, port, probeIntervalMs: 300 })
      core.start()
      await waitFor(() => core.snapshot().router.state === 'running' && core.snapshot().router.mode === 'attached', 10_000)
      await expect(handlers('router.stop', {})).rejects.toMatchObject({ code: 'external' })
      await expect(handlers('router.restart', {})).rejects.toMatchObject({ code: 'external' })
      core.stop()
    } finally {
      try {
        fake.kill()
      } catch {
        /* ignore */
      }
    }
  })
})

// ---------------------------------------------------------------------------
// (b) real pipe integration
// ---------------------------------------------------------------------------

function cliEnv(stateDir: string): Record<string, string> {
  return { ...(process.env as Record<string, string>), GOROUTER_STATE_DIR: stateDir }
}

async function cli(env: Record<string, string>, args: string[], input?: string): Promise<string> {
  const proc = Bun.spawn([process.execPath, 'src/cli.ts', ...args], {
    cwd: ROOT,
    env,
    stdin: input !== undefined ? 'pipe' : 'inherit',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (input !== undefined) {
    proc.stdin?.write(input)
    proc.stdin?.end()
  }
  const exitCode = await proc.exited
  const out = await new Response(proc.stdout).text()
  const err = await new Response(proc.stderr).text()
  if (exitCode !== 0) throw new Error(`cli ${args.join(' ')} failed (${exitCode}): ${err}`)
  return out
}

async function seedState(stateDir: string, port: number, accounts: Array<[string, string]>): Promise<void> {
  const env = cliEnv(stateDir)
  await cli(env, ['setup'])
  for (const [alias, secret] of accounts) {
    await cli(env, ['account', 'add', alias], `${secret}\n`)
  }
  await cli(env, ['config', 'set', 'port', String(port)])
}

function spawnService(stateDir: string, pipeName: string, routerArgv: string[]): Subprocess {
  return Bun.spawn([process.execPath, 'src/desktop/control-service.ts'], {
    cwd: ROOT,
    env: {
      ...(process.env as Record<string, string>),
      GOROUTER_STATE_DIR: stateDir,
      GOROUTER_DESKTOP_PIPE: pipeName,
      GOROUTER_DESKTOP_ROUTER_CMD_JSON: JSON.stringify(routerArgv),
      GOROUTER_LOG_LEVEL: 'error',
    },
    stdout: Bun.file(join(stateDir, 'service.stdout.log')),
    stderr: Bun.file(join(stateDir, 'service.stderr.log')),
  })
}

async function stopService(proc: Subprocess): Promise<void> {
  try {
    proc.kill()
  } catch {
    /* already gone */
  }
  await Promise.race([proc.exited, sleep(3000)])
  if (proc.exitCode === null) {
    try {
      proc.kill('SIGKILL')
    } catch {
      /* ignore */
    }
  }
}

async function waitForAdminToken(stateDir: string): Promise<string> {
  const blob = join(stateDir, 'secrets', 'sec_desktop_admin.bin')
  await waitFor(() => existsSync(blob), 10_000)
  return dpapiUnprotect(readFileSync(blob, 'utf8').trim())
}

async function connectPipe(pipeName: string, token: string, timeoutMs = 10_000): Promise<ReturnType<typeof createPipeClient>> {
  const deadline = Date.now() + timeoutMs
  let lastErr: unknown = null
  while (Date.now() < deadline) {
    const c = createPipeClient(pipeName, token)
    try {
      await Promise.race([
        c.request('hello', { app: 'test', version: '1.5.0' }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('connect timeout')), 500)),
      ])
      return c
    } catch (e) {
      lastErr = e
    }
    c.close()
    await sleep(150)
  }
  throw new Error(`pipe connect timed out: ${String(lastErr)}`)
}

describe('transport hello-gate (F-29)', () => {
  test('push reaches only hello-completed sockets', async () => {
    const { serveControlPipe } = await import('../src/desktop/transport.ts')
    const pipeName = `\\\\.\\pipe\\gorouter-hello-gate-${randomUUID()}`
    const token = 'test-token'
    const transport = serveControlPipe(
      pipeName,
      token,
      async (op) => {
        if (op === 'hello') return { version: '1.5.0' }
        if (op === 'ping') return { pong: true }
        throw Object.assign(new Error('unsupported op'), { code: 'unsupported' })
      },
    )
    await transport.listening
    const frames: string[] = []
    const raw = net.connect({ path: pipeName })
    await new Promise<void>((res, rej) => {
      raw.once('connect', () => res())
      raw.once('error', rej)
    })
    raw.on('data', (d: Buffer) => frames.push(d.toString('utf8')))
    const blob = () => frames.join('')
    // Authenticated but pre-hello: ping is rejected AND no pushes arrive.
    raw.write(JSON.stringify({ id: 1, token, op: 'ping' }) + '\n')
    await waitFor(() => blob().includes('"id":1'), 5_000)
    expect(blob()).toContain('hello must be the first message')
    transport.push('snap', { n: 1 })
    await sleep(300)
    expect(blob()).not.toContain('"event":"snap"')
    // Completed hello subscribes: pushes arrive from here on.
    raw.write(JSON.stringify({ id: 2, token, op: 'hello', params: {} }) + '\n')
    await waitFor(() => blob().includes('"id":2,"ok":true'), 5_000)
    transport.push('snap', { n: 2 })
    await waitFor(() => blob().includes('"event":"snap"'), 5_000)
    expect(blob()).toContain('"n":2')
    raw.destroy()
    await transport.close()
  })

  test('failed hello never subscribes; prior success survives a later failure', async () => {
    const { serveControlPipe } = await import('../src/desktop/transport.ts')
    const pipeName = `\\\\.\\pipe\\gorouter-hello-fail-${randomUUID()}`
    const token = 'test-token'
    let failHello = true
    const transport = serveControlPipe(pipeName, token, async (op) => {
      if (op === 'hello') {
        if (failHello) throw Object.assign(new Error('hello denied'), { code: 'unavailable' })
        return { version: '1.5.0' }
      }
      throw Object.assign(new Error('unsupported op'), { code: 'unsupported' })
    })
    await transport.listening
    const frames: string[] = []
    const raw = net.connect({ path: pipeName })
    await new Promise<void>((res, rej) => {
      raw.once('connect', () => res())
      raw.once('error', rej)
    })
    raw.on('data', (d: Buffer) => frames.push(d.toString('utf8')))
    const blob = () => frames.join('')
    // Failed hello: error response, socket stays open, no subscription.
    raw.write(JSON.stringify({ id: 1, token, op: 'hello', params: {} }) + '\n')
    await waitFor(() => blob().includes('"id":1,"ok":false'), 5_000)
    transport.push('snap', { n: 1 })
    await sleep(300)
    expect(blob()).not.toContain('"event":"snap"')
    // Retry after the handler recovers: subscribes, pushes arrive.
    failHello = false
    raw.write(JSON.stringify({ id: 2, token, op: 'hello', params: {} }) + '\n')
    await waitFor(() => blob().includes('"id":2,"ok":true'), 5_000)
    transport.push('snap', { n: 2 })
    await waitFor(() => blob().includes('"n":2'), 5_000)
    // A later failed hello must not evict the completed subscription.
    failHello = true
    raw.write(JSON.stringify({ id: 3, token, op: 'hello', params: {} }) + '\n')
    await waitFor(() => blob().includes('"id":3,"ok":false'), 5_000)
    transport.push('snap', { n: 3 })
    await waitFor(() => blob().includes('"n":3'), 5_000)
    raw.destroy()
    await transport.close()
  })
})

describe('real pipe integration', () => {
  test('frame cap: many coalesced small frames process; oversized partial line closes', async () => {
    const stateDir = freshStateDir()
    const port = await freePort()
    await seedState(stateDir, port, [])
    const pipeName = `\\\\.\\pipe\\gorouter-cap-test-${randomUUID()}`
    const proc = spawnService(stateDir, pipeName, [process.execPath, 'test/fake-router.ts', '<port>'])
    try {
      const token = await waitForAdminToken(stateDir)
      const raw = net.connect({ path: pipeName })
      await new Promise<void>((res, rej) => {
        raw.once('connect', () => res())
        raw.once('error', rej)
      })
      const got: number[] = []
      const rawBuf: Buffer[] = []
      const seen = (): string =>
        rawBuf.length > 1 ? Buffer.concat(rawBuf).toString('utf8') : (rawBuf[0]?.toString('utf8') ?? '')
      raw.on('data', (d: Buffer) => {
        rawBuf.push(d)
        const s = seen()
        for (const m of s.match(/"id":(\d+),"ok":true/g) ?? []) {
          const id = Number(/"id":(\d+)/.exec(m)![1])
          if (!got.includes(id)) got.push(id)
        }
      })
      // hello must be the first frame on a raw connection (listener already attached)
      raw.write(JSON.stringify({ id: 99, token, op: 'hello', params: { app: 'test', version: '1.5.0' } }) + '\n')
      await waitFor(() => got.includes(99), 8_000)
      // three ~400KB ping frames written as ONE coalesced chunk (>1MiB total):
      // the per-line cap must NOT reject them (each frame is < 1MiB)
      const pad = 'x'.repeat(400 * 1024)
      const frames = [100, 101, 102].map((id) => JSON.stringify({ id, token, op: 'ping', params: { pad } }) + '\n').join('')
      raw.write(frames)
      await waitFor(() => got.includes(100) && got.includes(101) && got.includes(102), 8_000)
      expect(got.filter((id) => id >= 100).sort()).toEqual([100, 101, 102])
      // an oversized partial line (>1MiB without a newline) must close the connection
      const closed = new Promise<void>((res) => raw.once('close', () => res()))
      raw.write(Buffer.alloc(2 * 1024 * 1024, 0x78))
      await Promise.race([
        closed,
        sleep(8_000).then(() => {
          throw new Error('oversized partial line did not close the socket')
        }),
      ])
      // the service itself is still alive and answers normally afterwards
      const client = await connectPipe(pipeName, token)
      const snap = (await client.request('snapshot')) as Snapshot
      expect(snap.initialized).toBe(true)
      await client.close()
    } finally {
      await stopService(proc)
    }
  }, 60_000)

  test('hello/snapshot/account/journal ops over the named pipe', async () => {
    const stateDir = freshStateDir()
    const port = await freePort()
    await seedState(stateDir, port, [
      ['alpha', 'sk-alpha'],
      ['beta', 'sk-beta'],
    ])
    // seed journal rows directly (service reads them read-only)
    const paths = resolvePaths(stateDir)
    const j = createJournal(paths.journalDb, 30, 100000)
    const e1 = j.begin({
      lane: 'go',
      selectedAccountId: null,
      selectedAccountAliasSnapshot: 'alpha',
      method: 'POST',
      endpointFamily: 'chat/completions',
      terminalOutcome: 'ok',
      httpStatus: null,
      upstreamRequestIds: [],
      model: null,
      clientCorrelationId: null,
    })
    j.complete(e1, {
      completedAtUtc: '2026-01-01T00:00:01.000Z',
      durationMs: 11,
      terminalOutcome: 'ok',
      httpStatus: 200,
      upstreamRequestIds: [],
    })
    const e2 = j.begin({
      lane: 'zen',
      selectedAccountId: null,
      selectedAccountAliasSnapshot: 'beta',
      method: 'GET',
      endpointFamily: 'models',
      terminalOutcome: 'ok',
      httpStatus: null,
      upstreamRequestIds: [],
      model: 'm2',
      clientCorrelationId: 'c2',
    })
    j.complete(e2, {
      completedAtUtc: '2026-01-01T00:00:02.000Z',
      durationMs: 22,
      terminalOutcome: 'ok',
      httpStatus: 200,
      upstreamRequestIds: [],
    })
    j.close()

    const pipeName = uniquePipe('main')
    const proc = spawnService(stateDir, pipeName, [process.execPath, 'test/fake-router.ts', '<port>'])
    try {
      const token = await waitForAdminToken(stateDir)
      const client = await connectPipe(pipeName, token)

      const hello = (await client.request('hello', { app: 'test', version: '1.5.0' })) as {
        serviceVersion: string
        protocol: number
      }
      expect(hello).toEqual({ serviceVersion: '1.5.0', protocol: 1 })

      const snap = (await client.request('snapshot')) as Snapshot
      expect(snap.initialized).toBe(true)
      expect(snap.firstRun).toBe(false) // adopted state
      expect(snap.secretStore).toBe('ok')
      expect(snap.settings.port).toBe(port)
      expect(snap.accounts.map((a) => a.alias).sort()).toEqual(['alpha', 'beta'])
      expect(snap.journal.records).toBe(2)
      expect(snap.desktop).toEqual({ startAtLogin: false, minimizeToTray: false, firstRunDoneAtUtc: null })

      // auto-started managed router (adopted state, firstRun false)
      await waitFor(async () => ((await client.request('snapshot')) as Snapshot).router.state === 'running', 10_000)
      const rs = (await client.request('snapshot')) as Snapshot
      expect(rs.router.mode).toBe('managed')
      expect(rs.router.pid).toBeTruthy()

      const add = (await client.request('account.add', { alias: 'gamma', secret: 'sk-gamma' })) as { alias: string }
      expect(add.alias).toBe('gamma')
      await client.request('account.rename', { alias: 'gamma', newAlias: 'delta' })
      await client.request('route.set', { lane: 'go', accountId: 'alpha' })
      const snap2 = (await client.request('snapshot')) as Snapshot
      expect(snap2.routes.go.alias).toBe('alpha')
      expect(snap2.accounts.some((a) => a.alias === 'delta')).toBe(true)
      expect(snap2.accounts.some((a) => a.alias === 'gamma')).toBe(false)

      const jr = (await client.request('journal.recent', { limit: 10 })) as { rows: JournalRowView[]; degraded: boolean }
      expect(jr.degraded).toBe(false)
      expect(jr.rows.length).toBe(2)
      expect(jr.rows[0]!.lane).toBe('zen') // newest first
      expect(jr.rows[1]!.lane).toBe('go')

      // wrong token -> auth error + connection closed
      const bad = createPipeClient(pipeName, 'not-the-admin-token')
      await expect(bad.request('hello', {})).rejects.toMatchObject({ code: 'auth' })
      await expect(bad.request('ping', {})).rejects.toThrow()

      await client.close()
    } finally {
      await stopService(proc)
    }
  })

  test('concurrent mutations from two clients all commit (mutation lock)', async () => {
    const stateDir = freshStateDir()
    const port = await freePort()
    await seedState(stateDir, port, [
      ['alpha', 'sk-alpha'],
      ['beta', 'sk-beta'],
    ])
    const pipeName = uniquePipe('conc')
    const proc = spawnService(stateDir, pipeName, [process.execPath, 'test/fake-router.ts', '<port>'])
    try {
      const token = await waitForAdminToken(stateDir)
      const a = await connectPipe(pipeName, token)
      const b = await connectPipe(pipeName, token)
      const ops: Promise<unknown>[] = []
      for (let i = 1; i <= 5; i++) {
        const n = i
        ops.push(a.request('account.add', { alias: `c${n}`, secret: `sk-c${n}` }))
        ops.push(b.request('route.set', { lane: n % 2 === 0 ? 'zen' : 'go', accountId: n % 2 === 0 ? 'beta' : 'alpha' }))
      }
      const results = await Promise.all(ops)
      expect(results.length).toBe(10)
      const snap = (await a.request('snapshot')) as Snapshot
      const aliases = snap.accounts.map((x) => x.alias)
      for (let i = 1; i <= 5; i++) expect(aliases).toContain(`c${i}`) // no lost update
      expect(snap.routes.go.alias).toBe('alpha')
      expect(snap.routes.zen.alias).toBe('beta')
      await a.close()
      await b.close()
    } finally {
      await stopService(proc)
    }
  })

  test('attaches to an already-running router (no spawn)', async () => {
    const stateDir = freshStateDir()
    const port = await freePort()
    const marker = join(stateDir, 'spawns.log')
    const fake = Bun.spawn([process.execPath, 'test/fake-router.ts', String(port), '--marker', marker], {
      cwd: ROOT,
      stdout: 'ignore',
      stderr: 'ignore',
    })
    try {
      await waitFor(
        async () => {
          try {
            const r = await fetch(`http://127.0.0.1:${port}/healthz`)
            return r.ok
          } catch {
            return false
          }
        },
        10_000,
      )
      await seedState(stateDir, port, [])
      const pipeName = uniquePipe('attach')
      const proc = spawnService(stateDir, pipeName, [process.execPath, 'test/fake-router.ts', '<port>'])
      try {
        const token = await waitForAdminToken(stateDir)
        const client = await connectPipe(pipeName, token)
        await waitFor(async () => ((await client.request('snapshot')) as Snapshot).router.state === 'running', 10_000)
        const snap = (await client.request('snapshot')) as Snapshot
        expect(snap.router.mode).toBe('attached')
        expect(snap.router.pid).toBeNull()
        expect(snap.router.restartCount).toBe(0)
        // no additional spawn: the marker still has exactly the external start
        await sleep(2500)
        expect(markerLines(marker).length).toBe(1)
        await client.close()
      } finally {
        await stopService(proc)
      }
    } finally {
      try {
        fake.kill()
      } catch {
        /* ignore */
      }
    }
  })

  test('port_conflict when the port is busy by a non-router', async () => {
    const stateDir = freshStateDir()
    const port = await freePort()
    const blocker = Bun.serve({ hostname: '127.0.0.1', port, fetch: () => new Response('occupied', { status: 503 }) })
    try {
      await seedState(stateDir, port, [])
      const pipeName = uniquePipe('conflict')
      const proc = spawnService(stateDir, pipeName, [process.execPath, 'test/fake-router.ts', '<port>'])
      try {
        const token = await waitForAdminToken(stateDir)
        const client = await connectPipe(pipeName, token)
        await waitFor(async () => ((await client.request('snapshot')) as Snapshot).router.state === 'port_conflict', 10_000)
        const snap = (await client.request('snapshot')) as Snapshot
        expect(snap.router.mode).toBe('none')
        expect(snap.router.restartCount).toBe(0)
        // stays conflict; never spawns
        await sleep(2500)
        const snap2 = (await client.request('snapshot')) as Snapshot
        expect(snap2.router.state).toBe('port_conflict')
        expect(snap2.router.restartCount).toBe(0)
        await client.close()
      } finally {
        await stopService(proc)
      }
    } finally {
      blocker.stop(true)
    }
  })

  test(
    'crash/backoff: restartCount grows, failed after <=5 restarts, no loop',
    async () => {
      const stateDir = freshStateDir()
      const port = await freePort()
      await seedState(stateDir, port, [])
      const marker = join(stateDir, 'spawns.log')
      const pipeName = uniquePipe('crash')
      const proc = spawnService(stateDir, pipeName, [
        process.execPath,
        'test/fake-router.ts',
        '<port>',
        '--die-after-ms',
        '300',
        '--marker',
        marker,
      ])
      try {
        const token = await waitForAdminToken(stateDir)
        const client = await connectPipe(pipeName, token)
        let snap = (await client.request('snapshot')) as Snapshot
        const deadline = Date.now() + 60_000
        while (Date.now() < deadline) {
          snap = (await client.request('snapshot')) as Snapshot
          if (snap.router.state === 'failed') break
          await sleep(500)
        }
        expect(snap.router.state).toBe('failed')
        expect(snap.router.restartCount).toBeGreaterThanOrEqual(5)
        expect(snap.router.restartCount).toBeLessThanOrEqual(6)
        const lines = markerLines(marker)
        expect(lines.length).toBeGreaterThanOrEqual(6)
        expect(lines.length).toBeLessThanOrEqual(7)
        // service alive and stable: no uncontrolled loop
        expect(proc.exitCode).toBeNull()
        await sleep(3000)
        expect(markerLines(marker).length).toBe(lines.length)
        await client.close()
      } finally {
        await stopService(proc)
      }
    },
  )

  test('CLI route change visible in a pushed snapshot within 3s', async () => {
    const stateDir = freshStateDir()
    const port = await freePort()
    await seedState(stateDir, port, [['alpha', 'sk-alpha']])
    const pipeName = uniquePipe('cohere')
    const proc = spawnService(stateDir, pipeName, [process.execPath, 'test/fake-router.ts', '<port>'])
    try {
      const token = await waitForAdminToken(stateDir)
      const client = await connectPipe(pipeName, token)
      const snap0 = (await client.request('snapshot')) as Snapshot
      expect(snap0.routes.go.alias).toBeNull()

      let seenGo: string | null = null
      client.onEvent((event, data) => {
        if (event === 'snapshot') {
          const s = data as Snapshot
          if (s.routes.go.alias !== null) seenGo = s.routes.go.alias
        }
      })
      await cli(cliEnv(stateDir), ['route', 'go', 'alpha'])
      const t0 = Date.now()
      await waitFor(() => seenGo !== null, 3_000)
      const got = seenGo!
      expect(got).toBe('alpha')
      expect(Date.now() - t0).toBeLessThan(3_000)
      // and a fresh snapshot request agrees
      const snap1 = (await client.request('snapshot')) as Snapshot
      expect(snap1.routes.go.alias).toBe('alpha')
      await client.close()
    } finally {
      await stopService(proc)
    }
  })

  test('control pipe DACL is hardened to SYSTEM + Administrators + current user', () => {
    // SEC-01 regression: node:net's default named-pipe DACL grants read to
    // Everyone/Anonymous; hardening must remove those ACEs and keep the
    // owner's full access.
    const pipe = `\\\\.\\pipe\\gorouter-acl-test-${randomUUID()}`
    const server = net.createServer(() => {})
    return new Promise<void>((resolve, reject) => {
      server.listen(pipe, () => {
        try {
          const hard = hardenPipeDacl(pipe)
          expect(hard.ok, hard.error ?? 'harden failed').toBe(true)
          const after = inspectPipeDacl(pipe)
          expect(after.ok, after.error ?? 'inspect failed').toBe(true)
          expect(after.sddl).not.toMatch(/;FR;;;WD\)|;FR;;;AN\)/)
          expect(after.sddl).toMatch(/;FA;;;S-1-5-/) // current user full access retained
          resolve()
        } catch (e) {
          reject(e)
        } finally {
          server.close()
        }
      })
    })
  })
})
