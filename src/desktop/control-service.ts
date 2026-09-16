/**
 * GoRouter V1.5 — desktop control service entry.
 *
 * Spawned by the shell: dev mode [bun, src/desktop/control-service.ts]
 * (cwd = repo root), packaged as gorouter-control.exe. Owns the admin token,
 * desktop settings, router supervision, the named-pipe control API, and the
 * op dispatch (protocol per local://v15-protocol.md).
 *
 * Env contract (cross-slice, implemented exactly):
 *   GOROUTER_DESKTOP_PIPE           full pipe path override (default
 *                                   \\.\pipe\gorouter-ctrl-<userSID, dashes stripped>)
 *   GOROUTER_DESKTOP_ROUTER_CMD_JSON  JSON array of router argv ("<port>"
 *                                   entry replaced with the configured port;
 *                                   honored in DEV only, ignored packaged)
 *   GOROUTER_STATE_DIR              runtime state dir (src/paths.ts)
 *   GOROUTER_LOG_LEVEL              debug|info|warn|error
 *
 * Request params, secrets and the admin token are NEVER logged.
 */
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { resolvePaths, ensureStateDirs } from '../paths.ts'
import { createSecretStore } from '../secret-store.ts'
import { createDomain } from '../domain.ts'
import { log, redact } from '../util.ts'
import { ensureAdminToken } from './admin-token.ts'
import { loadDesktopSettings } from './desktop-settings.ts'
import { createControlService, type ControlService } from './control-core.ts'
import { hardenPipeDacl } from './pipe-acl.ts'
import { serveControlPipe, type ControlTransport } from './transport.ts'
import { createWebBridge, openInDefaultBrowser } from './web-bridge.ts'
import { defaultRouterCommand, isPackagedControl, type RouterCommand } from './supervisor.ts'
import {
  controlError,
  ControlError,
  PROTOCOL_VERSION,
  SERVICE_VERSION,
  type ErrorCode,
} from './protocol.ts'
import type { Domain } from '../domain.ts'
import { isDomainConflict } from '../domain.ts'

function repoRoot(): string {
  return resolve(import.meta.dir, '../..')
}

/** Default pipe name: \\.\pipe\gorouter-ctrl-<userSID> with dashes stripped. */
export function resolvePipeName(): string {
  const override = process.env.GOROUTER_DESKTOP_PIPE
  if (override && override.trim().length > 0) return override.trim()
  return `\\\\.\\pipe\\gorouter-ctrl-${currentUserSid()}`
}

function currentUserSid(): string {
  try {
    const r = spawnSync('whoami', ['/user'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 })
    const m = /S-\d+(?:-\d+)+/.exec(r.stdout ?? '')
    if (m) return m[0].replace(/-/g, '')
  } catch {
    /* fall through */
  }
  return (process.env.USERNAME ?? 'default').replace(/[^A-Za-z0-9]/g, '')
}

/**
 * Router command: GOROUTER_DESKTOP_ROUTER_CMD_JSON wins in DEV only. A
 * packaged control binary (F-01) ignores the override and uses the fixed
 * bundled router: env-controlled argv in a shipped shell is an arbitrary-
 * spawn primitive for anything that can set the service environment.
 */
export function resolveRouterCommand(opts: { packaged?: boolean } = {}): RouterCommand {
  const raw = process.env.GOROUTER_DESKTOP_ROUTER_CMD_JSON
  if (raw && raw.trim().length > 0) {
    if (opts.packaged ?? isPackagedControl()) {
      log.warn('ignoring GOROUTER_DESKTOP_ROUTER_CMD_JSON in packaged mode (fixed bundled router)')
      return defaultRouterCommand()
    }
    let argv: unknown
    try {
      argv = JSON.parse(raw)
    } catch {
      throw new Error('GOROUTER_DESKTOP_ROUTER_CMD_JSON is not valid JSON')
    }
    if (!Array.isArray(argv) || argv.length === 0 || !argv.every((a) => typeof a === 'string')) {
      throw new Error('GOROUTER_DESKTOP_ROUTER_CMD_JSON must be a JSON array of strings')
    }
    return { argv: argv as string[], cwd: repoRoot() }
  }
  return defaultRouterCommand()
}

/** Domain Error -> wire error mapping (W0: DomainConflict maps by stable reason). */
export function mapDomainError(e: unknown): { code: ErrorCode; message: string; reason?: string } {
  if (e instanceof ControlError) {
    const out: { code: ErrorCode; message: string; reason?: string } = { code: e.code, message: e.message };
    if (e.reason !== undefined) out.reason = e.reason;
    return out;
  }
  if (isDomainConflict(e)) {
    const conflictCode: ErrorCode = e.reason === 'not_found' ? 'not_found' : 'conflict';
    return { code: conflictCode, message: e.message, reason: e.reason };
  }
  const message = e instanceof Error ? e.message : String(e)
  if (/already exists|duplicate/i.test(message)) return { code: 'conflict', message }
  if (/lock timeout/i.test(message)) return { code: 'conflict', message }
  if (/not found/i.test(message)) return { code: 'not_found', message }
  return { code: 'validation', message }
}

function requireLane(params: Record<string, unknown>): 'go' | 'zen' {
  if (params.lane !== 'go' && params.lane !== 'zen') {
    throw controlError('validation', "lane must be 'go' or 'zen'")
  }
  return params.lane
}

function requireExpectedVersion(params: Record<string, unknown>, key: string): number {
  const v = params[key]
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 1) {
    throw controlError('validation', `${key} is required (positive safe integer)`)
  }
  return v
}

function requireExpectedGeneration(params: Record<string, unknown>): string {
  const v = params.expectedStateGeneration
  if (typeof v !== 'string' || v.length === 0) {
    throw controlError('validation', 'expectedStateGeneration is required')
  }
  return v
}

function requireString(params: Record<string, unknown>, key: string): string {
  const v = params[key]
  if (typeof v !== 'string' || v.length === 0) throw controlError('validation', `${key} is required`)
  return v
}

/** Scrub an account for the wire (no secretRef; W0 adds version). */
function accountData(a: {
  id: string
  alias: string
  secretPresent: boolean
  usedBy: string[]
  createdAtUtc: string
  updatedAtUtc: string
  version: number
}): {
  id: string
  alias: string
  secretPresent: boolean
  usedBy: string[]
  createdAtUtc: string
  updatedAtUtc: string
  version: number
} {
  return {
    id: a.id,
    alias: a.alias,
    secretPresent: a.secretPresent,
    usedBy: a.usedBy,
    createdAtUtc: a.createdAtUtc,
    updatedAtUtc: a.updatedAtUtc,
    version: a.version,
  }
}

export interface OpHandlerDeps {
  core: ControlService
  domain: Domain
  /** Called by app.exit (stopRouter flag); the entry owns shutdown. */
  onAppExit?: (stopRouter: boolean) => void
  /** W1 trusted native Web Control activation. Absent on pre-W1 services, where
   * web.open stays an unknown op (warm launchers report unsupported). */
  openWeb?: () => Promise<{ opened: boolean }>
}

export function createOpHandlers(deps: OpHandlerDeps): (op: string, params: Record<string, unknown>) => Promise<unknown> {
  const { core, domain } = deps

  /** Coherence helper: notify exactly when a committed mutation changed state. */
  function notifyIfChanged(commit: { changed: boolean }): void {
    if (commit.changed) core.noteChange()
  }

  async function raw(op: string, params: Record<string, unknown>): Promise<unknown> {
    switch (op) {
      case 'hello': {
        // W0 version gate (contract 6.4): missing/mismatched protocol is
        // unsupported BEFORE any capability (snapshot, mutation, journal,
        // config, router) or event subscription is granted.
        if (params.protocol !== PROTOCOL_VERSION) {
          throw controlError(
            'unsupported',
            `unsupported control protocol (service speaks protocol ${PROTOCOL_VERSION})`,
          )
        }
        return { serviceVersion: SERVICE_VERSION, protocol: PROTOCOL_VERSION }
      }

      case 'snapshot':
        return core.snapshot()

      case 'route.set': {
        // W0: reviewed generation + immutable ID + both expected versions.
        const lane = requireLane(params)
        const accountId = requireString(params, 'accountId')
        const commit = domain.routeSetChecked(lane, accountId, {
          expectedStateGeneration: requireExpectedGeneration(params),
          expectedRouteVersion: requireExpectedVersion(params, 'expectedRouteVersion'),
          expectedTargetAccountVersion: requireExpectedVersion(params, 'expectedTargetAccountVersion'),
        })
        notifyIfChanged(commit)
        return commit
      }

      case 'route.clear': {
        const lane = requireLane(params)
        const commit = domain.routeClearChecked(lane, {
          expectedStateGeneration: requireExpectedGeneration(params),
          expectedRouteVersion: requireExpectedVersion(params, 'expectedRouteVersion'),
        })
        notifyIfChanged(commit)
        return commit
      }

      case 'account.add': {
        // W0: reviewed generation gates the add (contract 7.6).
        const alias = requireString(params, 'alias')
        const secret = requireString(params, 'secret')
        const r = domain.accountAddChecked(alias, secret, {
          expectedStateGeneration: requireExpectedGeneration(params),
        })
        notifyIfChanged(r)
        return accountData(r.account)
      }

      case 'account.update': {
        // W0: immutable ID + reviewed generation/version.
        const accountId = requireString(params, 'accountId')
        const secret = requireString(params, 'secret')
        const r = domain.accountUpdateChecked(accountId, secret, {
          expectedStateGeneration: requireExpectedGeneration(params),
          expectedAccountVersion: requireExpectedVersion(params, 'expectedAccountVersion'),
        })
        notifyIfChanged(r)
        return accountData(r.account)
      }

      case 'account.rename': {
        const accountId = requireString(params, 'accountId')
        const newAlias = requireString(params, 'newAlias')
        const r = domain.accountRenameChecked(accountId, newAlias, {
          expectedStateGeneration: requireExpectedGeneration(params),
          expectedAccountVersion: requireExpectedVersion(params, 'expectedAccountVersion'),
        })
        notifyIfChanged(r)
        return { ...accountData(r.account), previousAlias: r.previousAlias, changed: r.changed }
      }

      case 'account.remove': {
        const accountId = requireString(params, 'accountId')
        const force = params.force === true
        const r = domain.accountRemoveChecked(accountId, force, {
          expectedStateGeneration: requireExpectedGeneration(params),
          expectedAccountVersion: requireExpectedVersion(params, 'expectedAccountVersion'),
        })
        notifyIfChanged(r)
        return {
          removedAccountId: r.removedAccountId,
          removedAccountVersion: r.removedAccountVersion,
          clearedLanes: r.clearedLanes,
          secretDeleted: r.secretDeleted,
        }
      }

      case 'account.test': {
        const alias = requireString(params, 'alias')
        const rawLane = params.lane
        let lanes: ('go' | 'zen')[]
        if (rawLane === null || rawLane === undefined) {
          lanes = ['go', 'zen']
        } else if (rawLane === 'go' || rawLane === 'zen') {
          lanes = [rawLane]
        } else {
          throw controlError('validation', "lane must be 'go', 'zen' or null")
        }
        // Defense in depth: probe results carry provider-controlled error
        // text; redact at the wire boundary (a hostile upstream could echo a
        // credential in an error body) — SEC-01
        const results = await domain.accountTest(alias, lanes)
        return results.map((r) => ({
          ...r,
          errorMessageBrief: r.errorMessageBrief !== null ? redact(r.errorMessageBrief) : null,
          errorType: r.errorType !== null ? redact(r.errorType) : null,
          workspaceHint: r.workspaceHint !== null ? redact(r.workspaceHint) : null,
        }))
      }

      case 'journal.recent': {
        const raw = params.limit
        const limit = typeof raw === 'number' && Number.isFinite(raw) ? raw : 100
        return core.journalRecent(limit)
      }

      case 'journal.stats':
        return core.journalStats()

      case 'config.set': {
        const key = requireString(params, 'key')
        const value = requireString(params, 'value')
        const ALLOWED = new Set(['port', 'journalRetentionDays', 'journalMaxRecords'])
        if (!ALLOWED.has(key)) {
          throw controlError(
            'unsupported',
            `setting '${key}' is not exposed in the desktop control UI (host/upstreams are CLI-only)`,
          )
        }
        if (key === 'port') {
          const r = core.router.snapshot()
          if (['attached', 'managed', 'starting', 'degraded'].includes(r.state)) {
            throw controlError(
              'conflict',
              'changing the router port while a router is running is refused; stop the router first',
            )
          }
        }
        domain.configSet(key, value)
        core.noteChange()
        return domain.configShow()
      }

      case 'desktop.set': {
        const partial: { startAtLogin?: boolean; minimizeToTray?: boolean; firstRunDone?: boolean; theme?: 'light' | 'dark' } = {}
        if ('startAtLogin' in params) {
          if (typeof params.startAtLogin !== 'boolean') throw controlError('validation', 'startAtLogin must be a boolean')
          partial.startAtLogin = params.startAtLogin
        }
        if ('minimizeToTray' in params) {
          if (typeof params.minimizeToTray !== 'boolean') {
            throw controlError('validation', 'minimizeToTray must be a boolean')
          }
          partial.minimizeToTray = params.minimizeToTray
        }
        if ('firstRunDone' in params) {
          if (typeof params.firstRunDone !== 'boolean') throw controlError('validation', 'firstRunDone must be a boolean')
          partial.firstRunDone = params.firstRunDone
        }
        if ('theme' in params) {
          if (params.theme !== 'light' && params.theme !== 'dark') throw controlError('validation', 'theme must be light or dark')
          partial.theme = params.theme
        }
        if (Object.keys(partial).length === 0) throw controlError('validation', 'no desktop settings provided')
        return core.setDesktop(partial)
      }

      case 'router.start': {
        // `failed` (backoff exhausted) needs a full restart to recover; a
        // plain start() would be a no-op there (PS-01)
        const current = core.routerView()
        if (current.state === 'failed') await core.router.restart()
        else core.router.start()
        return core.routerView()
      }

      case 'router.stop': {
        const r = core.router.snapshot()
        if (r.state === 'attached') {
          throw controlError(
            'external',
            'the router on this port was not started by the desktop; stop the router process yourself',
          )
        }
        await core.router.stop()
        return core.routerView()
      }

      case 'router.restart': {
        const r = core.router.snapshot()
        if (r.state === 'attached') {
          throw controlError(
            'external',
            'the router on this port was not started by the desktop; stop the router process yourself',
          )
        }
        await core.router.stop()
        core.router.start()
        return core.routerView()
      }

      case 'localCred.once': {
        const credential = core.localCredOnce()
        if (credential === null) {
          throw controlError('unavailable', 'local credential is not available for first-run display')
        }
        return { credential }
      }

      case 'app.exit': {
        const stopRouter = params.stopRouter !== false
        await core.stop(stopRouter)
        deps.onAppExit?.(stopRouter)
        return { exiting: true }
      }

      case 'web.open': {
        // W1: trusted native activation only. The transport already gates every
        // non-hello op on a successfully completed hello + the admin token, so
        // reaching here proves native control authority. The service itself
        // opens the OS default browser: the raw fragment bootstrap never
        // crosses the pipe (the response carries only an opened flag, never
        // the URL/capability) and the launcher holds nothing to leak.
        if (!deps.openWeb) {
          throw controlError('unsupported', 'web control is not available from this service')
        }
        return deps.openWeb()
      }

      case 'ping':
        return { pong: true }

      default:
        throw controlError('validation', `unknown op '${op}'`)
    }
  }

  // Map plain domain Errors to wire codes; ControlErrors pass through.
  return async (op: string, params: Record<string, unknown>): Promise<unknown> => {
    try {
      return await raw(op, params)
    } catch (e) {
      if (e instanceof ControlError) throw e
      const mapped = mapDomainError(e)
      throw controlError(mapped.code, mapped.message, mapped.reason)
    }
  }
}

/**
 * W1 web attachment shared by the normal service entry and the dedicated cold
 * Web Control entrypoint (web-launch.ts). The bridge is created on first
 * web.open (explicit activation only) and reuses the authoritative core/domain.
 */
export interface WebAttachment {
  openWeb: () => Promise<{ opened: boolean }>
  closeWeb: () => Promise<void>
  /** Routing coordinates only (origin/scope/cookie name; never capabilities). */
  describe: () => { origin: string | null; scopePath: string | null; cookieName: string | null }
}

export function attachWebBridge(core: ControlService, domain: Domain, openBrowser: (url: string) => void): WebAttachment {
  const bridge = createWebBridge({ getSnapshot: () => core.snapshot(), domain, openBrowser })
  return {
    openWeb: async (): Promise<{ opened: boolean }> => {
      await bridge.open()
      return { opened: true }
    },
    closeWeb: (): Promise<void> => bridge.close(),
    describe: () => ({ origin: bridge.origin, scopePath: bridge.scopePath, cookieName: bridge.cookieName }),
  }
}

// ---------------------------------------------------------------------------
// Process entry
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const paths = resolvePaths()
  ensureStateDirs(paths)
  const secrets = createSecretStore(paths.secretsDir)
  const domain = createDomain(paths, secrets)
  const token = ensureAdminToken(paths, secrets)
  const pipeName = resolvePipeName()
  const routerCmd = resolveRouterCommand()
  const desktopSettings = loadDesktopSettings(paths.state)

  const core = createControlService({ paths, secrets, domain, pipeName, routerCmd, desktop: desktopSettings })
  // W1: the web bridge binds only via web.open (explicit native activation).
  const web = attachWebBridge(core, domain, openInDefaultBrowser)

  // Bind the pipe BEFORE starting supervision: a losing duplicate instance
  // (EADDRINUSE) exits here without ever spawning a router child (INV-01).
  let transport: ControlTransport
  const handlers = createOpHandlers({
    core,
    domain,
    openWeb: web.openWeb,
    onAppExit: () => {
      // the handler already stopped the managed child (core.stop); here we
      // only sequence the process exit so the response flushes first.
      // W1: web authority is invalidated before the pipe goes down.
      setTimeout(() => {
        void web.closeWeb().finally(() => transport.close()).then(() => process.exit(0))
      }, 150)
    },
  })

  transport = serveControlPipe(
    pipeName,
    token,
    handlers,
    () => {
      transport.push('snapshot', core.snapshot()) // initial snapshot after hello
    },
    (err) => {
      if ((err as { code?: string }).code === 'EADDRINUSE') {
        // F-01: exit 3 (distinct from generic failure) with a squat marker:
        // the name may be held by another instance — or by a rogue process
        // squatting the pipe. The shell treats 3 as "do not trust the pipe".
        console.error('control pipe bind failed (pipe in use, exit 3): if no other service is running, a rogue process may be squatting the pipe name')
        process.exit(3)
      }
    },
  )

  try {
    await transport.listening
  } catch (err) {
    // bind failed (pipe in use or otherwise): never started supervision, so
    // no child exists to orphan — exit cleanly with the F-01 bind code (3)
    console.error(`control pipe bind failed (exit 3): ${err instanceof Error ? err.message : String(err)}`)
    process.exit(3)
  }

  // SEC-01: node:net's default pipe DACL grants read to Everyone/Anonymous;
  // lock it to SYSTEM + Administrators + current user. Non-fatal on failure
  // (token auth remains the primary boundary).
  const acl = hardenPipeDacl(pipeName)
  if (!acl.ok) {
    log.warn(`control pipe DACL hardening failed (continuing with token auth): ${acl.error ?? 'unknown error'}`)
  } else if (acl.sddl) {
    log.info(`control pipe DACL hardened: ${acl.sddl}`)
  }

  core.start()
  core.onSnapshot((snap) => transport.push('snapshot', snap))

  let stopping = false
  const shutdown = (): void => {
    if (stopping) return
    stopping = true
    // GR-012: await the async SIGTERM grace so the managed child is reaped
    // before the service exits (the job object remains the final backstop).
    // W1: shutdown first stops serving Web Control and invalidates all
    // bootstrap/session/CSRF authority, then releases listener resources.
    void (async () => {
      await web.closeWeb()
      await core.stop(true)
      await transport.close()
      process.exit(0)
    })()
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)

  // The service is long-running; a runtime-level async fault must not take
  // the control plane (and the supervised router) down with it.
  process.on('unhandledRejection', (reason) => {
    log.error(`unhandled rejection (control service continues): ${reason instanceof Error ? reason.message : String(reason)}`)
  })
  process.on('uncaughtException', (err) => {
    log.error(`uncaught exception (control service continues): ${err.message}`)
  })

  log.info(`control service listening on ${pipeName} (state dir: ${paths.state})`)
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(`control service failed to start: ${e instanceof Error ? e.message : String(e)}`)
    process.exit(1)
  })
}
