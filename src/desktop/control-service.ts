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
import { defaultRouterCommand, isPackagedControl, type RouterCommand } from './supervisor.ts'
import {
  controlError,
  ControlError,
  PROTOCOL_VERSION,
  SERVICE_VERSION,
  type ErrorCode,
} from './protocol.ts'
import type { Domain } from '../domain.ts'

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

/** Domain Error -> wire error mapping (duplicate -> conflict, not found -> not_found, else validation). */
export function mapDomainError(e: unknown): { code: ErrorCode; message: string } {
  if (e instanceof ControlError) return { code: e.code, message: e.message }
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

function requireString(params: Record<string, unknown>, key: string): string {
  const v = params[key]
  if (typeof v !== 'string' || v.length === 0) throw controlError('validation', `${key} is required`)
  return v
}

/** Scrub an AccountView for the wire (no secretRef). */
function accountData(a: {
  id: string
  alias: string
  secretPresent: boolean
  usedBy: string[]
  createdAtUtc: string
  updatedAtUtc: string
}): {
  id: string
  alias: string
  secretPresent: boolean
  usedBy: string[]
  createdAtUtc: string
  updatedAtUtc: string
} {
  return {
    id: a.id,
    alias: a.alias,
    secretPresent: a.secretPresent,
    usedBy: a.usedBy,
    createdAtUtc: a.createdAtUtc,
    updatedAtUtc: a.updatedAtUtc,
  }
}

export interface OpHandlerDeps {
  core: ControlService
  domain: Domain
  /** Called by app.exit (stopRouter flag); the entry owns shutdown. */
  onAppExit?: (stopRouter: boolean) => void
}

export function createOpHandlers(deps: OpHandlerDeps): (op: string, params: Record<string, unknown>) => Promise<unknown> {
  const { core, domain } = deps

  async function raw(op: string, params: Record<string, unknown>): Promise<unknown> {
    switch (op) {
      case 'hello':
        return { serviceVersion: SERVICE_VERSION, protocol: PROTOCOL_VERSION }

      case 'snapshot':
        return core.snapshot()

      case 'route.set': {
        const lane = requireLane(params)
        const accountId = requireString(params, 'accountId')
        return domain.routeSet(lane, accountId)
      }

      case 'route.clear': {
        const lane = requireLane(params)
        domain.routeClear(lane)
        return { lane }
      }

      case 'account.add': {
        const alias = requireString(params, 'alias')
        const secret = requireString(params, 'secret')
        return accountData(domain.accountAdd(alias, secret))
      }

      case 'account.update': {
        const alias = requireString(params, 'alias')
        const secret = requireString(params, 'secret')
        return accountData(domain.accountUpdate(alias, secret))
      }

      case 'account.rename': {
        const alias = requireString(params, 'alias')
        const newAlias = requireString(params, 'newAlias')
        const { renamed, previousAlias } = domain.accountRename(alias, newAlias)
        return { ...accountData(renamed), previousAlias }
      }

      case 'account.remove': {
        const alias = requireString(params, 'alias')
        const force = params.force === true
        const { removed, clearedLanes } = domain.accountRemove(alias, force)
        return { removed: accountData(removed), clearedLanes }
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
        if (current.state === 'failed') core.router.restart()
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
        core.router.stop()
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
        core.router.stop()
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
        core.stop(stopRouter)
        deps.onAppExit?.(stopRouter)
        return { exiting: true }
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
      throw controlError(mapped.code, mapped.message)
    }
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

  // Bind the pipe BEFORE starting supervision: a losing duplicate instance
  // (EADDRINUSE) exits here without ever spawning a router child (INV-01).
  let transport: ControlTransport
  const handlers = createOpHandlers({
    core,
    domain,
    onAppExit: () => {
      // the handler already stopped the managed child (core.stop); here we
      // only sequence the process exit so the response flushes first
      setTimeout(() => {
        void transport.close().then(() => process.exit(0))
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
        console.error('control service is already running (pipe in use); exiting')
        process.exit(1)
      }
    },
  )

  try {
    await transport.listening
  } catch (err) {
    // bind failed (pipe in use or otherwise): never started supervision, so
    // no child exists to orphan — exit cleanly
    console.error(`control pipe bind failed: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
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
    core.stop(true)
    void transport.close().then(() => process.exit(0))
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
