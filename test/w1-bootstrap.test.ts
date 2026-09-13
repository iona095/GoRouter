/**
 * W1 proving: bootstrap capability (contract §14 tests 23-38). Synthetic-only;
 * loopback HTTP to the real W1 bridge; no external network; no production
 * state/credentials; no provider traffic.
 */
import { describe, test, expect, afterEach, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'
import { createWebBridge, type WebBridge } from '../src/desktop/web-bridge.ts'
import { BOOTSTRAP_SHIM_JS } from '../src/desktop/web-assets.ts'
import { createHash } from 'node:crypto'
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
  let t = start ?? 0
  return { now: () => t, advance: (ms: number) => { t += ms } }
}

interface Fx { dir: string; domain: ReturnType<typeof createDomain>; core: ReturnType<typeof createControlService>; bridge: WebBridge; logs: string[]; captured: string[]; clock: { now: () => number; advance: (ms: number) => void } }
async function fx(): Promise<Fx> {
  const dir = mkdtempSync(join(tmpdir(), 'gorouter-w1b-'))
  dirs.push(dir)
  const paths = resolvePaths(dir)
  ensureStateDirs(paths)
  const secrets = memSecrets({ sec_desktop_admin: 'w1b-admin-token' })
  const domain = createDomain(paths, secrets)
  domain.setup()
  const core = createControlService({ paths, secrets, domain, pipeName: 'w1b-inproc' })
  const logs: string[] = []
  const captured: string[] = []
  const clock = manualClock(1000000)
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
function fragOf(url: string): string { return url.split('#bootstrap=')[1] as string }
async function redeem(f: Fx, frag: string): Promise<Resp> {
  const o = f.bridge.origin as string
  return hreq(portOf(o), 'POST', (f.bridge.scopePath as string) + 'api/v1/bootstrap', { Origin: o, 'Content-Type': 'application/json' }, JSON.stringify({ bootstrap: frag }))
}
function allRawSecrets(f: Fx): string[] {
  const out: string[] = []
  for (const u of f.captured) { const c = fragOf(u); if (c) out.push(c) }
  return out
}
function scanStateDir(dir: string): string {
  let acc = ''
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      try {
        if (e.isDirectory()) walk(p)
        else if (e.isFile() && e.name.indexOf('.db-wal') === -1 && e.name.indexOf('.db-shm') === -1) acc += readFileSync(p, 'utf8') + '\n'
      } catch { /* binary/locked */ }
    }
  }
  try { walk(dir) } catch { /* gone */ }
  return acc
}

describe('w1 bootstrap (23-38)', () => {
  test('23: bootstrap requires trusted native authority; HTTP cannot mint', async () => {
    const f = await fx()
    // No web.open has run: any guessed bootstrap fails without a session.
    await f.bridge.open()
    const o = f.bridge.origin as string
    const p = portOf(o)
    const s = f.bridge.scopePath as string
    const guess = await hreq(p, 'POST', s + 'api/v1/bootstrap', { Origin: o, 'Content-Type': 'application/json' }, JSON.stringify({ bootstrap: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }))
    expect(guess.status).toBe(403)
    expect((guess.headers.get('set-cookie') || []).length).toBe(0)
    // And no HTTP route mints: the only fresh capability comes from open().
    expect(f.bridge.bootstrapCount()).toBe(1)
  })

  test('24: each bootstrap carries >=256 bits of CSPRNG entropy', async () => {
    const f = await fx()
    const frags: string[] = []
    for (let i = 0; i < 8; i++) frags.push(fragOf((await f.bridge.open()).url))
    expect(new Set(frags).size).toBe(8)
    for (const c of frags) {
      expect(/^[A-Za-z0-9_-]{43}$/.test(c)).toBe(true)
      expect(Buffer.from(c.replace(/-/g, '+').replace(/_/g, '/'), 'base64').length).toBe(32)
    }
  })

  test('25: bootstrap exists only in the returned URL fragment', async () => {
    const f = await fx()
    const { url } = await f.bridge.open()
    const o = f.bridge.origin as string
    expect(url.indexOf(o + (f.bridge.scopePath as string) + '#bootstrap=')).toBe(0)
    expect(url.indexOf('?')).toBe(-1)
    const pathPart = (url.split('#')[0] as string)
    expect(pathPart.indexOf(fragOf(url))).toBe(-1)
  })

  test('26: bootstrap never appears in the server-observed document request', async () => {
    const f = await fx()
    const { url } = await f.bridge.open()
    const frag = fragOf(url)
    const o = f.bridge.origin as string
    const r = await hreq(portOf(o), 'GET', f.bridge.scopePath as string)
    expect(r.status).toBe(200)
    expect(r.text.indexOf(frag)).toBe(-1)
    expect(f.logs.join('\n').indexOf(frag)).toBe(-1)
  })

  test('27: document performs zero asset fetches before fragment cleanup', async () => {
    const f = await fx()
    await f.bridge.open()
    const o = f.bridge.origin as string
    const r = await hreq(portOf(o), 'GET', f.bridge.scopePath as string)
    expect(r.status).toBe(200)
    // No parser-inserted fetch (tags) and no fetch/XHR/beacon calls exist before
    // cleanup. The shim names ./assets/* only as post-cleanup DOM injections
    // (property assignment after history.replaceState — the sanctioned step 6).
    for (const token of ['<script src', '<link', '<img', 'fetch(', 'XMLHttpRequest', 'sendBeacon']) expect(r.text.indexOf(token)).toBe(-1)
    const cleanupAt = r.text.indexOf('history.replaceState')
    expect(cleanupAt).not.toBe(-1)
    expect(cleanupAt < r.text.indexOf('app.js')).toBe(true)
    expect(r.text.indexOf('http://')).toBe(-1)
    expect(r.text.indexOf('https://')).toBe(-1)
  })

  test('28: CSP-hashed shim removes the fragment before first fetch', async () => {
    const f = await fx()
    await f.bridge.open()
    const o = f.bridge.origin as string
    const r = await hreq(portOf(o), 'GET', f.bridge.scopePath as string)
    const csp = (r.headers.get('content-security-policy') || []).join(';')
    const expected = 'sha256-' + createHash('sha256').update(BOOTSTRAP_SHIM_JS, 'utf8').digest('base64')
    expect(csp.indexOf(expected)).not.toBe(-1)
    expect(csp.indexOf('unsafe-inline')).toBe(-1)
    const m = /<script>([\s\S]*)<\/script>/.exec(r.text)
    expect(m !== null).toBe(true)
    const inlineHash = 'sha256-' + createHash('sha256').update(m && m[1] ? m[1] as string : '', 'utf8').digest('base64')
    expect(inlineHash).toBe(expected)
  })

  test('29: valid bootstrap exchange succeeds once', async () => {
    const f = await fx()
    const frag = fragOf((await f.bridge.open()).url)
    const first = await redeem(f, frag)
    expect(first.status).toBe(200)
    expect(typeof JSON.parse(first.text).csrf).toBe('string')
    expect((first.headers.get('set-cookie') || []).length).toBe(1)
    expect(first.text.indexOf(frag)).toBe(-1)
  })

  test('30: replay fails', async () => {
    const f = await fx()
    const frag = fragOf((await f.bridge.open()).url)
    expect((await redeem(f, frag)).status).toBe(200)
    const replay = await redeem(f, frag)
    expect(replay.status).toBe(403)
    expect((replay.headers.get('set-cookie') || []).length).toBe(0)
  })

  test('31: no automatic retry after ambiguous response; recovery is fresh web.open', async () => {
    const f = await fx()
    const frag = fragOf((await f.bridge.open()).url)
    expect((await redeem(f, frag)).status).toBe(200)
    // The consumed capability stays dead: a client-side retry cannot resurrect it.
    expect((await redeem(f, frag)).status).toBe(403)
    // Recovery path is a fresh native open producing a fresh capability.
    const frag2 = fragOf((await f.bridge.open()).url)
    expect(frag2).not.toBe(frag)
    expect((await redeem(f, frag2)).status).toBe(200)
  })

  test('32: expired bootstrap fails', async () => {
    const f = await fx()
    const frag = fragOf((await f.bridge.open()).url)
    f.clock.advance(61000)
    const r = await redeem(f, frag)
    expect(r.status).toBe(403)
    expect((r.headers.get('set-cookie') || []).length).toBe(0)
  })

  test('33: malformed/unknown bootstrap fails without a session', async () => {
    const f = await fx()
    await f.bridge.open()
    for (const bad of ['not-a-capability!!!', '', 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'short']) {
      const r = await redeem(f, bad)
      expect(r.status === 403 || r.status === 400).toBe(true)
      expect((r.headers.get('set-cookie') || []).length).toBe(0)
    }
    expect(f.bridge.sessionCount()).toBe(0)
  })

  test('34: concurrent double redemption yields exactly one session', async () => {
    const f = await fx()
    const frag = fragOf((await f.bridge.open()).url)
    const results = await Promise.all([redeem(f, frag), redeem(f, frag)])
    const ok = results.filter((r) => r.status === 200).length
    const denied = results.filter((r) => r.status === 403).length
    expect(ok).toBe(1)
    expect(denied).toBe(1)
    expect(f.bridge.sessionCount()).toBe(1)
  })

  test('35+37: bootstrap table max 8, full table rejects minting without eviction', async () => {
    const f = await fx()
    const frags: string[] = []
    for (let i = 0; i < 8; i++) frags.push(fragOf((await f.bridge.open()).url))
    expect(f.bridge.bootstrapCount()).toBe(8)
    await expect(f.bridge.open()).rejects.toThrow('full')
    expect(f.bridge.bootstrapCount()).toBe(8)
    // No live entry was evicted: every survivor still redeems.
    for (const c of frags) expect((await redeem(f, c)).status).toBe(200)
    expect(f.bridge.sessionCount()).toBe(8)
  })

  test('36: bootstrap TTL survives wall-clock rollback (monotonic source)', async () => {
    const f = await fx()
    const frag = fragOf((await f.bridge.open()).url)
    const realNow = Date.now
    try {
      Date.now = () => realNow() - 3600000
      f.clock.advance(61000)
      expect((await redeem(f, frag)).status).toBe(403)
    } finally { Date.now = realNow }
  })

  test('38: bootstrap absent from logs, state files, and evidence', async () => {
    const f = await fx()
    const frags: string[] = []
    for (let i = 0; i < 3; i++) frags.push(fragOf((await f.bridge.open()).url))
    expect((await redeem(f, frags[0] as string)).status).toBe(200)
    const logs = f.logs.join('\n')
    const disk = scanStateDir(f.dir)
    for (const c of frags) {
      expect(logs.indexOf(c)).toBe(-1)
      expect(disk.indexOf(c)).toBe(-1)
    }
    void allRawSecrets(f)
  })

  test('no external fetch occurred in this file', () => {
    expect(externalFetches).toEqual([])
  })
})
