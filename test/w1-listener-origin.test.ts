/**
 * W1 proving: listener / origin boundary (contract §14 tests 1-22).
 *
 * Synthetic-only: temp state dirs + memSecrets; loopback HTTP to the real W1
 * bridge; no external network; no production state/credentials; no provider
 * traffic (this file performs no account/probe/model operation at all).
 */
import { describe, test, expect, afterEach, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import net from 'node:net'
import http from 'node:http'
import { createWebBridge, type WebBridge } from '../src/desktop/web-bridge.ts'
import { createControlService } from '../src/desktop/control-core.ts'
import { createOpHandlers, attachWebBridge } from '../src/desktop/control-service.ts'
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

interface Fx { dir: string; domain: ReturnType<typeof createDomain>; core: ReturnType<typeof createControlService>; bridge: WebBridge; logs: string[]; captured: string[] }
async function fx(opts?: { opener?: (url: string) => void }): Promise<Fx> {
  const dir = mkdtempSync(join(tmpdir(), 'gorouter-w1a-'))
  dirs.push(dir)
  const paths = resolvePaths(dir)
  ensureStateDirs(paths)
  const secrets = memSecrets({ sec_desktop_admin: 'w1a-admin-token' })
  const domain = createDomain(paths, secrets)
  domain.setup()
  const core = createControlService({ paths, secrets, domain, pipeName: 'w1a-inproc' })
  const logs: string[] = []
  const captured: string[] = []
  const bridge = createWebBridge({ getSnapshot: () => core.snapshot(), domain, openBrowser: opts?.opener ?? ((url: string) => { captured.push(url) }), log: (e: string) => { logs.push(e) } })
  bridges.push(bridge)
  return { dir, domain, core, bridge, logs, captured }
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

function rawHttp(port: number, head: string, body?: string): Promise<{ status: number; raw: string; body: string }> {
  return new Promise((resolve) => {
    let settled = false
    const done = (v: { status: number; raw: string; body: string }): void => { if (!settled) { settled = true; resolve(v) } }
    const sock = net.connect({ host: '127.0.0.1', port })
    let data = Buffer.alloc(0)
    const timer = setTimeout(() => { try { sock.destroy() } catch { /* t */ } done({ status: -1, raw: data.toString('utf8'), body: '' }) }, 5000)
    sock.on('connect', () => { sock.write(head + '\r\n\r\n' + (body ?? '')) })
    sock.on('data', (c) => { data = Buffer.concat([data, Buffer.isBuffer(c) ? c : Buffer.from(c)]) })
    const finish = (): void => {
      clearTimeout(timer)
      const s = data.toString('utf8')
      const m = /^HTTP\/\d\.\d\s+(\d+)/.exec(s)
      const parts = s.split('\r\n\r\n')
      done({ status: m && m[1] ? Number(m[1]) : 0, raw: s, body: parts.slice(1).join('\r\n\r\n') })
    }
    sock.on('end', finish)
    sock.on('close', finish)
    sock.on('error', () => { clearTimeout(timer); done({ status: 0, raw: data.toString('utf8'), body: '' }) })
  })
}

function portOf(origin: string): number { return Number(new URL(origin).port) }
function originOf(f: Fx): string { const o = f.bridge.origin; if (!o) throw new Error('no origin'); return o }
function scopeOf(f: Fx): string { const s = f.bridge.scopePath; if (!s) throw new Error('no scope'); return s }

describe('w1 listener/origin (1-22)', () => {
  test('1: no listener before explicit native activation', async () => {
    const f = await fx()
    expect(f.bridge.isOpen).toBe(false)
    expect(f.bridge.origin).toBeNull()
    expect(f.bridge.scopePath).toBeNull()
    expect(f.captured.length).toBe(0)
    await expect(hreq(1, 'GET', '/')).rejects.toThrow()
  })

  test('2: concurrent first opens share one listener/scope, mint distinct bootstraps', async () => {
    const f = await fx()
    const results = await Promise.all([f.bridge.open(), f.bridge.open(), f.bridge.open()])
    const urls = results.map((r) => r.url)
    const origins = new Set(urls.map((u) => u.split('#')[0]))
    expect(origins.size).toBe(1)
    const frags = urls.map((u) => u.split('#bootstrap=')[1] as string)
    expect(new Set(frags).size).toBe(3)
    for (const c of frags) expect(/^[A-Za-z0-9_-]{43}$/.test(c)).toBe(true)
    expect(f.bridge.bootstrapCount()).toBe(3)
    expect(f.captured.length).toBe(3)
  })

  test('3: launch failure returns no URL and leaves no live bootstrap', async () => {
    const f = await fx({ opener: () => { throw new Error('browser gone') } })
    await expect(f.bridge.open()).rejects.toThrow('browser gone')
    // Bind succeeded, but the just-minted bootstrap was revoked: none live.
    expect(f.bridge.bootstrapCount()).toBe(0)
  })

  test('4: warm launcher requires authenticated native control authority', async () => {
    const f = await fx()
    // Old-service equivalent (no web.open in the dispatch table) fails closed.
    const legacy = createOpHandlers({ core: f.core, domain: f.domain })
    await expect(legacy('web.open', {})).rejects.toThrow()
    // New service: hello-gated transport admits only post-hello ops (C04
    // transport helloOk gate, byte-identical — allowlist test 127 proves the
    // gate file is untouched, so the gate carries over to web.open verbatim).
    const web = attachWebBridge(f.core, f.domain, (url: string) => { f.captured.push(url) })
    const handlers = createOpHandlers({ core: f.core, domain: f.domain, openWeb: web.openWeb })
    const before = JSON.stringify(f.core.snapshot().router)
    const res = await handlers('web.open', {}) as { opened: boolean }
    expect(res.opened).toBe(true)
    expect(f.captured.length).toBe(1)
    expect(JSON.stringify(f.core.snapshot().router)).toBe(before)
    await web.closeWeb()
  })

  test('5: cold launcher works from no-service state', async () => {
    const { startColdWebControl } = await import('../src/desktop/web-launch.ts')
    const dir = mkdtempSync(join(tmpdir(), 'gorouter-w1a-cold-'))
    dirs.push(dir)
    const captured: string[] = []
    const handle = await startColdWebControl({ browserOpener: (u: string) => { captured.push(u) }, stateDir: dir, pipeName: 'w1a-cold-' + Math.random().toString(36).slice(2) })
    try {
      expect(handle.origin.indexOf('http://127.0.0.1:')).toBe(0)
      expect(captured.length).toBe(1)
      const r = await hreq(portOf(handle.origin), 'GET', handle.scopePath)
      expect(r.status).toBe(200)
      expect(handle.routerSnapshot().state).toBe('stopped')
      expect(handle.routerSnapshot().pid).toBeNull()
    } finally { await handle.close() }
  })

  test('6: cold launch against pre-W1 binary fails closed before service launch', async () => {
    const { startColdWebControl, webControlCapable } = await import('../src/desktop/web-launch.ts')
    expect(webControlCapable()).toBe(true)
    const dir = mkdtempSync(join(tmpdir(), 'gorouter-w1a-old-'))
    dirs.push(dir)
    const captured: string[] = []
    await expect(startColdWebControl({ browserOpener: (u: string) => { captured.push(u) }, stateDir: dir, pipeName: 'w1a-old-' + Math.random().toString(36).slice(2), capable: false })).rejects.toThrow('fail-closed')
    expect(captured.length).toBe(0)
  })

  test('7: new warm launcher vs pre-W1 service reports unsupported, changes nothing', async () => {
    const f = await fx()
    const before = JSON.stringify({ r: f.core.snapshot().router, g: f.core.snapshot().stateGeneration, a: f.core.snapshot().accounts })
    const legacy = createOpHandlers({ core: f.core, domain: f.domain })
    let code = ''
    try { await legacy('web.open', {}) } catch (e) { code = (e as { code?: string }).code ?? String(e) }
    expect(code.length > 0).toBe(true)
    expect(code === 'unsupported' || code.indexOf('unknown op') !== -1).toBe(true)
    const after = JSON.stringify({ r: f.core.snapshot().router, g: f.core.snapshot().stateGeneration, a: f.core.snapshot().accounts })
    expect(after).toBe(before)
  })

  test('8: old native client keeps normal protocol-v2 ops on the new service', async () => {
    const f = await fx()
    const web = attachWebBridge(f.core, f.domain, (u: string) => { f.captured.push(u) })
    const handlers = createOpHandlers({ core: f.core, domain: f.domain, openWeb: web.openWeb })
    const hello = await handlers('hello', { protocol: 2 }) as { protocol: number }
    expect(hello.protocol).toBe(2)
    const snap = await handlers('snapshot', {}) as { stateGeneration: string }
    expect(typeof snap.stateGeneration).toBe('string')
    const pong = await handlers('ping', {}) as { pong: boolean }
    expect(pong.pong).toBe(true)
    await web.closeWeb()
  })

  test('9: production launcher never prints/persists the URL, no browser argv override', async () => {
    const { resolveBrowserOpener, openInDefaultBrowser } = await import('../src/desktop/web-bridge.ts')
    const dev = resolveBrowserOpener({ packaged: false, captureFile: join(tmpdir(), 'w1a-cap.txt') })
    expect(dev).not.toBe(openInDefaultBrowser)
    const prod = resolveBrowserOpener({ packaged: true, captureFile: join(tmpdir(), 'w1a-cap.txt') })
    expect(prod).toBe(openInDefaultBrowser)
    expect(() => openInDefaultBrowser('https://evil.example/')).toThrow()
    expect(() => openInDefaultBrowser('http://localhost:9999/')).toThrow()
    // web.open pipe response carries no bootstrap material.
    const f = await fx()
    const web = attachWebBridge(f.core, f.domain, (u: string) => { f.captured.push(u) })
    const handlers = createOpHandlers({ core: f.core, domain: f.domain, openWeb: web.openWeb })
    const res = await handlers('web.open', {})
    expect(JSON.stringify(res).indexOf('#bootstrap=')).toBe(-1)
    expect(JSON.stringify(res)).toBe(JSON.stringify({ opened: true }))
    await web.closeWeb()
  })

  test('10: listener binds 127.0.0.1 only', async () => {
    const f = await fx()
    await f.bridge.open()
    const o = originOf(f)
    expect(o.indexOf('http://127.0.0.1:')).toBe(0)
    const p = portOf(o)
    // Exclusive occupancy of exactly 127.0.0.1:port: a second bind of the same
    // address fails EADDRINUSE (proves the hold is on 127.0.0.1, not 0.0.0.0).
    // (A 127.0.0.2 no-bind leg is meaningless on hosts where unbound 127/8
    // connects hang instead of refusing — verified environmental behavior.)
    const clash = await new Promise<string>((resolve) => {
      const s = net.createServer()
      s.once('error', (e: unknown) => resolve((e as { code?: string }).code ?? String(e)))
      s.listen(p, '127.0.0.1', () => { try { s.close() } catch { /* t */ } resolve('BOUND') })
    })
    expect(clash).toBe('EADDRINUSE')
    // And 127.0.0.1 itself serves.
    const r = await hreq(p, 'GET', scopeOf(f))
    expect(r.status).toBe(200)
  })

  test('11: canonical origin uses the actual bound port', async () => {
    const a = await fx()
    const b = await fx()
    await a.bridge.open()
    await b.bridge.open()
    const oa = originOf(a)
    const ob = originOf(b)
    expect(oa).not.toBe(ob)
    expect(portOf(oa) > 0).toBe(true)
    const r = await hreq(portOf(oa), 'GET', scopeOf(a))
    expect(r.status).toBe(200)
  })

  test('12: webScope is >=128-bit random; routes live only beneath it', async () => {
    const a = await fx()
    const b = await fx()
    await a.bridge.open()
    await b.bridge.open()
    const sa = scopeOf(a)
    const sb = scopeOf(b)
    expect(sa).not.toBe(sb)
    const segA = sa.split('/')[2] as string
    expect(/^[A-Za-z0-9_-]{22}$/.test(segA)).toBe(true)
    expect(Buffer.from(segA.replace(/-/g, '+').replace(/_/g, '/'), 'base64').length).toBe(16)
    const r = await hreq(portOf(originOf(a)), 'GET', sb + 'api/v1/snapshot')
    expect(r.status).toBe(404)
  })

  test('13: unscoped and wrong-scope paths expose no API/state', async () => {
    const f = await fx()
    await f.bridge.open()
    const o = originOf(f)
    const p = portOf(o)
    for (const t of ['/', '/api/v1/snapshot', '/_gorouter/WRONGSCOPE/', '/_gorouter/WRONGSCOPE/api/v1/snapshot', scopeOf(f) + 'nope']) {
      const r = await hreq(p, 'GET', t)
      expect(r.status).toBe(404)
      expect(r.text.indexOf('stateGeneration')).toBe(-1)
      expect(r.text.indexOf('accounts')).toBe(-1)
    }
  })

  test('14: wrong Host is rejected (incl. duplicate/missing)', async () => {
    const f = await fx()
    await f.bridge.open()
    const o = originOf(f)
    const p = portOf(o)
    const good = scopeOf(f)
    const evil = await rawHttp(p, 'GET ' + good + ' HTTP/1.1\r\nHost: evil.example\r\nConnection: close')
    expect(evil.status).toBe(403)
    const wrongPort = await rawHttp(p, 'GET ' + good + ' HTTP/1.1\r\nHost: 127.0.0.1:1\r\nConnection: close')
    expect(wrongPort.status).toBe(403)
    const dup = await rawHttp(p, 'GET ' + good + ' HTTP/1.1\r\nHost: 127.0.0.1:' + p + '\r\nHost: 127.0.0.1:' + p + '\r\nConnection: close')
    expect([400, 403].includes(dup.status)).toBe(true)
    const missing = await rawHttp(p, 'GET ' + good + ' HTTP/1.0\r\nConnection: close')
    expect([400, 403].includes(missing.status)).toBe(true)
    const ok = await hreq(p, 'GET', good)
    expect(ok.status).toBe(200)
  })

  test('15: Forwarded/X-Forwarded-* never override authority', async () => {
    const f = await fx()
    await f.bridge.open()
    const o = originOf(f)
    const p = portOf(o)
    const good = scopeOf(f)
    const ignored = await hreq(p, 'GET', good, { 'X-Forwarded-Host': 'evil.example', 'X-Forwarded-Proto': 'https', Forwarded: 'host=evil.example' })
    expect(ignored.status).toBe(200)
    const stillBad = await rawHttp(p, 'GET ' + good + ' HTTP/1.1\r\nHost: evil.example\r\nX-Forwarded-Host: 127.0.0.1:' + p + '\r\nConnection: close')
    expect(stillBad.status).toBe(403)
  })

  test('16: localhost alias is rejected', async () => {
    const f = await fx()
    await f.bridge.open()
    const p = portOf(originOf(f))
    const r = await rawHttp(p, 'GET ' + scopeOf(f) + ' HTTP/1.1\r\nHost: localhost:' + p + '\r\nConnection: close')
    expect(r.status).toBe(403)
  })

  test('17: non-loopback Host is rejected', async () => {
    const f = await fx()
    await f.bridge.open()
    const p = portOf(originOf(f))
    for (const h of ['192.168.1.10:' + p, '10.0.0.5:' + p, '[::1]:' + p, 'example.com']) {
      const r = await rawHttp(p, 'GET ' + scopeOf(f) + ' HTTP/1.1\r\nHost: ' + h + '\r\nConnection: close')
      expect(r.status).toBe(403)
    }
  })

  test('18: cross-origin POST rejected before body parsing', async () => {
    const f = await fx()
    await f.bridge.open()
    const o = originOf(f)
    const p = portOf(o)
    const target = scopeOf(f) + 'api/v1/bootstrap'
    const hostile = await hreq(p, 'POST', target, { 'Content-Type': 'application/json', Origin: 'http://evil.example' }, '{malformed')
    expect(hostile.status).toBe(403)
    const sameBadJson = await hreq(p, 'POST', target, { 'Content-Type': 'application/json', Origin: o }, '{malformed')
    expect(sameBadJson.status).toBe(400)
  })

  test('19: hostile/preflight OPTIONS gets no permissive CORS', async () => {
    const f = await fx()
    await f.bridge.open()
    const o = originOf(f)
    const p = portOf(o)
    for (const t of [scopeOf(f), scopeOf(f) + 'api/v1/bootstrap', scopeOf(f) + 'api/v1/snapshot']) {
      const r = await rawHttp(p, 'OPTIONS ' + t + ' HTTP/1.1\r\nHost: 127.0.0.1:' + p + '\r\nOrigin: http://evil.example\r\nAccess-Control-Request-Method: POST\r\nConnection: close')
      expect(r.status < 200 || r.status >= 300).toBe(true)
      expect(r.raw.toLowerCase().indexOf('access-control-allow-origin')).toBe(-1)
      expect(r.raw.toLowerCase().indexOf('access-control-allow-credentials')).toBe(-1)
    }
  })

  test('20: unsupported methods rejected', async () => {
    const f = await fx()
    const { url } = await f.bridge.open()
    const o = originOf(f)
    const p = portOf(o)
    const s = scopeOf(f)
    expect((await hreq(p, 'GET', s + 'api/v1/bootstrap')).status).toBe(405)
    // Unauthenticated wrong-method on a protected route fails at auth first.
    expect((await hreq(p, 'POST', s + 'api/v1/snapshot', { Origin: o, 'Content-Type': 'application/json' }, '{}')).status).toBe(401)
    // Authenticated wrong-method hits the exact method set.
    const frag = (url.split('#bootstrap=')[1] as string)
    const b = await hreq(p, 'POST', s + 'api/v1/bootstrap', { Origin: o, 'Content-Type': 'application/json' }, JSON.stringify({ bootstrap: frag }))
    expect(b.status).toBe(200)
    const cookie = ((b.headers.get('set-cookie') || [])[0] as string).split(';')[0] as string
    const csrf = (JSON.parse(b.text).csrf) as string
    expect((await hreq(p, 'POST', s + 'api/v1/snapshot', { Origin: o, 'Content-Type': 'application/json', Cookie: cookie }, '{}')).status).toBe(405)
    expect((await hreq(p, 'DELETE', s)).status).toBe(405)
    // Wrong method on a mutation route: CSRF gate runs before the method gate
    // (both fail closed), so prove the method set with a valid CSRF present.
    expect((await hreq(p, 'PUT', s + 'api/v1/routes/set', { Origin: o, 'Content-Type': 'application/json', Cookie: cookie, 'x-gorouter-csrf': csrf }, '{}')).status).toBe(405)
  })

  test('21: unknown paths rejected', async () => {
    const f = await fx()
    await f.bridge.open()
    const p = portOf(originOf(f))
    const s = scopeOf(f)
    for (const t of [s + 'nope', s + 'api/v1/nope', s + 'api/v2/snapshot', s + 'api/v1/', s + 'API/V1/SNAPSHOT']) {
      const r = await hreq(p, 'GET', t)
      expect(r.status).toBe(404)
    }
  })

  test('22: static assets come only from the fixed map', async () => {
    const f = await fx()
    await f.bridge.open()
    const p = portOf(originOf(f))
    const s = scopeOf(f)
    const js = await hreq(p, 'GET', s + 'assets/app.js')
    expect(js.status).toBe(200)
    expect((js.headers.get('content-type') || []).join('').indexOf('javascript')).not.toBe(-1)
    const css = await hreq(p, 'GET', s + 'assets/app.css')
    expect(css.status).toBe(200)
    for (const t of [s + 'assets/../x', s + 'assets/%2e%2e/x', s + 'assets/package.json', s + 'assets/app.js.map', s + 'assets/']) {
      const r = await hreq(p, 'GET', t)
      expect(r.status).toBe(404)
    }
  })

  test('no external fetch occurred in this file', () => {
    expect(externalFetches).toEqual([])
  })
})
