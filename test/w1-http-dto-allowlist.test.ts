/**
 * W1 proving: HTTP parsing/headers (58-74) + endpoint allowlist/DTO (75-87).
 * Synthetic-only; loopback HTTP to the real W1 bridge; no external network;
 * no production state/credentials; no provider traffic.
 */
import { describe, test, expect, afterEach, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'
import net from 'node:net'
import { createWebBridge, type WebBridge } from '../src/desktop/web-bridge.ts'
import { APP_JS, BOOTSTRAP_SHIM_JS, renderIndexHtml } from '../src/desktop/web-assets.ts'
import { createControlService } from '../src/desktop/control-core.ts'
import { createDomain } from '../src/domain.ts'
import { resolvePaths, ensureStateDirs } from '../src/paths.ts'
import { memSecrets } from './harness.ts'

const dirs: string[] = []
const bridges: WebBridge[] = []
afterEach(async () => {
  for (const b of bridges.splice(0)) { try { await b.close() } catch { /* closed */ } }
  for (const d of dirs.splice(0)) { try { rmSync(d, { recursive: true, force: true }) } catch { /* busy */ } }
})

const realFetch = globalThis.fetch
const externalFetches: string[] = []
beforeAll(() => {
  globalThis.fetch = (async (input: unknown, init?: unknown) => {
    const s = String(typeof input === 'string' ? input : (input as { url?: unknown })?.url ?? input)
    try {
      const u = new URL(s)
      if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') externalFetches.push(s)
    } catch { externalFetches.push(s) }
    return (realFetch as typeof fetch)(input as never, init as never)
  }) as typeof fetch
})
afterAll(() => { globalThis.fetch = realFetch })

function manualClock(start?: number): { now: () => number; advance: (ms: number) => void } {
  let t = start ?? 3000000
  return { now: () => t, advance: (ms: number) => { t += ms } }
}

interface Fx { dir: string; domain: ReturnType<typeof createDomain>; core: ReturnType<typeof createControlService>; bridge: WebBridge; logs: string[]; captured: string[]; clock: { now: () => number; advance: (ms: number) => void } }
async function fx(): Promise<Fx> {
  const dir = mkdtempSync(join(tmpdir(), 'gorouter-w1d-'))
  dirs.push(dir)
  const paths = resolvePaths(dir)
  ensureStateDirs(paths)
  const secrets = memSecrets({ sec_desktop_admin: 'w1d-admin-token' })
  const domain = createDomain(paths, secrets)
  domain.setup()
  const core = createControlService({ paths, secrets, domain, pipeName: 'w1d-inproc' })
  const logs: string[] = []
  const captured: string[] = []
  const clock = manualClock()
  const bridge = createWebBridge({ getSnapshot: () => core.snapshot(), domain, openBrowser: (url: string) => { captured.push(url) }, clock: clock.now, log: (e: string) => { logs.push(e) } })
  bridges.push(bridge)
  return { dir, domain, core, bridge, logs, captured, clock }
}

interface Resp { status: number; headers: Map<string, string[]>; text: string }
function hreq(port: number, method: string, target: string, headers?: Record<string, string>, body?: string): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: target, headers: headers ?? {} }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)))
      res.on('end', () => {
        const m = new Map<string, string[]>()
        const rh = (res.rawHeaders ?? []) as string[]
        for (let k = 0; k + 1 < rh.length; k += 2) {
          const key = (rh[k] as string).toLowerCase()
          const cur = m.get(key) ?? []
          cur.push(rh[k + 1] as string)
          m.set(key, cur)
        }
        resolve({ status: res.statusCode ?? 0, headers: m, text: Buffer.concat(chunks).toString('utf8') })
      })
    })
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

function rawHttp(port: number, head: string, body?: string): Promise<{ status: number; raw: string }> {
  return new Promise((resolve) => {
    let settled = false
    const done = (v: { status: number; raw: string }): void => { if (!settled) { settled = true; resolve(v) } }
    const sock = net.connect({ host: '127.0.0.1', port })
    let data = Buffer.alloc(0)
    const timer = setTimeout(() => { try { sock.destroy() } catch { /* t */ } done({ status: -1, raw: data.toString('utf8') }) }, 5000)
    sock.on('connect', () => { sock.write(head + '\r\n\r\n' + (body ?? '')) })
    sock.on('data', (c) => { data = Buffer.concat([data, Buffer.isBuffer(c) ? c : Buffer.from(c)]) })
    const finish = (): void => {
      clearTimeout(timer)
      const s = data.toString('utf8')
      const m = /^HTTP\/\d\.\d\s+(\d+)/.exec(s)
      done({ status: m && m[1] ? Number(m[1]) : 0, raw: s })
    }
    sock.on('end', finish)
    sock.on('close', finish)
    sock.on('error', () => { clearTimeout(timer); done({ status: 0, raw: data.toString('utf8') }) })
  })
}

function portOf(origin: string): number { return Number(new URL(origin).port) }
interface Sess { origin: string; scope: string; port: number; cookie: string; csrf: string }
async function openSession(f: Fx): Promise<Sess> {
  const { url } = await f.bridge.open()
  const origin = f.bridge.origin as string
  const scope = f.bridge.scopePath as string
  const frag = url.split('#bootstrap=')[1] as string
  const r = await hreq(portOf(origin), 'POST', scope + 'api/v1/bootstrap', { Origin: origin, 'Content-Type': 'application/json' }, JSON.stringify({ bootstrap: frag }))
  if (r.status !== 200) throw new Error('bootstrap failed: ' + r.status)
  const cookie = (((r.headers.get('set-cookie') || [])[0] as string).split(';')[0] as string)
  return { origin, scope, port: portOf(origin), cookie, csrf: (JSON.parse(r.text).csrf) as string }
}
async function mut(s: Sess, rest: string, body: string, csrf?: string, extraHeaders?: Record<string, string>): Promise<Resp> {
  const h: Record<string, string> = { Origin: s.origin, 'Content-Type': 'application/json', Cookie: s.cookie, ...(extraHeaders ?? {}) }
  if (csrf !== undefined) h['x-gorouter-csrf'] = csrf
  return hreq(s.port, 'POST', s.scope + 'api/v1/' + rest, h, body)
}

describe('w1 http/dto/allowlist (58-87)', () => {
  test('58: bootstrap/mutation POST requires application/json', async () => {
    const f = await fx()
    const s = await openSession(f)
    const frag = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
    const plain = await hreq(s.port, 'POST', s.scope + 'api/v1/bootstrap', { Origin: s.origin, 'Content-Type': 'text/plain' }, JSON.stringify({ bootstrap: frag }))
    expect(plain.status).toBe(415)
    const missing = await hreq(s.port, 'POST', s.scope + 'api/v1/bootstrap', { Origin: s.origin }, JSON.stringify({ bootstrap: frag }))
    expect(missing.status).toBe(415)
    const utf8 = await hreq(s.port, 'POST', s.scope + 'api/v1/bootstrap', { Origin: s.origin, 'Content-Type': 'application/json; charset=utf-8' }, JSON.stringify({ bootstrap: frag }))
    expect([403, 400].includes(utf8.status)).toBe(true)
    const latin = await hreq(s.port, 'POST', s.scope + 'api/v1/bootstrap', { Origin: s.origin, 'Content-Type': 'application/json; charset=latin1' }, JSON.stringify({ bootstrap: frag }))
    expect(latin.status).toBe(415)
  })

  test('59: malformed JSON rejects', async () => {
    const f = await fx()
    const s = await openSession(f)
    expect((await mut(s, 'routes/set', '{oops', s.csrf)).status).toBe(400)
    expect((await mut(s, 'routes/set', '', s.csrf)).status).toBe(400)
  })

  test('60: wrong top-level type rejects', async () => {
    const f = await fx()
    const s = await openSession(f)
    for (const bad of ['[1,2]', '"str"', '123', 'null', 'true']) {
      expect((await mut(s, 'routes/set', bad, s.csrf)).status).toBe(400)
    }
  })

  test('61: ambiguous framing/critical headers fail closed, service survives', async () => {
    const f = await fx()
    const s = await openSession(f)
    const H = 'Host: 127.0.0.1:' + s.port
    const base = 'POST ' + s.scope + 'api/v1/bootstrap HTTP/1.1'
    const dupCL = await rawHttp(s.port, base + '\r\n' + H + '\r\nOrigin: ' + s.origin + '\r\nContent-Type: application/json\r\nContent-Length: 2\r\nContent-Length: 2\r\nConnection: close', '{}')
    expect(dupCL.status !== 200 && dupCL.status !== 201).toBe(true)
    const clte = await rawHttp(s.port, base + '\r\n' + H + '\r\nOrigin: ' + s.origin + '\r\nContent-Type: application/json\r\nContent-Length: 2\r\nTransfer-Encoding: chunked\r\nConnection: close', '0\r\n\r\n')
    expect(clte.status !== 200 && clte.status !== 201).toBe(true)
    const dupOrigin = await rawHttp(s.port, base + '\r\n' + H + '\r\nOrigin: ' + s.origin + '\r\nOrigin: ' + s.origin + '\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close', '{}')
    expect(dupOrigin.status).toBe(403)
    const dupCsrf = await rawHttp(s.port, 'POST ' + s.scope + 'api/v1/routes/set HTTP/1.1\r\n' + H + '\r\nOrigin: ' + s.origin + '\r\nContent-Type: application/json\r\nCookie: ' + s.cookie + '\r\nX-Gorouter-Csrf: ' + s.csrf + '\r\nX-Gorouter-Csrf: ' + s.csrf + '\r\nContent-Length: 2\r\nConnection: close', '{}')
    expect(dupCsrf.status).toBe(403)
    expect((await hreq(s.port, 'GET', s.scope + 'api/v1/snapshot', { Cookie: s.cookie })).status).toBe(200)
  })

  test('62: duplicate security-relevant JSON keys reject (no last-key-win)', async () => {
    const f = await fx()
    const s = await openSession(f)
    const gen = (JSON.parse((await hreq(s.port, 'GET', s.scope + 'api/v1/snapshot', { Cookie: s.cookie })).text).snapshot.stateGeneration) as string
    const dupGen = await mut(s, 'routes/clear', '{"stateGeneration":"' + gen + '","stateGeneration":"' + gen + '","lane":"go","expectedRouteVersion":1}', s.csrf)
    expect(dupGen.status).toBe(400)
    const dupBoot = await hreq(s.port, 'POST', s.scope + 'api/v1/bootstrap', { Origin: s.origin, 'Content-Type': 'application/json' }, '{"bootstrap":"x","bootstrap":"y"}')
    expect(dupBoot.status).toBe(400)
  })

  test('63: method-override attempts do not change semantics', async () => {
    const f = await fx()
    const { url } = await f.bridge.open()
    const frag = url.split('#bootstrap=')[1] as string
    const o = f.bridge.origin as string
    const p = portOf(o)
    const sc = f.bridge.scopePath as string
    const r = await hreq(p, 'POST', sc + 'api/v1/bootstrap', { Origin: o, 'Content-Type': 'application/json', 'X-HTTP-Method-Override': 'GET', 'X-Method-Override': 'DELETE' }, JSON.stringify({ bootstrap: frag }))
    expect(r.status).toBe(200)
    const s = await openSession(f)
    const g = await hreq(s.port, 'GET', s.scope + 'api/v1/snapshot', { Cookie: s.cookie, 'X-HTTP-Method-Override': 'POST' })
    expect(g.status).toBe(200)
  })

  test('64: session auth outside the cookie is rejected', async () => {
    const f = await fx()
    const s = await openSession(f)
    expect((await hreq(s.port, 'GET', s.scope + 'api/v1/snapshot?session=' + encodeURIComponent(s.cookie))).status).toBe(401)
    expect((await hreq(s.port, 'GET', s.scope + 'api/v1/snapshot', { Authorization: 'Bearer ' + s.cookie })).status).toBe(401)
    const viaJson = await mut(s, 'routes/clear', JSON.stringify({ stateGeneration: 'g', lane: 'go', expectedRouteVersion: 1, session: s.cookie }), s.csrf)
    expect(viaJson.status === 400 || viaJson.status === 401).toBe(true)
    const withHeader = await mut(s, 'routes/clear', JSON.stringify({ stateGeneration: 'g', lane: 'go', expectedRouteVersion: 1 }), s.csrf, { Authorization: 'Bearer x' })
    expect(withHeader.status).toBe(400)
  })

  test('65: unknown semantic fields reject', async () => {
    const f = await fx()
    const s = await openSession(f)
    expect((await mut(s, 'routes/clear', '{"stateGeneration":"g","lane":"go","expectedRouteVersion":1,"extra":1}', s.csrf)).status).toBe(400)
    const b = await hreq(s.port, 'POST', s.scope + 'api/v1/bootstrap', { Origin: s.origin, 'Content-Type': 'application/json' }, '{"bootstrap":"x","extra":1}')
    expect(b.status).toBe(400)
  })

  test('66: 16 KiB body cap (limit passes, over-cap 413, bounded)', async () => {
    const f = await fx()
    const s = await openSession(f)
    const gen = (JSON.parse((await hreq(s.port, 'GET', s.scope + 'api/v1/snapshot', { Cookie: s.cookie })).text).snapshot.stateGeneration) as string
    const pad = (n: number): string => 'p'.repeat(n)
    const mkBody = (aliasLen: number): string => JSON.stringify({ stateGeneration: gen, alias: pad(aliasLen), secret: 'w1d-canary-secret-66' })
    let lo = 0
    let hi = 20000
    while (hi - lo > 64) {
      const mid = Math.floor((lo + hi) / 2)
      if (Buffer.byteLength(mkBody(mid), 'utf8') <= 16384) lo = mid
      else hi = mid
    }
    const atLimit = await mut(s, 'accounts/add', mkBody(lo), s.csrf)
    expect(atLimit.status).not.toBe(413)
    const over = await mut(s, 'accounts/add', mkBody(hi + 512), s.csrf)
    expect(over.status).toBe(413)
    expect((await hreq(s.port, 'GET', s.scope + 'api/v1/snapshot', { Cookie: s.cookie })).status).toBe(200)
  })

  test('67: query-string mutation attempts reject', async () => {
    const f = await fx()
    const s = await openSession(f)
    expect((await hreq(s.port, 'POST', s.scope + 'api/v1/routes/clear?a=b', { Origin: s.origin, 'Content-Type': 'application/json', Cookie: s.cookie, 'x-gorouter-csrf': s.csrf }, '{}')).status).toBe(400)
    expect((await hreq(s.port, 'POST', s.scope + 'api/v1/logout?a=b', { Origin: s.origin, Cookie: s.cookie, 'x-gorouter-csrf': s.csrf })).status).toBe(400)
  })

  test('68: account secret outside the JSON body rejects, nothing created', async () => {
    const f = await fx()
    const s = await openSession(f)
    const gen = (JSON.parse((await hreq(s.port, 'GET', s.scope + 'api/v1/snapshot', { Cookie: s.cookie })).text).snapshot.stateGeneration) as string
    const before = (JSON.parse((await hreq(s.port, 'GET', s.scope + 'api/v1/snapshot', { Cookie: s.cookie })).text).snapshot.accounts as unknown[]).length
    const q = await hreq(s.port, 'POST', s.scope + 'api/v1/accounts/add?secret=w1d-canary-68', { Origin: s.origin, 'Content-Type': 'application/json', Cookie: s.cookie, 'x-gorouter-csrf': s.csrf }, JSON.stringify({ stateGeneration: gen, alias: 'q-alias', secret: 'w1d-canary-68-body' }))
    expect(q.status === 400 || q.status === 415).toBe(true)
    const c = await hreq(s.port, 'POST', s.scope + 'api/v1/accounts/add', { Origin: s.origin, 'Content-Type': 'application/json', Cookie: s.cookie + '; secret=w1d-canary-68-cookie', 'x-gorouter-csrf': s.csrf }, JSON.stringify({ stateGeneration: gen, alias: 'c-alias', secret: 'w1d-canary-68-body' }))
    expect(c.status).toBe(400)
    const after = (JSON.parse((await hreq(s.port, 'GET', s.scope + 'api/v1/snapshot', { Cookie: s.cookie })).text).snapshot.accounts as unknown[]).length
    expect(after).toBe(before)
  })

  test('69: HTML carries required hardening headers', async () => {
    const f = await fx()
    await f.bridge.open()
    const o = f.bridge.origin as string
    const r = await hreq(portOf(o), 'GET', f.bridge.scopePath as string)
    expect(r.status).toBe(200)
    const csp = (r.headers.get('content-security-policy') || []).join(' ')
    for (const d of ["default-src 'self'", "script-src 'self'", "style-src 'self'", "connect-src 'self'", "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'", "form-action 'self'"]) expect(csp.indexOf(d)).not.toBe(-1)
    expect((r.headers.get('referrer-policy') || []).join('')).toBe('no-referrer')
    expect((r.headers.get('x-content-type-options') || []).join('')).toBe('nosniff')
    expect((r.headers.get('x-frame-options') || []).join('')).toBe('DENY')
    expect((r.headers.get('cross-origin-opener-policy') || []).join('')).toBe('same-origin')
    expect((r.headers.get('cross-origin-resource-policy') || []).join('')).toBe('same-origin')
    expect(((r.headers.get('permissions-policy') || []).join('')).length > 0).toBe(true)
  })

  test('70: every response is no-store/safe-type/nosniff/CORP with no banner', async () => {
    const f = await fx()
    const s = await openSession(f)
    const samples: Resp[] = []
    samples.push(await hreq(s.port, 'GET', s.scope))
    samples.push(await hreq(s.port, 'GET', s.scope + 'assets/app.js'))
    samples.push(await hreq(s.port, 'GET', s.scope + 'api/v1/snapshot', { Cookie: s.cookie }))
    samples.push(await hreq(s.port, 'GET', s.scope + 'nope'))
    samples.push(await mut(s, 'routes/set', '{}', s.csrf))
    for (const r of samples) {
      expect((r.headers.get('cache-control') || []).join('')).toBe('no-store')
      expect((r.headers.get('x-content-type-options') || []).join('')).toBe('nosniff')
      expect((r.headers.get('cross-origin-resource-policy') || []).join('')).toBe('same-origin')
      expect((r.headers.get('content-type') || []).length).toBe(1)
      expect(r.headers.has('server')).toBe(false)
      expect(r.headers.has('x-powered-by')).toBe(false)
    }
  })

  test('71: CSP has no unsafe-inline and no remote/CDN', async () => {
    const f = await fx()
    await f.bridge.open()
    const o = f.bridge.origin as string
    const r = await hreq(portOf(o), 'GET', f.bridge.scopePath as string)
    const csp = (r.headers.get('content-security-policy') || []).join(' ')
    expect(csp.indexOf('unsafe-inline')).toBe(-1)
    expect(csp.indexOf('unsafe-eval')).toBe(-1)
    expect(csp.indexOf('http://')).toBe(-1)
    expect(csp.indexOf('https://')).toBe(-1)
    expect(csp.indexOf('data:')).toBe(-1)
  })

  test('72+73: no storage/service-worker/sourcemap/dev metadata in W1 client', () => {
    for (const token of ['localStorage', 'sessionStorage', 'IndexedDB', 'serviceWorker', 'sourceMappingURL', 'sourceMap']) {
      expect(APP_JS.indexOf(token)).toBe(-1)
      expect(BOOTSTRAP_SHIM_JS.indexOf(token)).toBe(-1)
      expect(renderIndexHtml().indexOf(token)).toBe(-1)
    }
  })

  test('74: data-derived text uses safe sinks only; hostile input stays inert', async () => {
    for (const sink of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write']) expect(APP_JS.indexOf(sink)).toBe(-1)
    expect(/[^A-Za-z]eval\s*\(/.test(APP_JS)).toBe(false)
    expect(APP_JS.indexOf('new Function')).toBe(-1)
    expect(APP_JS.indexOf('textContent')).not.toBe(-1)
    // Stored aliases cannot carry markup at all (charset allowlist).
    const { validateAlias } = await import('../src/state.ts')
    for (const evil of ['<img src=x onerror=alert(1)>', '"><script>alert(1)</script>', "';alert(1);//", '&quot;', '${7*7}', '{{x}}']) {
      expect(validateAlias(evil)).not.toBeNull()
    }
    expect(validateAlias('plain.alias-1_2')).toBeNull()
    // Hostile alias submitted through the browser fails as JSON (never HTML).
    const f = await fx()
    const s = await openSession(f)
    const gen = (JSON.parse((await hreq(s.port, 'GET', s.scope + 'api/v1/snapshot', { Cookie: s.cookie })).text).snapshot.stateGeneration) as string
    const evil = await mut(s, 'accounts/add', JSON.stringify({ stateGeneration: gen, alias: '<img src=x onerror=alert(1)>', secret: 'w1d-canary-74' }), s.csrf)
    expect(evil.status).toBe(400)
    expect((evil.headers.get('content-type') || []).join('').indexOf('application/json')).not.toBe(-1)
  })

  test('75: browser API version is explicit; unknown versions fail closed', async () => {
    const f = await fx()
    const s = await openSession(f)
    for (const t of ['api/v2/snapshot', 'api/v1', 'api/', 'api', 'API/V1/snapshot']) {
      expect((await hreq(s.port, 'GET', s.scope + t, { Cookie: s.cookie })).status).toBe(404)
    }
  })

  test('76: no generic browser op tunnel exists', async () => {
    const f = await fx()
    const s = await openSession(f)
    for (const t of ['api/v1/op', 'api/v1/exec', 'api/v1/router.start', 'api/v1/call']) {
      const r = await mut(s, t, JSON.stringify({ op: 'router.start', params: {} }), s.csrf)
      expect(r.status).toBe(404)
    }
    expect((JSON.parse((await hreq(s.port, 'GET', s.scope + 'api/v1/snapshot', { Cookie: s.cookie })).text).snapshot.router.state)).toBe('stopped')
  })

  test('77: no HTTP endpoint mints a bootstrap capability', async () => {
    const f = await fx()
    const s = await openSession(f)
    const paths = ['api/v1/snapshot', 'api/v1/session', 'api/v1/routes/set', 'api/v1/accounts/add', 'api/v1/logout', 'api/v1/bootstrap']
    for (const t of paths) {
      const r = await mut(s, t, '{}', s.csrf)
      expect(r.text.indexOf('#bootstrap=')).toBe(-1)
      // Failing posts never mint sessions: no Set-Cookie anywhere here.
      expect((r.headers.get('set-cookie') || []).length).toBe(0)
    }
  })

  test('78: snapshot is the explicit DTO assembled from current state', async () => {
    const f = await fx()
    const s = await openSession(f)
    const first = JSON.parse((await hreq(s.port, 'GET', s.scope + 'api/v1/snapshot', { Cookie: s.cookie })).text).snapshot
    const keys = Object.keys(first).sort()
    expect(keys).toEqual(['accounts', 'desktop', 'desktopUnsupportedVersion', 'firstRun', 'initialized', 'localCredentialConfigured', 'router', 'routes', 'secretStore', 'serviceVersion', 'settings', 'stateCorrupt', 'stateGeneration', 'stateUnsupportedVersion'])
    const gen = f.domain.ensureState().stateGeneration
    f.domain.accountAddChecked('dto-fresh', 'w1d-canary-78', { expectedStateGeneration: gen })
    const second = JSON.parse((await hreq(s.port, 'GET', s.scope + 'api/v1/snapshot', { Cookie: s.cookie })).text).snapshot
    expect((second.accounts as unknown[]).length).toBe((first.accounts as unknown[]).length + 1)
  })

  test('79+80: DTO omits paths/pid/secrets/tails/refs', async () => {
    const f = await fx()
    const gen = f.domain.ensureState().stateGeneration
    f.domain.accountAddChecked('dto-secret', 'w1d-canary-7980', { expectedStateGeneration: gen })
    const s = await openSession(f)
    const r = await hreq(s.port, 'GET', s.scope + 'api/v1/snapshot', { Cookie: s.cookie })
    expect(r.text.indexOf('stateDir')).toBe(-1)
    expect(r.text.indexOf(f.dir)).toBe(-1)
    expect(r.text.indexOf('"pid"')).toBe(-1)
    expect(r.text.indexOf('secretRef')).toBe(-1)
    expect(r.text.indexOf('w1d-canary-7980')).toBe(-1)
    expect(r.text.indexOf('sec_desktop_admin')).toBe(-1)
    const snap = JSON.parse(r.text).snapshot
    expect(snap.accounts[0].secretPresent).toBe(true)
    expect(typeof snap.localCredentialConfigured).toBe('boolean')
  })

  test('81: no router start/stop/restart HTTP endpoint', async () => {
    const f = await fx()
    const s = await openSession(f)
    for (const t of ['router/start', 'router/stop', 'router/restart']) {
      expect((await mut(s, t, '{}', s.csrf)).status).toBe(404)
    }
    expect((JSON.parse((await hreq(s.port, 'GET', s.scope + 'api/v1/snapshot', { Cookie: s.cookie })).text).snapshot.router.state)).toBe('stopped')
  })

  test('82: account.test has no browser endpoint (zero provider calls)', async () => {
    const f = await fx()
    const s = await openSession(f)
    for (const t of ['account/test', 'accounts/test']) {
      expect((await mut(s, t, '{}', s.csrf)).status).toBe(404)
    }
    expect(externalFetches).toEqual([])
  })

  test('83: localCred.once has no browser endpoint', async () => {
    const f = await fx()
    const s = await openSession(f)
    for (const t of ['localcred/once', 'local-cred', 'localcred.once']) {
      expect((await mut(s, t, '{}', s.csrf)).status).toBe(404)
    }
  })

  test('84: config.set has no browser endpoint; settings unchanged', async () => {
    const f = await fx()
    const s = await openSession(f)
    const before = (await hreq(s.port, 'GET', s.scope + 'api/v1/snapshot', { Cookie: s.cookie })).text
    expect((await mut(s, 'config/set', JSON.stringify({ key: 'port', value: '9999' }), s.csrf)).status).toBe(404)
    const after = (await hreq(s.port, 'GET', s.scope + 'api/v1/snapshot', { Cookie: s.cookie })).text
    expect(after).toBe(before)
  })

  test('85: model refresh/approval has no browser endpoint', async () => {
    const f = await fx()
    const s = await openSession(f)
    for (const t of ['models/refresh', 'models/approvals/approve', 'models/status']) {
      expect((await mut(s, t, '{}', s.csrf)).status).toBe(404)
    }
  })

  test('86: app exit has no browser endpoint; bridge survives', async () => {
    const f = await fx()
    const s = await openSession(f)
    expect((await mut(s, 'app/exit', '{}', s.csrf)).status).toBe(404)
    expect((await hreq(s.port, 'GET', s.scope + 'api/v1/snapshot', { Cookie: s.cookie })).status).toBe(200)
  })

  test('87: forced removal is rejected even when requested', async () => {
    const f = await fx()
    const gen = f.domain.ensureState().stateGeneration
    const added = f.domain.accountAddChecked('force-victim', 'w1d-canary-87', { expectedStateGeneration: gen })
    const s = await openSession(f)
    const snap = JSON.parse((await hreq(s.port, 'GET', s.scope + 'api/v1/snapshot', { Cookie: s.cookie })).text).snapshot
    const id = (snap.accounts.find((a: { alias: string }) => a.alias === 'force-victim') as { id: string; version: number }).id
    const ver = (snap.accounts.find((a: { alias: string }) => a.alias === 'force-victim') as { id: string; version: number }).version
    void added
    for (const forceBody of [true, false]) {
      const r = await mut(s, 'accounts/remove', JSON.stringify({ stateGeneration: snap.stateGeneration, accountId: id, expectedAccountVersion: ver, force: forceBody }), s.csrf)
      expect(r.status).toBe(403)
    }
    const still = JSON.parse((await hreq(s.port, 'GET', s.scope + 'api/v1/snapshot', { Cookie: s.cookie })).text).snapshot
    expect((still.accounts as { alias: string }[]).some((a) => a.alias === 'force-victim')).toBe(true)
  })

  test('no external fetch occurred in this file', () => {
    expect(externalFetches).toEqual([])
  })
})
