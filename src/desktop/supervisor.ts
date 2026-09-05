/**
 * GoRouter V1.5 — router supervisor (contract §13).
 *
 * Owns the router lifecycle: probe GET http://127.0.0.1:<port>/healthz every
 * 2s (ours iff JSON status "ok" with a non-empty version field), attach to
 * an external healthy router (never stop it), else spawn and supervise the
 * managed child with bounded restart backoff 1s,2s,4s,8s,16s then `failed`
 * (no uncontrolled loop). stopManaged/stop kill only the child we spawned;
 * attached external routers are never killed.
 *
 * States: attached | managed | stopped | starting | degraded | port_conflict
 * | failed. `mode` for the wire: attached | managed | none.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import net from 'node:net'
import { existsSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { log as defaultLog, type Logger } from '../util.ts'
import { ROUTER_CHALLENGE_HEADER, newRouterChallenge, verifyRouterProof } from '../router-proof.ts'

export type RouterState = 'attached' | 'managed' | 'stopped' | 'starting' | 'degraded' | 'port_conflict' | 'failed'
export type RouterMode = 'attached' | 'managed' | 'none'

export interface RouterSnapshot {
  state: RouterState
  mode: RouterMode
  pid: number | null
  port: number
  restartCount: number
}

export interface RouterCommand {
  argv: string[]
  cwd: string
}

export interface RouterSupervisorOptions {
  /** Current configured router port (re-read per probe; config.set while stopped takes effect next probe). */
  port: () => number
  /** Local client credential for the GR-005 challenge proof (read per probe
   * so rotation takes effect immediately; null while unconfigured fails
   * closed to port_conflict, never attach). */
  localCredential?: () => string | null
  /** Router command; an exact "<port>" argv entry is replaced with the configured port. */
  routerCmd: () => RouterCommand
  /** Runtime state dir, passed to the child as GOROUTER_STATE_DIR. */
  stateDir: string
  probeIntervalMs?: number
  /** Restart backoff sequence; default [1000,2000,4000,8000,16000]. Tests may shrink it. */
  backoffMs?: number[]
  log?: Logger
  onStateChange?: (snap: RouterSnapshot) => void
}

export interface RouterSupervisor {
  /** Request the router to run: attach if healthy, else spawn. Idempotent. */
  start(): void
  /**
   * GR-012: stop supervision and kill the managed child (router.stop op).
   * Asynchronous: state transitions synchronously, but the SIGTERM grace
   * never blocks the event loop — await it for a deterministicResult.
   */
  stop(): Promise<void>
  /** Stop then start (manual restart; also recovers from `failed`). */
  restart(): Promise<void>
  snapshot(): RouterSnapshot
  /** Teardown. stopChild=false intends to leave a managed child running
   * (app.exit stopRouter:false); on Windows the Bun job object
   * (KILL_ON_JOB_CLOSE) terminates it with the service regardless — the
   * next service start respawns it. */
  close(stopChild: boolean): Promise<void>
}

const DEFAULT_BACKOFF_MS = [1000, 2000, 4000, 8000, 16000]
const DEFAULT_PROBE_INTERVAL_MS = 2_000
const PROBE_TIMEOUT_MS = 1_500
/** A managed child that never becomes healthy within this window is recycled
 * (e.g. the CLI changed settings.port underneath it — the child still serves
 * the old port while the supervisor probes the new one). */
export const CHILD_HEALTH_GRACE_MS = 10_000
/**
 * GR-012: SIGTERM grace for managed-router teardown — bounded and
 * asynchronous. The event loop stays alive during the wait so the child's
 * exit event is observed promptly (the old Bun.sleepSync poll blocked pipe
 * operations for the full grace on every stop).
 */
export const CHILD_STOP_GRACE_MS = 2_000

/**
 * GR-012 test seam (also the primitive behind the async SIGTERM grace).
 * Resolve when the child exits, or when the grace expires — never rejects,
 * never blocks the loop.
 */
export function waitForChildExit(c: ChildProcess, ms: number): Promise<void> {
  return new Promise((resolve) => {
    // Loose null checks: node ChildProcess reports null while running;
    // Bun.Subprocess leaves signalCode undefined (never null).
    if (c.exitCode != null || c.signalCode != null) {
      resolve()
      return
    }
    const t = setTimeout(() => {
      c.off('exit', onExit)
      resolve()
    }, ms)
    const onExit = (): void => {
      clearTimeout(t)
      resolve()
    }
    c.once('exit', onExit)
  })
}

/**
 * F-03: pure recycle decision (test seam). A startup grace measured as
 * age-since-birth degenerates into kill-on-first-failed-probe for any child
 * older than the grace, so recycling requires EITHER sustained unhealthiness
 * (never-healthy startup past the grace) OR repeated consecutive failures on
 * a mature child — mirroring the healthyStreak >= 2 reset hysteresis.
 */
export function shouldRecycleChild(args: {
  nowMs: number
  childBornAtMs: number
  unhealthySinceMs: number
  consecutiveFailures: number
}): boolean {
  const age = args.childBornAtMs > 0 ? args.nowMs - args.childBornAtMs : 0
  const unhealthyFor = args.unhealthySinceMs > 0 ? args.nowMs - args.unhealthySinceMs : 0
  if (unhealthyFor > CHILD_HEALTH_GRACE_MS) return true
  if (age > CHILD_HEALTH_GRACE_MS && args.consecutiveFailures >= 2) return true
  return false
}

/** True when running as the packaged control binary (vs dev bun). The
 * router-spawn env override is honored in dev only (F-01). */
export function isPackagedControl(): boolean {
  return basename(process.execPath).toLowerCase() === 'gorouter-control.exe'
}

/** Dev default: [bun, src/cli.ts, serve] from the repo root. Packaged: [<exeDir>/gorouter-router.exe, serve]. */
export function defaultRouterCommand(): RouterCommand {
  if (isPackagedControl()) {
    const dir = dirname(process.execPath)
    return { argv: [join(dir, 'gorouter-router.exe'), 'serve'], cwd: dir }
  }
  return { argv: ['bun', 'src/cli.ts', 'serve'], cwd: resolve(import.meta.dir, '../..') }
}

/**
 * Resolve a real bun.exe. On some hosts `bun` on PATH is a bun.cmd shim that
 * wraps cmd.exe; spawning it makes the "child" a cmd wrapper whose
 * termination orphans the real bun.exe (STATE-01). Mirror the C# shell's
 * resolver: PATH bun.exe first, then the standard install locations.
 */
export function resolveBunExecutable(): string | null {
  const pathEnv = process.env.PATH ?? ''
  for (const raw of pathEnv.split(';')) {
    const dir = raw.trim().replace(/^"|"$/g, '')
    if (dir.length === 0) continue
    try {
      const candidate = join(dir, 'bun.exe')
      if (existsSync(candidate)) return candidate
    } catch {
      // malformed PATH entry; keep scanning
    }
  }
  const home = process.env.USERPROFILE ?? process.env.HOME ?? ''
  const appData = process.env.APPDATA ?? ''
  const candidates = [
    join(home, '.bun', 'bin', 'bun.exe'),
    join(appData, 'npm', 'node_modules', 'bun', 'bin', 'bun.exe'),
  ]
  for (const c of candidates) {
    if (c.length > 0 && existsSync(c)) return c
  }
  return null
}

/**
 * Decode an HTTP/1.1 chunked-transfer-encoded body from RAW bytes. The
 * node:http adapter (and any standards-compliant server) may frame the
 * /healthz response with Transfer-Encoding: chunked when no Content-Length is
 * known; the raw probe must accept that framing, not just Content-Length.
 *
 * Chunk sizes are BYTE counts; multi-byte UTF-8 characters must not be split
 * by code-unit slicing, so the framing is parsed on the Buffer and the
 * assembled body is UTF-8-decoded once at the end.
 */
function decodeChunkedBody(body: Buffer): string {
  const parts: Buffer[] = []
  let offset = 0
  for (;;) {
    const lineEnd = body.indexOf('\r\n', offset)
    if (lineEnd === -1) return '' // size line truncated
    const rawLine = body.subarray(offset, lineEnd).toString('latin1')
    // chunk-size is 1*HEXDIG followed by optional chunk-extensions of the form
    // ;token[=token|quoted-string]; the whole line must be well-formed (a
    // malformed extension like ;=bad must not classify a foreign body as ours)
    const TOKEN = "[!#$%&'*+\\-.^_`|~0-9A-Za-z]+"
    const sizeLineRe = new RegExp(`^[0-9a-f]+(?:;${TOKEN}(?:=${TOKEN}|="(?:[^\\x00-\\x1f\\x7f"\\\\]|\\\\.)*")?)*$`, "i")
    if (!sizeLineRe.test(rawLine)) return ''
    const sizePart = rawLine.split(';')[0]!
    const size = parseInt(sizePart, 16)
    offset = lineEnd + 2
    if (size === 0) {
      // terminal chunk: a valid trailer section must follow — either the
      // empty CRLF terminator (0\r\n\r\n) or (field-line CRLF)* + final CRLF
      // (0\r\nX-Trace: yes\r\n\r\n). Anything else (junk, truncated) is not a
      // clean chunked response.
      const tail = body.subarray(offset).toString('latin1')
      // trailer field names must be RFC 7230 tokens (no spaces/control chars)
      if (!/^(?:[!#$%&'*+\-.^_`|~0-9A-Za-z]+:[^\x00-\x1f\x7f\r\n]*\r\n)*\r\n$/.test(tail)) return ''
      return Buffer.concat(parts).toString('utf8')
    }
    const dataEnd = offset + size
    if (dataEnd > body.length) return '' // chunk data truncated
    parts.push(body.subarray(offset, dataEnd))
    offset = dataEnd
    if (body.subarray(offset, offset + 2).toString('latin1') !== '\r\n') return '' // missing chunk CRLF
    offset += 2
  }
}

/**
 * GR-005 — proof options. When `localCredential` is PRESENT, ok requires a
 * valid HMAC proof over a fresh per-probe challenge (a parroted public JSON
 * classifies as busy-but-foreign, never ours). A null return (unconfigured
 * state) fails closed the same way. When ABSENT, the legacy public-signature
 * check applies (framing/classification unit tests only — production always
 * passes the provider via RouterSupervisorOptions).
 */
export interface RouterHealthProbeOptions {
  localCredential?: () => string | null;
}

/** Probe the router port: ok = proven ours; busy = something is listening. */
export function probeRouterHealth(port: number, opts?: RouterHealthProbeOptions): Promise<{ ok: boolean; busy: boolean }> {
  return new Promise((resolve) => {
    let settled = false
    // F-02: ABSOLUTE deadline + byte cap. net.connect({timeout}) is an
    // INACTIVITY timer: a dribbling responder resets it with every byte, so
    // without an absolute bound the probe (and the supervisor tick awaiting
    // it) never settles and the parts buffer grows without bound.
    const ABSOLUTE_DEADLINE_MS = PROBE_TIMEOUT_MS + 500
    const MAX_PROBE_BYTES = 64 * 1024
    let absolute: ReturnType<typeof setTimeout> | null = null
    const done = (ok: boolean, busy: boolean): void => {
      if (settled) return
      settled = true
      if (absolute !== null) {
        clearTimeout(absolute)
        absolute = null
      }
      resolve({ ok, busy })
    }
    const socket = net.connect({ host: '127.0.0.1', port, timeout: PROBE_TIMEOUT_MS })
    absolute = setTimeout(() => {
      socket.destroy()
      done(false, true)
    }, ABSOLUTE_DEADLINE_MS)
    // GR-005: the challenge is minted per probe (replay across probes can
    // never verify). No provider (legacy unit-test path) sends no challenge.
    const challenge = opts?.localCredential ? newRouterChallenge() : null
    socket.once('connect', () => {
      socket.write(`GET /healthz HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n${challenge ? `${ROUTER_CHALLENGE_HEADER}: ${challenge}\r\n` : ''}Connection: close\r\n\r\n`)
      const parts: Buffer[] = []
      let bytes = 0
      socket.on('data', (c) => {
        // accumulate RAW bytes: chunked sizes are byte counts, and multi-byte
        // UTF-8 characters may split across TCP segments, so decoding per
        // chunk and slicing strings by code units would corrupt the framing
        const buf = Buffer.isBuffer(c) ? c : Buffer.from(c)
        bytes += buf.length
        if (bytes > MAX_PROBE_BYTES) {
          // F-02: flooding responder — settle without unbounded growth.
          socket.destroy()
          done(false, true)
          return
        }
        parts.push(buf)
      })
      socket.once('timeout', () => {
        socket.destroy()
        done(false, true)
      })
      socket.once('error', () => done(false, true))
      socket.once('close', () => {
        const raw = Buffer.concat(parts)
        const headerEnd = raw.indexOf('\r\n\r\n')
        if (headerEnd === -1) { done(false, true); return }
        const headerSection = raw.toString('utf8', 0, headerEnd)
        const rawBody = raw.subarray(headerEnd + 4)
        // unfold obsolete line folding first: a continuation line (leading
        // space/tab) extends the PREVIOUS field, so 'Transfer-Encoding:
        // chunked' + ' transfer-encoding: gzip' combines to a non-chunked value
        const unfolded = headerSection.replace(/\r\n[ \t]+/g, " ")
        const teValues = [...unfolded.matchAll(/^transfer-encoding:\s*(.*)$/gim)].map((m) => m[1]!.trim())
        // exactly one Transfer-Encoding field whose value is the exact
        // 'chunked' token: duplicate fields (e.g. gzip + chunked combine to
        // 'gzip, chunked'), prefixed codings (chunkedness), parameters
        // (chunked;foo), and X-Transfer-Encoding must NOT classify as chunked
        const isChunked = teValues.length === 1 && teValues[0] === 'chunked'
        const body = isChunked ? decodeChunkedBody(rawBody) : rawBody.toString('utf8').trim()
        let publicOk = false
        let proof: unknown = null
        let echoed: unknown = null
        try {
          const j = JSON.parse(body) as { status?: unknown; version?: unknown; challenge?: unknown; proof?: unknown }
          publicOk = j.status === 'ok' && typeof j.version === 'string' && j.version.length > 0
          proof = j.proof ?? null
          echoed = j.challenge ?? null
        } catch {
          publicOk = false
        }
        // GR-005: with a credential provider, liveness is not identity —
        // ok requires OUR fresh challenge echoed back with a valid HMAC.
        // Without a provider the legacy public-signature check applies
        // (framing/classification unit tests; production always provides).
        if (opts?.localCredential === undefined) {
          done(publicOk, true)
          return
        }
        let secret: string | null = null
        try {
          secret = opts.localCredential()
        } catch {
          secret = null
        }
        const ok =
          publicOk &&
          typeof secret === 'string' &&
          secret.length > 0 &&
          typeof challenge === 'string' &&
          echoed === challenge &&
          verifyRouterProof(secret, challenge, proof)
        done(ok, true)
      })
    })
    socket.once('timeout', () => {
      socket.destroy()
      done(false, true)
    })
    socket.once('error', () => done(false, false)) // connect refused -> port free
  })
}

export function createRouterSupervisor(opts: RouterSupervisorOptions): RouterSupervisor {
  const log = opts.log ?? defaultLog
  const backoff = opts.backoffMs ?? DEFAULT_BACKOFF_MS
  const probeIntervalMs = opts.probeIntervalMs ?? DEFAULT_PROBE_INTERVAL_MS

  let child: ChildProcess | null = null
  let childBornAt = 0
  let started = false
  let state: RouterState = 'stopped'
  let restartCount = 0
  let backoffIndex = 0
  let healthyStreak = 0
  let probeTimer: ReturnType<typeof setInterval> | null = null
  let respawnTimer: ReturnType<typeof setTimeout> | null = null
  let probing = false
  // F-03: unhealthy-duration + consecutive-failure hysteresis state.
  let unhealthySince = 0
  let consecutiveFailures = 0

  function setState(next: RouterState): void {
    if (next === state) return
    state = next
    opts.onStateChange?.(snapshot())
  }

  function snapshot(): RouterSnapshot {
    return {
      state,
      mode:
        state === 'attached' ? 'attached' : state === 'managed' || state === 'starting' || state === 'degraded' ? 'managed' : 'none',
      pid: child?.pid ?? null,
      port: opts.port(),
      restartCount,
    }
  }

  function spawnChild(): void {
    const cmd = opts.routerCmd()
    let argv = cmd.argv.map((a) => (a === '<port>' ? String(opts.port()) : a))
    if (argv[0] === 'bun') {
      // never spawn the bun.cmd shim: the cmd.exe wrapper orphans the real
      // bun.exe when killed (STATE-01); resolve the actual executable
      const exe = resolveBunExecutable()
      if (exe === null) {
        log.error('router spawn failed: bun.exe not found (resolved from PATH and standard install locations)')
        handleChildExit(null)
        return
      }
      argv = [exe, ...argv.slice(1)]
    }
    const env: Record<string, string | undefined> = {
      ...process.env,
      GOROUTER_STATE_DIR: opts.stateDir,
    }
    log.info(`router spawn: ${argv.join(' ')}`)
    let proc: ChildProcess
    try {
      proc = spawn(argv[0]!, argv.slice(1), { cwd: cmd.cwd, env, stdio: 'ignore', windowsHide: true })
    } catch (e) {
      log.error(`router spawn failed: ${e instanceof Error ? e.message : String(e)}`)
      handleChildExit(null)
      return
    }
    child = proc
    childBornAt = Date.now()
    // F-03: a fresh child starts with a clean failure slate.
    unhealthySince = 0
    consecutiveFailures = 0
    setState('starting')
    let handled = false
    proc.on('error', (err) => {
      log.error(`router child error: ${err.message}`)
      if (!handled) {
        handled = true
        handleChildExit(proc)
      }
    })
    proc.on('exit', (code, signal) => {
      log.warn(`router child exited code=${code} signal=${String(signal)}`)
      if (!handled) {
        handled = true
        handleChildExit(proc)
      }
    })
  }

  /** Unexpected or expected child termination. proc === null for spawn throw. */
  function handleChildExit(proc: ChildProcess | null): void {
    if (proc !== null && proc !== child) return // stale event from a replaced/killed child
    child = null
    childBornAt = 0
    if (!started) {
      setState('stopped')
      return
    }
    restartCount++
    if (backoffIndex >= backoff.length) {
      log.error(`router restart backoff exhausted after ${restartCount} restarts; state=failed`)
      setState('failed')
      return
    }
    const delay = backoff[backoffIndex]!
    backoffIndex++
    setState('degraded')
    log.warn(`router restart in ${delay}ms (restart #${restartCount})`)
    respawnTimer = setTimeout(() => {
      respawnTimer = null
      if (!started) return
      spawnChild()
    }, delay)
  }

  async function tick(): Promise<void> {
    if (probing || !started) return
    probing = true
    try {
      const port = opts.port()
      const probe = await probeRouterHealth(port, { localCredential: opts.localCredential })
      if (!started) return
      if (probe.ok) {
        // healthy router on the port: ours (managed) or external (attached)
        if (respawnTimer) {
          clearTimeout(respawnTimer)
          respawnTimer = null
        }
        // reset the crash ladder only after sustained health (2 consecutive
        // probes); restartCount keeps the total so a brief alive-blip during
        // a crash loop cannot silently restart the backoff ladder
        healthyStreak++
        // F-03: success clears the failure hysteresis.
        consecutiveFailures = 0
        unhealthySince = 0
        if (healthyStreak >= 2) {
          backoffIndex = 0
        }
        setState(child ? 'managed' : 'attached')
        return
      }
      healthyStreak = 0
      // F-03: failure hysteresis — one bad probe never kills.
      consecutiveFailures++
      if (unhealthySince === 0) unhealthySince = Date.now()
      if (child) {
        // our child is alive but not healthy yet
        if (
          shouldRecycleChild({
            nowMs: Date.now(),
            childBornAtMs: childBornAt,
            unhealthySinceMs: unhealthySince,
            consecutiveFailures,
          })
        ) {
          // sustained failure (port drift from a CLI-side config change, a
          // wedged bind, or repeated probe failures on a mature child):
          // recycle it so the backoff ladder respawns on the configured port
          log.warn('managed router child unhealthy; recycling')
          try {
            child.kill('SIGTERM')
          } catch {
            /* already gone */
          }
          return // exit event routes through the backoff ladder
        }
        setState('starting')
        return
      }
      if (respawnTimer) {
        setState('degraded')
        return
      }
      if (probe.busy) {
        setState('port_conflict') // port busy and healthz is not ours
        return
      }
      if (backoffIndex >= backoff.length) {
        setState('failed')
        return
      }
      spawnChild()
    } finally {
      probing = false
    }
  }

  function start(): void {
    // `failed` keeps started=true (backoff exhausted, no timers pending);
    // a manual start from that state is a fresh attempt, so resume.
    const fromFailed = started && state === 'failed'
    if (started && !fromFailed) return
    started = true
    if (fromFailed || backoffIndex >= backoff.length) {
      backoffIndex = 0
      restartCount = 0
      healthyStreak = 0
      unhealthySince = 0
      consecutiveFailures = 0
    }
    if (probeTimer === null) {
      probeTimer = setInterval(() => {
        void tick()
      }, probeIntervalMs)
    }
    void tick()
  }

  async function teardown(stopChild: boolean): Promise<void> {
    started = false
    healthyStreak = 0
    // F-02: a stranded probe must never brick supervision across a
    // stop/restart cycle — the latch is always recoverable from here.
    probing = false
    // F-03: stop/restart clears the failure slate.
    unhealthySince = 0
    consecutiveFailures = 0
    if (probeTimer) {
      clearInterval(probeTimer)
      probeTimer = null
    }
    if (respawnTimer) {
      clearTimeout(respawnTimer)
      respawnTimer = null
    }
    const c = child
    child = null
    if (c && stopChild) {
      try {
        c.kill('SIGTERM')
      } catch {
        /* already gone */
      }
      // GR-012: the grace wait is event-driven, never a sleepSync poll —
      // the loop keeps serving pipe operations while the child exits.
      // kill() is best-effort; if the SAME child (pid match) is still alive
      // past the grace, terminate the whole tree so a managed router can
      // never be orphaned by a failed kill (STATE-01 fallback).
      await waitForChildExit(c, CHILD_STOP_GRACE_MS)
      if (c.exitCode == null && c.signalCode == null && c.pid !== undefined) {
        try {
          spawnSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { windowsHide: true })
        } catch {
          /* already gone */
        }
        if (c.exitCode == null && c.signalCode == null) {
          try {
            c.kill('SIGKILL')
          } catch {
            /* already gone */
          }
        }
      }
    }
    // stopChild=false: intent is for the child to keep running as an orphan;
    // on Windows the Bun job object terminates it with this process anyway.
    // Its exit event is ignored because `child` is already null
    // (proc !== child guard).
    setState('stopped')
  }

  function stop(): Promise<void> {
    return teardown(true)
  }

  async function restart(): Promise<void> {
    await teardown(true)
    start()
  }

  function close(stopChild: boolean): Promise<void> {
    return teardown(stopChild)
  }

  return { start, stop, restart, snapshot, close }
}
