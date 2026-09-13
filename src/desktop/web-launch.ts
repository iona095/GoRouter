/**
 * GoRouter W1 — native Web Control launch paths (C05 frozen launch matrix).
 *
 * WARM: an already-authenticated native control client calls web.open over the
 * protocol-v2 pipe (hello + admin token gate stays in the transport); the
 * service binds the loopback listener, mints the fragment bootstrap, and opens
 * the OS default browser itself. The raw URL never crosses the pipe.
 *
 * COLD: a dedicated entrypoint that works with no running service/router. It
 * proves W1 capability BEFORE launching anything provider-capable (fail-closed
 * against pre-W1 binaries that would ignore a web-safe flag), then starts the
 * control service with the process-lifetime webSafe latch: no router child, no
 * health/provider/account/model work, no external network for the open.
 */
import { resolvePaths, ensureStateDirs } from '../paths.ts'
import { createSecretStore } from '../secret-store.ts'
import { createDomain } from '../domain.ts'
import { log } from '../util.ts'
import { ensureAdminToken } from './admin-token.ts'
import { loadDesktopSettings } from './desktop-settings.ts'
import { createControlService } from './control-core.ts'
import { hardenPipeDacl } from './pipe-acl.ts'
import { serveControlPipe, type ControlTransport } from './transport.ts'
import { defaultRouterCommand, isPackagedControl, type RouterCommand } from './supervisor.ts'
import { attachWebBridge, createOpHandlers, resolvePipeName, resolveRouterCommand } from './control-service.ts'
import { createWebBridge } from './web-bridge.ts'
import { WEB_BRIDGE_CAPABLE } from './protocol.ts'

/** Pre-launch W1 capability identity (contract §5.8). */
export function webControlCapable(): boolean {
  return WEB_BRIDGE_CAPABLE === true && typeof createWebBridge === 'function' && typeof attachWebBridge === 'function'
}

export interface WarmOpenDeps {
  /** Authenticated pipe request (hello already completed by the caller). */
  request: <T = unknown>(op: string, params?: Record<string, unknown>) => Promise<T>
}

/**
 * Warm user-facing launch from the authenticated desktop shell/control client.
 * Requires native control authority (the caller's hello); changes nothing else:
 * no restart, no credential rotation, no route/account/setting change, no
 * probe/refresh, no router state change (the service only binds/listens).
 */
export async function openWarmWebControl(deps: WarmOpenDeps): Promise<{ opened: boolean }> {
  const res = await deps.request<{ opened?: unknown }>('web.open')
  if (!res || res.opened !== true) throw new Error('web control open was not acknowledged')
  return { opened: true }
}

export interface ColdWebControlOpts {
  browserOpener: (url: string) => void
  stateDir?: string
  pipeName?: string
  routerCmd?: RouterCommand
  /** Test seam: false simulates a pre-W1/unsupported control binary. */
  capable?: boolean
  onReady?: (info: { origin: string }) => void
}

export interface ColdWebControlHandle {
  origin: string
  scopePath: string
  routerSnapshot: () => { state: string; pid: number | null }
  close: () => Promise<void>
}

/**
 * Cold user-facing launch: start the dependency service in web-safe mode and
 * open Web Control. Dedicated W1 entrypoint (never an unknown-flag gamble): a
 * pre-W1 binary cannot reach here — capability is proven first and failure is
 * closed before any provider-capable service process is launched.
 */
export async function startColdWebControl(opts: ColdWebControlOpts): Promise<ColdWebControlHandle> {
  if (opts.capable === false || !webControlCapable()) {
    throw new Error('web control is not supported by this control binary (fail-closed cold launch)')
  }
  const paths = opts.stateDir ? resolvePaths(opts.stateDir) : resolvePaths()
  ensureStateDirs(paths)
  const secrets = createSecretStore(paths.secretsDir)
  const domain = createDomain(paths, secrets)
  const token = ensureAdminToken(paths, secrets)
  const pipeName = opts.pipeName ?? resolvePipeName()
  const routerCmd = opts.routerCmd ?? resolveRouterCommand()
  const desktopSettings = loadDesktopSettings(paths.state)
  // W1 web-safe: startup caused solely by Web Control never auto-starts the
  // router/model/provider work. Normal desktop startup omits this flag.
  const core = createControlService({ paths, secrets, domain, pipeName, routerCmd, desktop: desktopSettings, webSafe: true })
  const web = attachWebBridge(core, domain, opts.browserOpener)
  const handlers = createOpHandlers({ core, domain, openWeb: web.openWeb })
  let transport: ControlTransport | null = null
  const onExit = (): void => {
    void (async (): Promise<void> => {
      await web.closeWeb()
      await core.stop(true)
      await transport?.close()
    })()
  }
  process.on('SIGTERM', onExit)
  process.on('SIGINT', onExit)
  try {
    const t = serveControlPipe(pipeName, token, handlers)
    transport = t
    await t.listening
  } catch (e) {
    process.removeListener('SIGTERM', onExit)
    process.removeListener('SIGINT', onExit)
    throw new Error('cold web control pipe bind failed: ' + (e instanceof Error ? e.message : String(e)))
  }
  const acl = hardenPipeDacl(pipeName)
  if (!acl.ok) log.warn('cold web control pipe DACL hardening failed (continuing with token auth)')
  core.start()
  // The service opens the browser itself via the injected opener (the raw
  // fragment URL is never returned here, logged, or persisted); routing
  // coordinates come from the attachment description (no capabilities).
  try {
    const opened = await web.openWeb()
    if (!opened.opened) throw new Error('web control open was not acknowledged')
  } catch (e) {
    await web.closeWeb()
    await core.stop(true)
    await transport.close()
    process.removeListener('SIGTERM', onExit)
    process.removeListener('SIGINT', onExit)
    throw e
  }
  const described = web.describe()
  const origin = described.origin ?? ''
  const scopePath = described.scopePath ?? ''
  if (!origin || !scopePath) {
    await web.closeWeb()
    await core.stop(true)
    await transport.close()
    process.removeListener('SIGTERM', onExit)
    process.removeListener('SIGINT', onExit)
    throw new Error('cold web control listener did not report routing coordinates')
  }
  opts.onReady?.({ origin })
  return {
    origin,
    scopePath,
    routerSnapshot: () => {
      const s = core.router.snapshot()
      return { state: s.state, pid: s.pid }
    },
    close: async (): Promise<void> => {
      process.removeListener('SIGTERM', onExit)
      process.removeListener('SIGINT', onExit)
      await web.closeWeb()
      await core.stop(true)
      await transport.close()
    },
  }
}
