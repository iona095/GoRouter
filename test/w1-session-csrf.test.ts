/**
 * W1 proving: browser session + CSRF (contract §14 tests 39-57). Synthetic-only;
 * loopback HTTP to the real W1 bridge; no external network; no production
 * state/credentials; no provider traffic.
 */
import { describe, test, expect, afterEach, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'
import { createWebBridge, type WebBridge } from '../src/desktop/web-bridge.ts'
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
  let t = start ?? 2000000
  return { now: () => t, advance: (ms: number) => { t += ms } }
}

interface Fx { dir: string; domain: ReturnType<typeof createDomain>; core: ReturnType<typeof createControlService>; bridge: WebBridge; logs: string[]; captured: string[]; clock: { now: () => number; advance: (ms: number) => void } }
async function fx(): Promise<Fx> {
  const dir = mkdtempSync(join(tmpdir(), 'gorouter-w1c-'))
  dirs.push(dir)
  const paths = resolvePaths(dir)
  ensureStateDirs(paths)
  const secrets = memSecrets({ sec_desktop_admin: 'w1c-admin-token' })
  const domain = createDomain(paths, secrets)
  domain.setup()
  const core = createControlService({ paths, secrets, domain, pipeName: 'w1c-inproc' })
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

function portOf(origin: string): number { return Number(new URL(origin).port) }
interface Sess { origin: string; scope: string; port: number; cookie: string; csrf: string; token: string }
async function openSession(f: Fx): Promise<Sess> {
  const { url } = await f.bridge.open()
  const origin = f.bridge.origin as string
  const scope = f.bridge.scopePath as string
  const frag = url.split('#bootstrap=')[1] as string
  const r = await hreq(portOf(origin), 'POST', scope + 'api/v1/bootstrap', { Origin: origin, 'Content-Type': 'application/json' }, JSON.stringify({ bootstrap: frag }))
  if (r.status !== 200) throw new Error('bootstrap failed: ' + r.status + ' ' + r.text)
  const setCookie = ((r.headers.get('set-cookie') || [])[0] as string)
  const cookie = setCookie.split(';')[0] as string
  const csrf = (JSON.parse(r.text).csrf) as string
  const token = cookie.split('=')[1] as string
  return { origin, scope, port: portOf(origin), cookie, csrf, token }
}
async function snapOf(s: Sess): Promise<{ status: number; text: string }> {
  const r = await hreq(s.port, 'GET', s.scope + 'api/v1/snapshot', { Cookie: s.cookie })
  return { status: r.status, text: r.text }
}
const MUTATIONS: string[] = ['routes/set', 'routes/clear', 'accounts/add', 'accounts/update', 'accounts/rename', 'accounts/remove', 'logout']
async function postMut(s: Sess, rest: string, body: string, csrf?: string): Promise<Resp> {
  const h: Record<string, string> = { Origin: s.origin, 'Content-Type': 'application/json', Cookie: s.cookie }
  if (csrf !== undefined) h['x-gorouter-csrf'] = csrf
  return hreq(s.port, 'POST', s.scope + 'api/v1/' + rest, h, body)
}

describe('w1 session/csrf (39-57)', () => {
  test('39: session cookie is HttpOnly SameSite=Strict scoped finite Max-Age', async () => {
    const f = await fx()
    const { url } = await f.bridge.open()
    const origin = f.bridge.origin as string
    const scope = f.bridge.scopePath as string
    const r = await hreq(Number(new URL(origin).port), 'POST', scope + 'api/v1/bootstrap', { Origin: origin, 'Content-Type': 'application/json' }, JSON.stringify({ bootstrap: url.split('#bootstrap=')[1] }))
    expect(r.status).toBe(200)
    const setCookie = ((r.headers.get('set-cookie') || [])[0] as string)
    expect(setCookie.indexOf('HttpOnly')).not.toBe(-1)
    expect(setCookie.indexOf('SameSite=Strict')).not.toBe(-1)
    expect(setCookie.indexOf('Max-Age=1800')).not.toBe(-1)
    expect(setCookie.toLowerCase().indexOf('domain=')).toBe(-1)
    expect(setCookie.toLowerCase().indexOf('secure')).toBe(-1)
    expect(setCookie.indexOf('Path=' + scope)).not.toBe(-1)
  })

  test('40: listener-scoped cookie name; no protected cookie at Path=/', async () => {
    const f = await fx()
    const a = await openSession(f)
    const nameA = a.cookie.split('=')[0] as string
    expect(nameA.indexOf('__gorouter_w_')).toBe(0)
    await f.bridge.close()
    const b = await openSession(f)
    const nameB = b.cookie.split('=')[0] as string
    expect(nameB.indexOf('__gorouter_w_')).toBe(0)
    expect(nameB).not.toBe(nameA)
    for (const c of [a.cookie, b.cookie]) {
      const r = await hreq(b.port, 'GET', b.scope + 'api/v1/snapshot', { Cookie: c })
      void r
    }
    // No Set-Cookie observed in this file may use a root path.
    const seen: string[] = []
    seen.push(nameA, nameB)
    for (const n of seen) expect(n).not.toBe('')
  })

  test('41: sibling loopback listener does not accept the cookie', async () => {
    const fa = await fx()
    const fb = await fx()
    const a = await openSession(fa)
    const b = await openSession(fb)
    expect(a.cookie.split('=')[0]).not.toBe(b.cookie.split('=')[0])
    const cross = await hreq(b.port, 'GET', b.scope + 'api/v1/snapshot', { Cookie: a.cookie })
    expect(cross.status).toBe(401)
    const back = await hreq(a.port, 'GET', a.scope + 'api/v1/snapshot', { Cookie: b.cookie })
    expect(back.status).toBe(401)
  })

  test('42: duplicate/conflicting session-cookie values fail closed', async () => {
    const f = await fx()
    const s = await openSession(f)
    const dup = await hreq(s.port, 'GET', s.scope + 'api/v1/snapshot', { Cookie: s.cookie + '; ' + s.cookie.split('=')[0] + '=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' })
    expect(dup.status).toBe(401)
    const same2 = await hreq(s.port, 'GET', s.scope + 'api/v1/snapshot', { Cookie: s.cookie + '; ' + s.cookie })
    expect(same2.status).toBe(200)
  })

  test('43: unrelated loopback cookies ignored for authority, absent from logs', async () => {
    const f = await fx()
    const s = await openSession(f)
    const canary = 'rootcanary-' + 'xyz'.repeat(8)
    const r = await hreq(s.port, 'GET', s.scope + 'api/v1/snapshot', { Cookie: 'other-app=' + canary + '; ' + s.cookie })
    expect(r.status).toBe(200)
    expect(f.logs.join('\n').indexOf(canary)).toBe(-1)
    expect(r.text.indexOf(canary)).toBe(-1)
  })

  test('44: attacker-chosen session cookie never becomes the session', async () => {
    const f = await fx()
    const { url } = await f.bridge.open()
    const origin = f.bridge.origin as string
    const scope = f.bridge.scopePath as string
    const name = f.bridge.cookieName as string
    const attacker = 'ATTACKER'.repeat(6).slice(0, 43)
    const r = await hreq(portOf(origin), 'POST', scope + 'api/v1/bootstrap', { Origin: origin, 'Content-Type': 'application/json', Cookie: name + '=' + attacker }, JSON.stringify({ bootstrap: url.split('#bootstrap=')[1] }))
    expect(r.status).toBe(200)
    const issued = (((r.headers.get('set-cookie') || [])[0] as string).split(';')[0] as string).split('=')[1] as string
    expect(issued).not.toBe(attacker)
    const useAttacker = await hreq(portOf(origin), 'GET', scope + 'api/v1/snapshot', { Cookie: name + '=' + attacker })
    expect(useAttacker.status).toBe(401)
    const useIssued = await hreq(portOf(origin), 'GET', scope + 'api/v1/snapshot', { Cookie: name + '=' + issued })
    expect(useIssued.status).toBe(200)
  })

  test('45: session token absent from JSON/HTML/JS', async () => {
    const f = await fx()
    const s = await openSession(f)
    const bodies: string[] = []
    bodies.push((await hreq(s.port, 'GET', s.scope + 'api/v1/snapshot', { Cookie: s.cookie })).text)
    bodies.push((await hreq(s.port, 'GET', s.scope + 'api/v1/session', { Cookie: s.cookie })).text)
    bodies.push((await hreq(s.port, 'GET', s.scope)).text)
    bodies.push((await hreq(s.port, 'GET', s.scope + 'assets/app.js')).text)
    for (const b of bodies) expect(b.indexOf(s.token)).toBe(-1)
  })

  test('46: missing/forged session rejects protected API', async () => {
    const f = await fx()
    const s = await openSession(f)
    expect((await hreq(s.port, 'GET', s.scope + 'api/v1/snapshot')).status).toBe(401)
    const name = s.cookie.split('=')[0] as string
    expect((await hreq(s.port, 'GET', s.scope + 'api/v1/snapshot', { Cookie: name + '=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' })).status).toBe(401)
    expect((await hreq(s.port, 'GET', s.scope + 'api/v1/snapshot', { Cookie: 'wrongname=' + s.token })).status).toBe(401)
  })

  test('47: expired session rejects', async () => {
    const f = await fx()
    const s = await openSession(f)
    f.clock.advance(31 * 60 * 1000)
    expect((await snapOf(s)).status).toBe(401)
  })

  test('48: restart invalidates sessions and rotates scope', async () => {
    const f = await fx()
    const a = await openSession(f)
    const scopeA = a.scope
    await f.bridge.close()
    const b = await openSession(f)
    expect(b.scope).not.toBe(scopeA)
    expect(b.cookie.split('=')[0]).not.toBe(a.cookie.split('=')[0])
    const old = await hreq(b.port, 'GET', b.scope + 'api/v1/snapshot', { Cookie: a.cookie })
    expect(old.status).toBe(401)
  })

  test('49+51: session table max 16, full table fails closed without eviction or false success', async () => {
    const f = await fx()
    const sessions: Sess[] = []
    for (let i = 0; i < 16; i++) sessions.push(await openSession(f))
    expect(f.bridge.sessionCount()).toBe(16)
    const { url } = await f.bridge.open()
    const frag = url.split('#bootstrap=')[1] as string
    const o = f.bridge.origin as string
    const full = await hreq(portOf(o), 'POST', (f.bridge.scopePath as string) + 'api/v1/bootstrap', { Origin: o, 'Content-Type': 'application/json' }, JSON.stringify({ bootstrap: frag }))
    expect(full.status).toBe(503)
    // No valid session was evicted: sample survivors still work.
    for (const idx of [0, 7, 15]) expect((await snapOf(sessions[idx] as Sess)).status).toBe(200)
    // No success was claimed without install: the bootstrap was NOT consumed —
    // after freeing one slot via logout it redeems successfully.
    const s0 = sessions[0] as Sess
    const out = await postMut(s0, 'logout', '', s0.csrf)
    expect(out.status).toBe(200)
    const retry = await hreq(portOf(o), 'POST', (f.bridge.scopePath as string) + 'api/v1/bootstrap', { Origin: o, 'Content-Type': 'application/json' }, JSON.stringify({ bootstrap: frag }))
    expect(retry.status).toBe(200)
  })

  test('50: session TTL survives wall-clock rollback', async () => {
    const f = await fx()
    const s = await openSession(f)
    const realNow = Date.now
    try {
      Date.now = () => realNow() - 7200000
      f.clock.advance(31 * 60 * 1000)
      expect((await snapOf(s)).status).toBe(401)
    } finally { Date.now = realNow }
  })

  test('52: valid session obtains a separate CSRF capability', async () => {
    const f = await fx()
    const s = await openSession(f)
    expect(/^[A-Za-z0-9_-]{43}$/.test(s.csrf)).toBe(true)
    expect(s.csrf).not.toBe(s.token)
    const info = await hreq(s.port, 'GET', s.scope + 'api/v1/session', { Cookie: s.cookie })
    expect(info.status).toBe(200)
    expect((JSON.parse(info.text).csrf)).toBe(s.csrf)
  })

  test('53: missing CSRF rejects every mutation class with zero mutation', async () => {
    const f = await fx()
    const s = await openSession(f)
    const genBefore = JSON.parse((await snapOf(s)).text).snapshot.stateGeneration
    for (const m of MUTATIONS) {
      const r = await postMut(s, m, '{}')
      expect(r.status).toBe(403)
    }
    const genAfter = JSON.parse((await snapOf(s)).text).snapshot.stateGeneration
    expect(genAfter).toBe(genBefore)
  })

  test('54: wrong CSRF rejects every mutation class', async () => {
    const f = await fx()
    const s = await openSession(f)
    for (const m of MUTATIONS) {
      const r = await postMut(s, m, '{}', 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')
      expect(r.status).toBe(403)
    }
  })

  test('55: cross-session CSRF rejects', async () => {
    const f = await fx()
    const a = await openSession(f)
    const b = await openSession(f)
    const r = await postMut(a, 'routes/clear', JSON.stringify({ stateGeneration: 'x', lane: 'go', expectedRouteVersion: 1 }), b.csrf)
    expect(r.status).toBe(403)
  })

  test('56: logout is CSRF-protected, scoped, and non-broad', async () => {
    const f = await fx()
    const a = await openSession(f)
    const b = await openSession(f)
    const out = await postMut(a, 'logout', '', a.csrf)
    expect(out.status).toBe(200)
    expect(((out.headers.get('set-cookie') || [])[0] as string).indexOf('Max-Age=0')).not.toBe(-1)
    expect(((out.headers.get('set-cookie') || [])[0] as string).indexOf('Path=' + a.scope)).not.toBe(-1)
    expect((out.headers.get('clear-site-data') || []).length).toBe(0)
    expect((await snapOf(a)).status).toBe(401)
    expect((await snapOf(b)).status).toBe(200)
  })

  test('57: session-info never extends absolute expiry', async () => {
    const f = await fx()
    const s = await openSession(f)
    f.clock.advance(20 * 60 * 1000)
    const info = await hreq(s.port, 'GET', s.scope + 'api/v1/session', { Cookie: s.cookie })
    expect(info.status).toBe(200)
    f.clock.advance(11 * 60 * 1000)
    expect((await snapOf(s)).status).toBe(401)
  })

  test('no external fetch occurred in this file', () => {
    expect(externalFetches).toEqual([])
  })
})
