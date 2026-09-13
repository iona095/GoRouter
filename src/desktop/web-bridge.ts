/**
 * GoRouter W1 — co-resident local web bridge (C05 frozen contract §§5-12).
 *
 * Explicit-activation-only IPv4-loopback listener beneath a fresh >=128-bit
 * webScope path; fragment-only >=256-bit single-use bootstrap capabilities;
 * HttpOnly SameSite=Strict listener-scoped sessions (<=30 min monotonic);
 * separate per-session CSRF; exact Host+Origin enforcement; no CORS; strict
 * JSON (duplicate security-key + unknown-field rejection); 16 KiB body cap;
 * finite W1 API v1 allowlist; sanitized browser DTO; exact W0 checked
 * forwarding (no retry, force=false); hardened headers; zero provider traffic.
 *
 * The bridge reuses the authoritative in-process domain handlers. It never sees
 * the named-pipe admin token and never emits provider/model/probe traffic: the
 * only domain methods reachable here are the six W0 checked mutations plus the
 * read-only snapshot/status views.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { appendFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto'
import { ControlError, type Snapshot } from './protocol.ts'
import { isDomainConflict, type createDomain } from '../domain.ts'
import { renderIndexHtml, assetMap, bootstrapDocumentCsp, strictCsp } from './web-assets.ts'

export const W1_BOOTSTRAP_TTL_MS = 60_000
export const W1_SESSION_TTL_MS = 30 * 60_000
export const W1_BOOTSTRAP_MAX = 8
export const W1_SESSION_MAX = 16
export const W1_BODY_MAX_BYTES = 16 * 1024
export const W1_CSRF_HEADER = 'x-gorouter-csrf'
export const W1_SESSION_COOKIE_PREFIX = '__gorouter_w_'

/** Monotonic elapsed-time source (never the wall clock) for capability TTLs. */
export type MonotonicClock = () => number
export const monotonicNow: MonotonicClock = () => performance.now()

type WebDomain = Pick<ReturnType<typeof createDomain>,
  'routeSetChecked' | 'routeClearChecked' | 'accountAddChecked' |
  'accountUpdateChecked' | 'accountRenameChecked' | 'accountRemoveChecked'>

export interface WebBridgeDeps {
  getSnapshot: () => Snapshot
  domain: WebDomain
  /** Trusted native opener seam (OS default browser in production). */
  openBrowser?: (url: string) => void
  clock?: MonotonicClock
  /** Coarse lifecycle events only (never request data, cookies, or secrets). */
  log?: (event: string) => void
}

export interface WebBridge {
  /** Explicit native activation: bind on first call, reuse scope after. */
  open(): Promise<{ url: string }>
  close(): Promise<void>
  readonly isOpen: boolean
  readonly origin: string | null
  readonly scopePath: string | null
  readonly cookieName: string | null
  /** Digest-table sizes for proving (counts only, never raw values). */
  bootstrapCount(): number
  sessionCount(): number
}

/** Browser-safe snapshot DTO (explicit allowlist; no raw Snapshot forwarding). */
export interface WebSnapshot {
  serviceVersion: string
  stateGeneration: string
  initialized: boolean
  firstRun: boolean
  stateCorrupt: boolean
  stateUnsupportedVersion: number | null
  desktopUnsupportedVersion: number | null
  secretStore: string
  settings: { port: number; journalRetentionDays: number; journalMaxRecords: number }
  routes: Record<'go' | 'zen', { accountId: string | null; alias: string | null; version: number }>
  accounts: { id: string; alias: string; secretPresent: boolean; usedBy: string[]; createdAtUtc: string; updatedAtUtc: string; version: number }[]
  router: { state: string; mode: string; port: number; restartCount: number }
  desktop: { startAtLogin: boolean; minimizeToTray: boolean; theme: string; firstRunDoneAtUtc: string | null }
  localCredentialConfigured: boolean
}

export function toWebSnapshot(snap: Snapshot): WebSnapshot {
  return {
    serviceVersion: snap.serviceVersion,
    stateGeneration: snap.stateGeneration,
    initialized: snap.initialized,
    firstRun: snap.firstRun,
    stateCorrupt: snap.stateCorrupt,
    stateUnsupportedVersion: snap.stateUnsupportedVersion,
    desktopUnsupportedVersion: snap.desktopUnsupportedVersion,
    secretStore: snap.secretStore,
    settings: {
      port: snap.settings.port,
      journalRetentionDays: snap.settings.journalRetentionDays,
      journalMaxRecords: snap.settings.journalMaxRecords,
    },
    routes: {
      go: { accountId: snap.routes.go.accountId, alias: snap.routes.go.alias, version: snap.routes.go.version },
      zen: { accountId: snap.routes.zen.accountId, alias: snap.routes.zen.alias, version: snap.routes.zen.version },
    },
    accounts: snap.accounts.map((a) => ({
      id: a.id,
      alias: a.alias,
      secretPresent: a.secretPresent,
      usedBy: [...a.usedBy],
      createdAtUtc: a.createdAtUtc,
      updatedAtUtc: a.updatedAtUtc,
      version: a.version,
    })),
    router: { state: snap.router.state, mode: snap.router.mode, port: snap.router.port, restartCount: snap.router.restartCount },
    desktop: {
      startAtLogin: snap.desktop.startAtLogin,
      minimizeToTray: snap.desktop.minimizeToTray,
      theme: snap.desktop.theme,
      firstRunDoneAtUtc: snap.desktop.firstRunDoneAtUtc,
    },
    localCredentialConfigured: snap.localCredentialConfigured,
  }
}

/** Security-relevant JSON keys whose duplication must fail closed. */
const SECURITY_KEYS = new Set([
  'bootstrap', 'stateGeneration', 'accountId', 'expectedRouteVersion',
  'expectedTargetAccountVersion', 'expectedAccountVersion', 'alias', 'newAlias',
  'secret', 'force', 'lane',
])

/**
 * Scan raw JSON text for a duplicated security-relevant object key in the same
 * object level. Returns the offending key or null. Handles string escapes so
 * hostile string *values* cannot spoof a key finding.
 */
export function findDuplicateSecurityKey(text: string): string | null {
  const stack: (Set<string> | null)[] = []
  let i = 0
  const n = text.length
  const skipWs = (): void => { while (i < n && (text[i] === ' ' || text[i] === '\t' || text[i] === '\n' || text[i] === '\r')) i++ }
  const readString = (): string | null => {
    if (text[i] !== '\"') return null
    i++
    let out = ''
    while (i < n) {
      const c = text[i] as string
      if (c === '\\') {
        const e = text[i + 1] as string
        if (e === 'u') {
          const hex = text.slice(i + 2, i + 6)
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) return null
          out += String.fromCharCode(parseInt(hex, 16))
          i += 6
        } else if (e !== undefined) { out += e; i += 2 } else { return null }
      } else if (c === '\"') { i++; return out } else { out += c; i++ }
    }
    return null
  }
  while (i < n) {
    skipWs()
    if (i >= n) break
    const c = text[i] as string
    if (c === '{') { stack.push(new Set()); i++; continue }
    if (c === '[') { stack.push(null); i++; continue }
    if (c === '}' || c === ']') { stack.pop(); i++; continue }
    if (c === '\"') {
      const s = readString()
      if (s === null) return null
      skipWs()
      if (text[i] === ':') {
        i++
        const top = stack.length > 0 ? stack[stack.length - 1] : undefined
        if (top !== undefined && top !== null && SECURITY_KEYS.has(s)) {
          if (top.has(s)) return s
          top.add(s)
        }
      }
      continue
    }
    i++
  }
  return null
}

/** Parse a Cookie header into name -> values (preserves duplicates for fail-closed). */
export function parseCookieHeader(header: string | undefined): Map<string, string[]> {
  const out = new Map<string, string[]>
  if (!header) return out
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq <= 0) continue
    const name = part.slice(0, eq).trim()
    let value = part.slice(eq + 1).trim()
    if (value.length >= 2 && value.startsWith('\"') && value.endsWith('\"')) value = value.slice(1, -1)
    if (name.length === 0) continue
    const cur = out.get(name)
    if (cur) cur.push(value)
    else out.set(name, [value])
  }
  return out
}

export function validateJsonContentType(value: string | undefined): boolean {
  if (!value) return false
  const parts = value.split(';').map((p) => p.trim())
  if (parts.length === 0 || parts[0] === undefined) return false
  if (parts[0].toLowerCase() !== 'application/json') return false
  for (const p of parts.slice(1)) {
    const m = /^charset\s*=\s*"?([^"\s]+)"?$/i.exec(p)
    if (!m || m[1] === undefined || m[1].toLowerCase() !== 'utf-8') return false
  }
  return true
}

export function isBootstrapCapShape(s: unknown): s is string {
  return typeof s === 'string' && /^[A-Za-z0-9_-]{43,64}$/.test(s)
}

function b64url(bytes: number): string {
  return randomBytes(bytes).toString('base64url')
}

function sha256hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex')
}

function digestEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

function csrfEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

interface WireError { code: string; message: string; reason?: string }

function err(code: string, message: string, reason?: string): { error: WireError } {
  if (reason === undefined) return { error: { code, message } }
  return { error: { code, message, reason } }
}

function rawHeaderValues(req: IncomingMessage, name: string): string[] {
  const out: string[] = []
  const raw = req.rawHeaders
  const want = name.toLowerCase()
  for (let k = 0; k + 1 < raw.length; k += 2) {
    if ((raw[k] as string).toLowerCase() === want) out.push(raw[k + 1] as string)
  }
  return out
}

function isPosInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 1
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0
}

const PERMISSIONS_POLICY = 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), bluetooth=()'

export function createWebBridge(deps: WebBridgeDeps): WebBridge {
  const clock = deps.clock ?? monotonicNow
  const sink = deps.log ?? ((): void => {})
  let server: Server | null = null
  let port = 0
  let webScope = ''
  let cookieName = ''
  let scopeBase = ''
  let canonicalOrigin = ''
  let creating: Promise<void> | null = null
  // Teardown generation: a close() racing an in-flight bind must not leave a
  // post-close listener behind (shutdown invalidates FIRST, then releases).
  let epoch = 0
  const bootstraps = new Map<string, { expiresAt: number }>()
  const sessions = new Map<string, { csrf: string; expiresAt: number }>()

  const reapBootstraps = (): void => {
    const now = clock()
    for (const [k, v] of bootstraps) if (v.expiresAt <= now) bootstraps.delete(k)
  }
  const reapSessions = (): void => {
    const now = clock()
    for (const [k, v] of sessions) if (v.expiresAt <= now) sessions.delete(k)
  }

  function baseHeaders(extra: Record<string, string>, res: ServerResponse): void {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
    for (const k of Object.keys(extra)) res.setHeader(k, extra[k] as string)
  }

  function sendJson(res: ServerResponse, status: number, obj: unknown): void {
    baseHeaders({ 'Content-Type': 'application/json; charset=utf-8' }, res)
    res.writeHead(status)
    res.end(JSON.stringify(obj))
  }

  function sendHtml(res: ServerResponse, html: string, csp: string): void {
    baseHeaders({
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': csp,
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Permissions-Policy': PERMISSIONS_POLICY,
    }, res)
    res.writeHead(200)
    res.end(html)
  }

  function sendAsset(res: ServerResponse, contentType: string, body: string): void {
    baseHeaders({ 'Content-Type': contentType }, res)
    res.writeHead(200)
    res.end(body)
  }

  function readBodyCapped(req: IncomingMessage): Promise<{ ok: true; bytes: Buffer } | { ok: false }> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = []
      let total = 0
      let done = false
      const finish = (v: { ok: true; bytes: Buffer } | { ok: false }): void => {
        if (done) return
        done = true
        resolve(v)
      }
      req.on('data', (c: Buffer) => {
        if (done) return
        total += c.length
        if (total > W1_BODY_MAX_BYTES) { finish({ ok: false }); return }
        chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c))
      })
      req.on('end', () => finish({ ok: true, bytes: Buffer.concat(chunks) }))
      req.on('error', () => finish({ ok: true, bytes: Buffer.concat(chunks) }))
    })
  }

  function checkHost(req: IncomingMessage): { ok: true } | { ok: false; status: number; body: { error: WireError } } {
    const vals = rawHeaderValues(req, 'host')
    if (vals.length !== 1) return { ok: false, status: 400, body: err('validation', 'exactly one Host header is required') }
    if (vals[0] !== '127.0.0.1:' + String(port)) return { ok: false, status: 403, body: err('validation', 'forbidden host') }
    return { ok: true }
  }

  function checkFraming(req: IncomingMessage): { ok: true } | { ok: false; status: number; body: { error: WireError } } {
    const cls = rawHeaderValues(req, 'content-length')
    if (cls.length > 1) return { ok: false, status: 400, body: err('validation', 'ambiguous request framing') }
    const tes = rawHeaderValues(req, 'transfer-encoding')
    if (tes.length > 1) return { ok: false, status: 400, body: err('validation', 'ambiguous request framing') }
    if (cls.length === 1 && tes.length === 1) return { ok: false, status: 400, body: err('validation', 'ambiguous request framing') }
    return { ok: true }
  }

  function checkFetchSite(req: IncomingMessage, forDocument: boolean): { ok: true } | { ok: false; status: number; body: { error: WireError } } {
    const vals = rawHeaderValues(req, 'sec-fetch-site')
    if (vals.length === 0) return { ok: true }
    if (vals.length !== 1) return { ok: false, status: 403, body: err('validation', 'ambiguous fetch metadata') }
    const v = (vals[0] as string).toLowerCase()
    if (forDocument) {
      if (v === 'none' || v === 'same-origin') return { ok: true }
      return { ok: false, status: 403, body: err('validation', 'forbidden fetch site') }
    }
    if (v === 'same-origin') return { ok: true }
    return { ok: false, status: 403, body: err('validation', 'forbidden fetch site') }
  }

  function checkOrigin(req: IncomingMessage): { ok: true } | { ok: false; status: number; body: { error: WireError } } {
    const vals = rawHeaderValues(req, 'origin')
    if (vals.length !== 1) return { ok: false, status: 403, body: err('validation', 'exact Origin is required') }
    if (vals[0] !== canonicalOrigin) return { ok: false, status: 403, body: err('validation', 'forbidden origin') }
    return { ok: true }
  }

  function authenticate(req: IncomingMessage): { ok: true; csrf: string } | { ok: false; status: number; body: { error: WireError } } {
    reapSessions()
    const cookies = parseCookieHeader(req.headers.cookie)
    const vals = cookies.get(cookieName) ?? []
    if (vals.length === 0) return { ok: false, status: 401, body: err('auth', 'browser session is required') }
    const distinct = [...new Set(vals)]
    if (distinct.length !== 1 || distinct[0] === undefined) return { ok: false, status: 401, body: err('auth', 'conflicting session cookies') }
    const presented = distinct[0] as string
    const digest = sha256hex(presented)
    let found: { csrf: string; expiresAt: number } | null = null
    for (const [k, v] of sessions) {
      if (digestEqualHex(k, digest)) { found = v; break }
    }
    if (!found) return { ok: false, status: 401, body: err('auth', 'unknown or expired browser session') }
    if (found.expiresAt <= clock()) { sessions.delete(sha256hex(presented)); return { ok: false, status: 401, body: err('auth', 'browser session expired') } }
    return { ok: true, csrf: found.csrf }
  }

  function checkCsrf(req: IncomingMessage, sessionCsrf: string): { ok: true } | { ok: false; status: number; body: { error: WireError } } {
    const vals = rawHeaderValues(req, W1_CSRF_HEADER)
    if (vals.length !== 1) return { ok: false, status: 403, body: err('validation', 'CSRF capability is required') }
    if (!csrfEqual(vals[0] as string, sessionCsrf)) return { ok: false, status: 403, body: err('validation', 'forbidden CSRF capability') }
    return { ok: true }
  }

  function mapDomainError(e: unknown): { status: number; body: { error: WireError } } {
    // Native parity (control-service mapDomainError): ControlErrors pass through
    // with their wire code; DomainConflicts map by stable reason; plain domain
    // Errors fall back by message shape to validation/conflict/not_found. The
    // browser therefore observes the same machine-readable semantics as native.
    if (e instanceof ControlError) {
      const status = e.code === 'not_found' ? 404 : e.code === 'conflict' ? 409 : e.code === 'auth' ? 401 : 400
      return { status, body: err(e.code, e.message, e.reason) }
    }
    if (isDomainConflict(e)) {
      const reason = (e as { reason?: string }).reason ?? 'conflict'
      if (reason === 'not_found') return { status: 404, body: err('not_found', (e as Error).message, reason) }
      return { status: 409, body: err('conflict', (e as Error).message, reason) }
    }
    const message = e instanceof Error ? e.message : String(e)
    if (/already exists|duplicate/i.test(message)) return { status: 409, body: err('conflict', message) }
    if (/lock timeout/i.test(message)) return { status: 409, body: err('conflict', message) }
    if (/not found/i.test(message)) return { status: 404, body: err('not_found', message) }
    return { status: 400, body: err('validation', message) }
  }

  function parseStrict(body: Buffer, allowed: Set<string>): { ok: true; value: Record<string, unknown> } | { ok: false; status: number; body: { error: WireError } } {
    let text: string
    try { text = body.toString('utf8') } catch { return { ok: false, status: 400, body: err('validation', 'malformed JSON') } }
    const dup = findDuplicateSecurityKey(text)
    if (dup !== null) return { ok: false, status: 400, body: err('validation', 'duplicate field: ' + dup) }
    let v: unknown
    try { v = JSON.parse(text) } catch { return { ok: false, status: 400, body: err('validation', 'malformed JSON') } }
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return { ok: false, status: 400, body: err('validation', 'JSON object is required') }
    const rec = v as Record<string, unknown>
    for (const k of Object.keys(rec)) {
      if (!allowed.has(k)) return { ok: false, status: 400, body: err('validation', 'unknown field: ' + k) }
    }
    return { ok: true, value: rec }
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const rawTarget = req.url ?? '/'
    if (rawTarget.indexOf('\\') !== -1) { sendJson(res, 404, err('not_found', 'not found')); return }
    let path: string
    let search: string
    try {
      const u = new URL(rawTarget, 'http://127.0.0.1')
      path = u.pathname
      search = u.search
    } catch { sendJson(res, 400, err('validation', 'malformed request target')); return }
    if (path.indexOf('..') !== -1) { sendJson(res, 404, err('not_found', 'not found')); return }
    const host = checkHost(req)
    if (!host.ok) { sendJson(res, host.status, host.body); return }
    const framing = checkFraming(req)
    if (!framing.ok) { sendJson(res, framing.status, framing.body); return }
    if ((req.method ?? '') === 'OPTIONS') { sendJson(res, 404, err('not_found', 'not found')); return }
    if (path !== scopeBase && path.indexOf(scopeBase) !== 0) { sendJson(res, 404, err('not_found', 'not found')); return }
    const rest = path.slice(scopeBase.length)
    const method = (req.method ?? 'GET').toUpperCase()

    if (rest === '') {
      if (method !== 'GET') { sendJson(res, 405, err('validation', 'method not allowed')); return }
      const site = checkFetchSite(req, true)
      if (!site.ok) { sendJson(res, site.status, site.body); return }
      sendHtml(res, renderIndexHtml(), bootstrapDocumentCsp())
      return
    }

    const assets = assetMap()
    if (rest === 'assets/app.js' || rest === 'assets/app.css') {
      if (method !== 'GET') { sendJson(res, 405, err('validation', 'method not allowed')); return }
      const site = checkFetchSite(req, false)
      if (site.ok !== true) { sendJson(res, 403, err('validation', 'forbidden fetch site')); return }
      const a = assets['/' + rest] as { contentType: string; body: string }
      sendAsset(res, a.contentType, a.body)
      return
    }

    if (rest === 'api/v1/bootstrap') {
      if (method !== 'POST') { sendJson(res, 405, err('validation', 'method not allowed')); return }
      const site = checkFetchSite(req, false)
      if (!site.ok) { sendJson(res, site.status, site.body); return }
      const origin = checkOrigin(req)
      if (!origin.ok) { sendJson(res, origin.status, origin.body); return }
      if (req.headers.authorization !== undefined) { sendJson(res, 400, err('validation', 'authorization header is not accepted')); return }
      if (!validateJsonContentType(req.headers['content-type'])) { sendJson(res, 415, err('validation', 'application/json is required')); return }
      if (search.length > 0) { sendJson(res, 400, err('validation', 'query parameters are not accepted')); return }
      const read = await readBodyCapped(req)
      if (!read.ok) { sendJson(res, 413, err('validation', 'request body too large')); try { req.destroy() } catch { /* bounded */ } return }
      const parsed = parseStrict(read.bytes, new Set(['bootstrap']))
      if (!parsed.ok) { sendJson(res, parsed.status, parsed.body); return }
      const presented = parsed.value['bootstrap']
      if (!isBootstrapCapShape(presented)) { sink('bootstrap-fail'); sendJson(res, 403, err('auth', 'unknown or expired bootstrap')); return }
      const digest = sha256hex(presented)
      reapBootstraps()
      let entry: { expiresAt: number } | null = null
      for (const [k, v] of bootstraps) {
        if (digestEqualHex(k, digest)) { entry = v; break }
      }
      if (!entry) { sink('bootstrap-fail'); sendJson(res, 403, err('auth', 'unknown or expired bootstrap')); return }
      if (entry.expiresAt <= clock()) { bootstraps.delete(digest); sink('bootstrap-fail'); sendJson(res, 403, err('auth', 'unknown or expired bootstrap')); return }
      reapSessions()
      if (sessions.size >= W1_SESSION_MAX) { sink('session-full'); sendJson(res, 503, err('unavailable', 'browser session table is full')); return }
      bootstraps.delete(digest)
      const token = b64url(32)
      const csrf = b64url(32)
      sessions.set(sha256hex(token), { csrf, expiresAt: clock() + W1_SESSION_TTL_MS })
      res.setHeader('Set-Cookie', cookieName + '=' + token + '; Path=' + scopeBase + '; Max-Age=1800; HttpOnly; SameSite=Strict')
      sink('bootstrap-ok')
      sendJson(res, 200, { csrf })
      return
    }

    const needsSession =
      rest === 'api/v1/snapshot' || rest === 'api/v1/session' || rest === 'api/v1/logout' ||
      rest === 'api/v1/routes/set' || rest === 'api/v1/routes/clear' ||
      rest === 'api/v1/accounts/add' || rest === 'api/v1/accounts/update' ||
      rest === 'api/v1/accounts/rename' || rest === 'api/v1/accounts/remove'
    if (needsSession) {
      const site = checkFetchSite(req, false)
      if (!site.ok) { sendJson(res, site.status, site.body); return }
      if (method === 'POST') {
        const origin = checkOrigin(req)
        if (!origin.ok) { sendJson(res, origin.status, origin.body); return }
        if (req.headers.authorization !== undefined) { sendJson(res, 400, err('validation', 'authorization header is not accepted')); return }
      }
      const auth = authenticate(req)
      if (!auth.ok) { sendJson(res, auth.status, auth.body); return }

      if (rest === 'api/v1/snapshot') {
        if (method !== 'GET') { sendJson(res, 405, err('validation', 'method not allowed')); return }
        sendJson(res, 200, { snapshot: toWebSnapshot(deps.getSnapshot()) })
        return
      }
      if (rest === 'api/v1/session') {
        if (method !== 'GET') { sendJson(res, 405, err('validation', 'method not allowed')); return }
        sendJson(res, 200, { csrf: auth.csrf })
        return
      }
      if (rest === 'api/v1/logout') {
        if (method !== 'POST') { sendJson(res, 405, err('validation', 'method not allowed')); return }
        const csrf = checkCsrf(req, auth.csrf)
        if (!csrf.ok) { sendJson(res, csrf.status, csrf.body); return }
        if (search.length > 0) { sendJson(res, 400, err('validation', 'query parameters are not accepted')); return }
        sessions.delete(findSessionKey(auth.csrf))
        res.setHeader('Set-Cookie', cookieName + '=; Path=' + scopeBase + '; Max-Age=0; HttpOnly; SameSite=Strict')
        sendJson(res, 200, { ok: true })
        return
      }

      const csrf = checkCsrf(req, auth.csrf)
      if (!csrf.ok) { sendJson(res, csrf.status, csrf.body); return }
      if (!validateJsonContentType(req.headers['content-type'])) { sendJson(res, 415, err('validation', 'application/json is required')); return }
      if (search.length > 0) { sendJson(res, 400, err('validation', 'query parameters are not accepted')); return }
      const read = await readBodyCapped(req)
      if (!read.ok) { sendJson(res, 413, err('validation', 'request body too large')); try { req.destroy() } catch { /* bounded */ } return }

      if (rest === 'api/v1/routes/set') {
        if (method !== 'POST') { sendJson(res, 405, err('validation', 'method not allowed')); return }
        const parsed = parseStrict(read.bytes, new Set(['stateGeneration', 'lane', 'accountId', 'expectedRouteVersion', 'expectedTargetAccountVersion']))
        if (!parsed.ok) { sendJson(res, parsed.status, parsed.body); return }
        const p = parsed.value
        if (!isNonEmptyString(p['stateGeneration']) || !isNonEmptyString(p['accountId'])) { sendJson(res, 400, err('validation', 'stateGeneration and accountId are required')); return }
        if (p['lane'] !== 'go' && p['lane'] !== 'zen') { sendJson(res, 400, err('validation', "lane must be 'go' or 'zen'")); return }
        if (!isPosInt(p['expectedRouteVersion']) || !isPosInt(p['expectedTargetAccountVersion'])) { sendJson(res, 400, err('validation', 'expected versions are required')); return }
        try {
          const r = deps.domain.routeSetChecked(p['lane'], p['accountId'], {
            expectedStateGeneration: p['stateGeneration'],
            expectedRouteVersion: p['expectedRouteVersion'],
            expectedTargetAccountVersion: p['expectedTargetAccountVersion'],
          })
          sendJson(res, 200, { ok: true, result: r })
        } catch (e) { const m = mapDomainError(e); sendJson(res, m.status, m.body) }
        return
      }
      if (rest === 'api/v1/routes/clear') {
        if (method !== 'POST') { sendJson(res, 405, err('validation', 'method not allowed')); return }
        const parsed = parseStrict(read.bytes, new Set(['stateGeneration', 'lane', 'expectedRouteVersion']))
        if (!parsed.ok) { sendJson(res, parsed.status, parsed.body); return }
        const p = parsed.value
        if (!isNonEmptyString(p['stateGeneration'])) { sendJson(res, 400, err('validation', 'stateGeneration is required')); return }
        if (p['lane'] !== 'go' && p['lane'] !== 'zen') { sendJson(res, 400, err('validation', "lane must be 'go' or 'zen'")); return }
        if (!isPosInt(p['expectedRouteVersion'])) { sendJson(res, 400, err('validation', 'expectedRouteVersion is required')); return }
        try {
          const r = deps.domain.routeClearChecked(p['lane'], {
            expectedStateGeneration: p['stateGeneration'],
            expectedRouteVersion: p['expectedRouteVersion'],
          })
          sendJson(res, 200, { ok: true, result: r })
        } catch (e) { const m = mapDomainError(e); sendJson(res, m.status, m.body) }
        return
      }
      if (rest === 'api/v1/accounts/add') {
        if (method !== 'POST') { sendJson(res, 405, err('validation', 'method not allowed')); return }
        const parsed = parseStrict(read.bytes, new Set(['stateGeneration', 'alias', 'secret']))
        if (!parsed.ok) { sendJson(res, parsed.status, parsed.body); return }
        const secretGuard = guardSecretTransport(req)
        if (!secretGuard.ok) { sendJson(res, secretGuard.status, secretGuard.body); return }
        const p = parsed.value
        if (!isNonEmptyString(p['stateGeneration']) || !isNonEmptyString(p['alias']) || !isNonEmptyString(p['secret'])) { sendJson(res, 400, err('validation', 'stateGeneration, alias and secret are required')); return }
        try {
          const r = deps.domain.accountAddChecked(p['alias'], p['secret'], { expectedStateGeneration: p['stateGeneration'] })
          sendJson(res, 200, { ok: true, account: publicAccount(r.account) })
        } catch (e) { const m = mapDomainError(e); sendJson(res, m.status, m.body) }
        return
      }
      if (rest === 'api/v1/accounts/update') {
        if (method !== 'POST') { sendJson(res, 405, err('validation', 'method not allowed')); return }
        const parsed = parseStrict(read.bytes, new Set(['stateGeneration', 'accountId', 'expectedAccountVersion', 'secret']))
        if (!parsed.ok) { sendJson(res, parsed.status, parsed.body); return }
        const secretGuard = guardSecretTransport(req)
        if (!secretGuard.ok) { sendJson(res, secretGuard.status, secretGuard.body); return }
        const p = parsed.value
        if (!isNonEmptyString(p['stateGeneration']) || !isNonEmptyString(p['accountId']) || !isNonEmptyString(p['secret'])) { sendJson(res, 400, err('validation', 'stateGeneration, accountId and secret are required')); return }
        if (!isPosInt(p['expectedAccountVersion'])) { sendJson(res, 400, err('validation', 'expectedAccountVersion is required')); return }
        try {
          const r = deps.domain.accountUpdateChecked(p['accountId'], p['secret'], {
            expectedStateGeneration: p['stateGeneration'],
            expectedAccountVersion: p['expectedAccountVersion'],
          })
          sendJson(res, 200, { ok: true, account: publicAccount(r.account) })
        } catch (e) { const m = mapDomainError(e); sendJson(res, m.status, m.body) }
        return
      }
      if (rest === 'api/v1/accounts/rename') {
        if (method !== 'POST') { sendJson(res, 405, err('validation', 'method not allowed')); return }
        const parsed = parseStrict(read.bytes, new Set(['stateGeneration', 'accountId', 'expectedAccountVersion', 'newAlias']))
        if (!parsed.ok) { sendJson(res, parsed.status, parsed.body); return }
        const p = parsed.value
        if (!isNonEmptyString(p['stateGeneration']) || !isNonEmptyString(p['accountId']) || !isNonEmptyString(p['newAlias'])) { sendJson(res, 400, err('validation', 'stateGeneration, accountId and newAlias are required')); return }
        if (!isPosInt(p['expectedAccountVersion'])) { sendJson(res, 400, err('validation', 'expectedAccountVersion is required')); return }
        try {
          const r = deps.domain.accountRenameChecked(p['accountId'], p['newAlias'], {
            expectedStateGeneration: p['stateGeneration'],
            expectedAccountVersion: p['expectedAccountVersion'],
          })
          sendJson(res, 200, { ok: true, account: publicAccount(r.account) })
        } catch (e) { const m = mapDomainError(e); sendJson(res, m.status, m.body) }
        return
      }
      if (rest === 'api/v1/accounts/remove') {
        if (method !== 'POST') { sendJson(res, 405, err('validation', 'method not allowed')); return }
        const parsed = parseStrict(read.bytes, new Set(['stateGeneration', 'accountId', 'expectedAccountVersion']))
        if (!parsed.ok) {
          const rawText = read.bytes.toString('utf8')
          if (rawText.indexOf('"force"') !== -1) { sendJson(res, 403, err('validation', 'forced removal is not available in the browser')); return }
          sendJson(res, parsed.status, parsed.body); return
        }
        const p = parsed.value
        if (!isNonEmptyString(p['stateGeneration']) || !isNonEmptyString(p['accountId'])) { sendJson(res, 400, err('validation', 'stateGeneration and accountId are required')); return }
        if (!isPosInt(p['expectedAccountVersion'])) { sendJson(res, 400, err('validation', 'expectedAccountVersion is required')); return }
        try {
          const r = deps.domain.accountRemoveChecked(p['accountId'], false, {
            expectedStateGeneration: p['stateGeneration'],
            expectedAccountVersion: p['expectedAccountVersion'],
          })
          sendJson(res, 200, { ok: true, result: r })
        } catch (e) { const m = mapDomainError(e); sendJson(res, m.status, m.body) }
        return
      }
    }

    sendJson(res, 404, err('not_found', 'not found'))
  }

  function guardSecretTransport(req: IncomingMessage): { ok: true } | { ok: false; status: number; body: { error: WireError } } {
    const cookies = parseCookieHeader(req.headers.cookie)
    for (const name of cookies.keys()) {
      if (name.toLowerCase() === 'secret') return { ok: false, status: 400, body: err('validation', 'account secret travels in the JSON body only') }
    }
    return { ok: true }
  }

  function publicAccount(a: { id: string; alias: string; secretPresent: boolean; usedBy: string[]; createdAtUtc: string; updatedAtUtc: string; version: number }): unknown {
    return { id: a.id, alias: a.alias, secretPresent: a.secretPresent, usedBy: [...a.usedBy], createdAtUtc: a.createdAtUtc, updatedAtUtc: a.updatedAtUtc, version: a.version }
  }

  function findSessionKey(csrf: string): string {
    for (const [k, v] of sessions) {
      if (csrfEqual(v.csrf, csrf)) return k
    }
    return ''
  }

  function createListener(): Promise<void> {
    return (async (): Promise<void> => {
      const myEpoch = epoch
      const freshScope = b64url(16)
      const freshCookie = W1_SESSION_COOKIE_PREFIX + b64url(6)
      const srv: Server = createServer((req, res) => {
        route(req, res).catch(() => {
          try { sendJson(res, 500, err('internal', 'internal error')) } catch { /* isolated */ }
        })
      })
      // Bind FIRST: no scope/bootstrap capability exists before a live listener.
      await new Promise<void>((resolve, reject) => {
        srv.once('error', reject)
        srv.listen(0, '127.0.0.1', () => { srv.removeListener('error', reject); resolve() })
      }).catch((e: unknown) => {
        try { srv.close() } catch { /* release */ }
        throw e
      })
      const addr = srv.address()
      if (!addr || typeof addr === 'string') {
        try { srv.close() } catch { /* release */ }
        throw new Error('web listener did not bind a port')
      }
      if ((addr.address ?? '127.0.0.1') !== '127.0.0.1') {
        try { srv.close() } catch { /* release */ }
        throw new Error('web listener bound a non-loopback address')
      }
      if (myEpoch !== epoch) {
        // A shutdown won the race: release the stray bind, leave nothing live.
        try { srv.close() } catch { /* release */ }
        throw new Error('web listener closed during creation')
      }
      server = srv
      port = addr.port
      webScope = freshScope
      cookieName = freshCookie
      scopeBase = '/_gorouter/' + webScope + '/'
      canonicalOrigin = 'http://127.0.0.1:' + String(port)
      sink('open')
    })()
  }

  async function open(): Promise<{ url: string }> {
    // Listener creation is serialized: concurrent first-opens share one
    // listener/scope, then EACH mints its own distinct bootstrap capability.
    if (!server) {
      if (!creating) {
        creating = createListener().finally(() => { creating = null })
      }
      await creating
    }
    if (!server) throw new Error('web listener failed to start')
    reapBootstraps()
    if (bootstraps.size >= W1_BOOTSTRAP_MAX) {
      sink('bootstrap-full')
      throw new Error('bootstrap table is full')
    }
    const raw = b64url(32)
    bootstraps.set(sha256hex(raw), { expiresAt: clock() + W1_BOOTSTRAP_TTL_MS })
    const url = canonicalOrigin + scopeBase + '#bootstrap=' + raw
    try {
      deps.openBrowser?.(url)
    } catch (e) {
      // Synchronous launch failure revokes the just-minted bootstrap: no live
      // capability is left behind (short expiry remains the backstop otherwise).
      bootstraps.delete(sha256hex(raw))
      throw e
    }
    return { url }
  }

  async function close(): Promise<void> {
    epoch++
    bootstraps.clear()
    sessions.clear()
    webScope = ''
    cookieName = ''
    scopeBase = ''
    canonicalOrigin = ''
    port = 0
    const srv = server
    server = null
    if (srv) {
      await new Promise<void>((resolve) => { srv.close(() => resolve()); setTimeout(resolve, 1000) })
    }
    sink('close')
  }

  return {
    open,
    close,
    get isOpen() { return server !== null },
    get origin() { return server ? canonicalOrigin : null },
    get scopePath() { return server ? scopeBase : null },
    get cookieName() { return server ? cookieName : null },
    bootstrapCount() { reapBootstraps(); return bootstraps.size },
    sessionCount() { reapSessions(); return sessions.size },
  }
}

/**
 * Production browser opener: the OS default browser only. The URL must be a
 * W1 loopback launch URL; no environment variable, setting, or argument can
 * substitute an executable/argv (packaged-mode guard, contract §5.4).
 */
export function openInDefaultBrowser(url: string): void {
  if (typeof url !== 'string' || url.indexOf('http://127.0.0.1:') !== 0) {
    throw new Error('refusing to open a non-loopback URL')
  }
  const opts = { stdio: 'ignore' as const, detached: true, windowsHide: true }
  try {
    if (process.platform === 'win32') {
      const child = spawn('cmd', ['/c', 'start', '""', url], opts)
      child.unref()
    } else if (process.platform === 'darwin') {
      const child = spawn('open', [url], opts)
      child.unref()
    } else {
      const child = spawn('xdg-open', [url], opts)
      child.unref()
    }
  } catch (e) {
    throw new Error('default browser launch failed: ' + (e instanceof Error ? e.message : String(e)))
  }
}

/**
 * Resolve the opener for a native launch. Production (and all packaged runs)
 * always use the OS default browser. A capture file is honored ONLY in DEV
 * (tests): it records the launch URL for assertion instead of opening a real
 * browser. Packaged mode ignores it unconditionally.
 */
export function resolveBrowserOpener(opts: { packaged: boolean; captureFile?: string }): (url: string) => void {
  const capture = (opts.captureFile ?? '').trim()
  if (capture.length > 0 && !opts.packaged) {
    return (url: string): void => {
      if (typeof url !== 'string' || url.indexOf('http://127.0.0.1:') !== 0) {
        throw new Error('refusing to capture a non-loopback URL')
      }
      appendFileSync(capture, url + '\n', 'utf8')
    }
  }
  return openInDefaultBrowser
}
