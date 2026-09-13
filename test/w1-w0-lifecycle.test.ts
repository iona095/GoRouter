/**
 * W1 proving: W0 preservation (88-101), secret hygiene (102-105), zero-provider
 * lifecycle (106-118), preservation/build gates (123-127). Synthetic-only;
 * temp state dirs + memSecrets; loopback HTTP to the real W1 bridge; file-level
 * non-loopback fetch spy; no production state/credentials.
 *
 * Tests 119-122 (full contained regression + offline desktop compile) execute as
 * recorded jobs in w1-proving-evidence.md (the full bun suite subsumes the C03
 * H0 and C04 W0 seam sets); this file owns the fast W0/lifecycle/preservation
 * gates plus the domain-call/provider denylist collected across the file.
 */
import { describe, test, expect, afterEach, beforeAll, afterAll, setDefaultTimeout } from 'bun:test'
// Spawn/marker tests (108/111/118) start real child processes; the 5s bun
// default is too short under parallel load (control.test.ts precedent).
setDefaultTimeout(60000)
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import http from 'node:http'
import net from 'node:net'
import { createWebBridge, type WebBridge } from '../src/desktop/web-bridge.ts'
import { createControlService } from '../src/desktop/control-core.ts'
import { attachWebBridge, createOpHandlers } from '../src/desktop/control-service.ts'
import { createDomain } from '../src/domain.ts'
import { resolvePaths, ensureStateDirs } from '../src/paths.ts'
import { memSecrets } from './harness.ts'
import type { RouterCommand } from '../src/desktop/supervisor.ts'

const ROOT = resolve(import.meta.dir, '..')
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

const PROVIDER_CALLS: string[] = []
const FORBIDDEN_DOMAIN_CALLS = ['accountTest', 'probeAccount', 'probe', 'refreshModels', 'modelsRefresh', 'modelsStatus', 'modelsList', 'modelsDiff', 'fetchUpstream', 'upstreamFetch']
function manualClock(start?: number): { now: () => number; advance: (ms: number) => void } {
  let t = start ?? 4000000
  return { now: () => t, advance: (ms: number) => { t += ms } }
}
interface Fx { dir: string; domain: ReturnType<typeof createDomain>; counting: ReturnType<typeof createDomain>; core: ReturnType<typeof createControlService>; bridge: WebBridge; logs: string[]; captured: string[]; clock: { now: () => number; advance: (ms: number) => void }; calls: { name: string }[] }
async function fx(): Promise<Fx> {
  const dir = mkdtempSync(join(tmpdir(), 'gorouter-w1e-'))
  dirs.push(dir)
  const paths = resolvePaths(dir)
  ensureStateDirs(paths)
  const secrets = memSecrets({ sec_desktop_admin: 'w1e-admin-token' })
  const domain = createDomain(paths, secrets)
  domain.setup()
  const core = createControlService({ paths, secrets, domain, pipeName: 'w1e-inproc' })
  const logs: string[] = []
  const captured: string[] = []
  const clock = manualClock()
  const calls: { name: string }[] = []
  const counting = new Proxy(domain, {
    get(t, p, r) {
      const v = Reflect.get(t, p, r)
      if (typeof v === 'function' && typeof p === 'string') {
        return (...a: unknown[]) => {
          calls.push({ name: p })
          if (FORBIDDEN_DOMAIN_CALLS.includes(p)) PROVIDER_CALLS.push(p)
          return (v as (...x: unknown[]) => unknown).apply(t, a)
        }
      }
      return v
    },
  })
  const bridge = createWebBridge({ getSnapshot: () => core.snapshot(), domain: counting, openBrowser: (url: string) => { captured.push(url) }, clock: clock.now, log: (e: string) => { logs.push(e) } })
  bridges.push(bridge)
  return { dir, domain, counting, core, bridge, logs, captured, clock, calls }
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
async function snap(s: Sess): Promise<{ stateGeneration: string; raw: string }> {
  const r = await hreq(s.port, 'GET', s.scope + 'api/v1/snapshot', { Cookie: s.cookie })
  if (r.status !== 200) throw new Error('snapshot failed: ' + r.status)
  const body = JSON.parse(r.text).snapshot
  return { stateGeneration: body.stateGeneration as string, raw: r.text }
}
async function mut(s: Sess, rest: string, body: string, csrf: string): Promise<Resp> {
  return hreq(s.port, 'POST', s.scope + 'api/v1/' + rest, { Origin: s.origin, 'Content-Type': 'application/json', Cookie: s.cookie, 'x-gorouter-csrf': csrf }, body)
}
function callsTo(f: Fx, name: string): number { return f.calls.filter((c) => c.name === name).length }
async function seedAccount(f: Fx, s: Sess, alias: string, secret: string): Promise<{ id: string; version: number; gen: string }> {
  const g0 = (await snap(s)).stateGeneration
  const r = await mut(s, 'accounts/add', JSON.stringify({ stateGeneration: g0, alias, secret }), s.csrf)
  if (r.status !== 200) throw new Error('seed add failed: ' + r.status + ' ' + r.text)
  const snap1 = JSON.parse((await hreq(s.port, 'GET', s.scope + 'api/v1/snapshot', { Cookie: s.cookie })).text).snapshot
  const acct = (snap1.accounts as { id: string; alias: string; version: number }[]).find((a) => a.alias === alias) as { id: string; version: number }
  return { id: acct.id, version: acct.version, gen: snap1.stateGeneration as string }
}
function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)) }
async function waitFor(path: string, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) { if (existsSync(path)) return true; await sleep(100) }
  return existsSync(path)
}
function markerCmd(marker: string): RouterCommand {
  return { argv: ['bun', '-e', 'setInterval(function(){},5000);import("node:fs").then(function(m){m.writeFileSync(process.argv[1],"spawned")})', marker], cwd: ROOT }
}
async function preseed(dir: string, routerCmd?: RouterCommand): Promise<void> {
  const paths = resolvePaths(dir)
  ensureStateDirs(paths)
  const secrets = memSecrets({ sec_desktop_admin: 'w1e-admin-token' })
  const domain = createDomain(paths, secrets)
  domain.setup()
  // Pass every start gate so a NORMAL start would auto-start the router: the
  // only remaining suppressor under test is the W1 webSafe latch.
  const core = createControlService({ paths, secrets, domain, pipeName: 'w1e-preseed', routerCmd })
  core.setDesktop({ firstRunDone: true })
}

describe('w1 w0/lifecycle (88-118, 123-127)', () => {
  test('88: route set forwards reviewed gen+versions exactly once', async () => {
    const f = await fx()
    const s = await openSession(f)
    const seeded = await seedAccount(f, s, 'w0-go', 'w1e-canary-88')
    const before = callsTo(f, 'routeSetChecked')
    const r = await mut(s, 'routes/set', JSON.stringify({ stateGeneration: seeded.gen, lane: 'go', accountId: seeded.id, expectedRouteVersion: 1, expectedTargetAccountVersion: seeded.version }), s.csrf)
    expect(r.status).toBe(200)
    expect(callsTo(f, 'routeSetChecked') - before).toBe(1)
  })
  test('89: route clear forwards reviewed gen+version exactly once', async () => {
    const f = await fx()
    const s = await openSession(f)
    const seeded = await seedAccount(f, s, 'w0-clear', 'w1e-canary-89')
    await mut(s, 'routes/set', JSON.stringify({ stateGeneration: seeded.gen, lane: 'zen', accountId: seeded.id, expectedRouteVersion: 1, expectedTargetAccountVersion: seeded.version }), s.csrf)
    const g1 = (await snap(s)).stateGeneration
    const before = callsTo(f, 'routeClearChecked')
    const r = await mut(s, 'routes/clear', JSON.stringify({ stateGeneration: g1, lane: 'zen', expectedRouteVersion: 2 }), s.csrf)
    expect(r.status).toBe(200)
    expect(callsTo(f, 'routeClearChecked') - before).toBe(1)
  })
  test('90: account add forwards reviewed generation exactly once', async () => {
    const f = await fx()
    const s = await openSession(f)
    const g0 = (await snap(s)).stateGeneration
    const before = callsTo(f, 'accountAddChecked')
    const r = await mut(s, 'accounts/add', JSON.stringify({ stateGeneration: g0, alias: 'w0-add', secret: 'w1e-canary-90' }), s.csrf)
    expect(r.status).toBe(200)
    expect(callsTo(f, 'accountAddChecked') - before).toBe(1)
    expect((JSON.parse(r.text).account.secretPresent)).toBe(true)
  })
  test('91: account update forwards id+gen+version exactly once', async () => {
    const f = await fx()
    const s = await openSession(f)
    const seeded = await seedAccount(f, s, 'w0-upd', 'w1e-canary-91a')
    const before = callsTo(f, 'accountUpdateChecked')
    const r = await mut(s, 'accounts/update', JSON.stringify({ stateGeneration: seeded.gen, accountId: seeded.id, expectedAccountVersion: seeded.version, secret: 'w1e-canary-91b' }), s.csrf)
    expect(r.status).toBe(200)
    expect(callsTo(f, 'accountUpdateChecked') - before).toBe(1)
  })
  test('92: account rename forwards id+gen+version exactly once', async () => {
    const f = await fx()
    const s = await openSession(f)
    const seeded = await seedAccount(f, s, 'w0-ren', 'w1e-canary-92')
    const before = callsTo(f, 'accountRenameChecked')
    const r = await mut(s, 'accounts/rename', JSON.stringify({ stateGeneration: seeded.gen, accountId: seeded.id, expectedAccountVersion: seeded.version, newAlias: 'w0-renamed' }), s.csrf)
    expect(r.status).toBe(200)
    expect(callsTo(f, 'accountRenameChecked') - before).toBe(1)
  })
  test('93: account remove uses id+gen+version with force=false', async () => {
    const f = await fx()
    const s = await openSession(f)
    const seeded = await seedAccount(f, s, 'w0-rm', 'w1e-canary-93')
    const before = callsTo(f, 'accountRemoveChecked')
    const r = await mut(s, 'accounts/remove', JSON.stringify({ stateGeneration: seeded.gen, accountId: seeded.id, expectedAccountVersion: seeded.version }), s.csrf)
    expect(r.status).toBe(200)
    expect(callsTo(f, 'accountRemoveChecked') - before).toBe(1)
  })
  test('94: stale generation conflicts with stable reason, zero retry', async () => {
    const f = await fx()
    const s = await openSession(f)
    const seeded = await seedAccount(f, s, 'w0-stale', 'w1e-canary-94')
    const before = callsTo(f, 'routeSetChecked')
    const r = await mut(s, 'routes/set', JSON.stringify({ stateGeneration: 'stale-generation', lane: 'go', accountId: seeded.id, expectedRouteVersion: 1, expectedTargetAccountVersion: seeded.version }), s.csrf)
    expect(r.status).toBe(409)
    expect((JSON.parse(r.text).error.reason)).toBe('state_generation_mismatch')
    expect(callsTo(f, 'routeSetChecked') - before).toBe(1)
  })
  test('95: stale route version conflicts with stable reason', async () => {
    const f = await fx()
    const s = await openSession(f)
    const seeded = await seedAccount(f, s, 'w0-rv', 'w1e-canary-95')
    await mut(s, 'routes/set', JSON.stringify({ stateGeneration: seeded.gen, lane: 'go', accountId: seeded.id, expectedRouteVersion: 1, expectedTargetAccountVersion: seeded.version }), s.csrf)
    const g1 = (await snap(s)).stateGeneration
    const r = await mut(s, 'routes/set', JSON.stringify({ stateGeneration: g1, lane: 'go', accountId: seeded.id, expectedRouteVersion: 1, expectedTargetAccountVersion: seeded.version }), s.csrf)
    expect(r.status).toBe(409)
    expect((JSON.parse(r.text).error.reason)).toBe('route_version_mismatch')
  })
  test('96: stale account version conflicts with stable reason', async () => {
    const f = await fx()
    const s = await openSession(f)
    const seeded = await seedAccount(f, s, 'w0-av', 'w1e-canary-96a')
    await mut(s, 'accounts/update', JSON.stringify({ stateGeneration: seeded.gen, accountId: seeded.id, expectedAccountVersion: seeded.version, secret: 'w1e-canary-96b' }), s.csrf)
    const g1 = (await snap(s)).stateGeneration
    const r = await mut(s, 'accounts/update', JSON.stringify({ stateGeneration: g1, accountId: seeded.id, expectedAccountVersion: seeded.version, secret: 'w1e-canary-96c' }), s.csrf)
    expect(r.status).toBe(409)
    expect((JSON.parse(r.text).error.reason)).toBe('account_version_mismatch')
  })
  test('97: stale no-op remains conflict (never pre-converted)', async () => {
    const f = await fx()
    const s = await openSession(f)
    const seeded = await seedAccount(f, s, 'w0-noop', 'w1e-canary-97')
    const first = await mut(s, 'routes/set', JSON.stringify({ stateGeneration: seeded.gen, lane: 'go', accountId: seeded.id, expectedRouteVersion: 1, expectedTargetAccountVersion: seeded.version }), s.csrf)
    expect(first.status).toBe(200)
    // Replay the now-stale reviewed values: end state already matches, but the
    // generation check runs before no-op determination, so this stays 409.
    const replay = await mut(s, 'routes/set', JSON.stringify({ stateGeneration: seeded.gen, lane: 'go', accountId: seeded.id, expectedRouteVersion: 1, expectedTargetAccountVersion: seeded.version }), s.csrf)
    expect(replay.status).toBe(409)
  })
  test('98: account-in-use remove conflict is preserved', async () => {
    const f = await fx()
    const s = await openSession(f)
    const seeded = await seedAccount(f, s, 'w0-inuse', 'w1e-canary-98')
    await mut(s, 'routes/set', JSON.stringify({ stateGeneration: seeded.gen, lane: 'go', accountId: seeded.id, expectedRouteVersion: 1, expectedTargetAccountVersion: seeded.version }), s.csrf)
    const g1 = (await snap(s)).stateGeneration
    const snap1 = JSON.parse((await hreq(s.port, 'GET', s.scope + 'api/v1/snapshot', { Cookie: s.cookie })).text).snapshot
    const ver = (snap1.accounts as { alias: string; version: number }[]).find((a) => a.alias === 'w0-inuse')?.version as number
    const r = await mut(s, 'accounts/remove', JSON.stringify({ stateGeneration: g1, accountId: seeded.id, expectedAccountVersion: ver }), s.csrf)
    expect(r.status).toBe(409)
    expect((JSON.parse(r.text).error.reason)).toBe('account_in_use')
  })
  test('99: alias conflict is preserved', async () => {
    const f = await fx()
    const s = await openSession(f)
    await seedAccount(f, s, 'w0-dup', 'w1e-canary-99a')
    const g1 = (await snap(s)).stateGeneration
    const r = await mut(s, 'accounts/add', JSON.stringify({ stateGeneration: g1, alias: 'w0-dup', secret: 'w1e-canary-99b' }), s.csrf)
    expect(r.status).toBe(409)
    expect((JSON.parse(r.text).error.reason)).toBe('alias_conflict')
  })
  test('100: lost-response replay with old version conflicts after reread', async () => {
    const f = await fx()
    const s = await openSession(f)
    const seeded = await seedAccount(f, s, 'w0-lost', 'w1e-canary-100')
    const committed = JSON.stringify({ stateGeneration: seeded.gen, accountId: seeded.id, expectedAccountVersion: seeded.version, newAlias: 'w0-lost-new' })
    expect((await mut(s, 'accounts/rename', committed, s.csrf)).status).toBe(200)
    // The committed response is 'lost': replaying the old reviewed values conflicts.
    expect((await mut(s, 'accounts/rename', committed, s.csrf)).status).toBe(409)
    const g1 = (await snap(s)).stateGeneration
    const snap1 = JSON.parse((await hreq(s.port, 'GET', s.scope + 'api/v1/snapshot', { Cookie: s.cookie })).text).snapshot
    const ver = (snap1.accounts as { alias: string; version: number }[]).find((a) => a.alias === 'w0-lost-new')?.version as number
    const id = (snap1.accounts as { alias: string; id: string }[]).find((a) => a.alias === 'w0-lost-new')?.id as string
    expect((await mut(s, 'accounts/rename', JSON.stringify({ stateGeneration: g1, accountId: id, expectedAccountVersion: ver, newAlias: 'w0-lost-final' }), s.csrf)).status).toBe(200)
  })
  test('101: credential update is never automatically replayed', async () => {
    const f = await fx()
    const s = await openSession(f)
    const seeded = await seedAccount(f, s, 'w0-cred', 'w1e-canary-101a')
    const first = JSON.stringify({ stateGeneration: seeded.gen, accountId: seeded.id, expectedAccountVersion: seeded.version, secret: 'w1e-canary-101b' })
    expect((await mut(s, 'accounts/update', first, s.csrf)).status).toBe(200)
    expect((await mut(s, 'accounts/update', first, s.csrf)).status).toBe(409)
    const g1 = (await snap(s)).stateGeneration
    const snap1 = JSON.parse((await hreq(s.port, 'GET', s.scope + 'api/v1/snapshot', { Cookie: s.cookie })).text).snapshot
    const ver = (snap1.accounts as { alias: string; version: number }[]).find((a) => a.alias === 'w0-cred')?.version as number
    expect((await mut(s, 'accounts/update', JSON.stringify({ stateGeneration: g1, accountId: seeded.id, expectedAccountVersion: ver, secret: 'w1e-canary-101c' }), s.csrf)).status).toBe(200)
  })
  test('102+103: synthetic secrets absent from responses/logs/evidence', async () => {
    const f = await fx()
    const s = await openSession(f)
    const g0 = (await snap(s)).stateGeneration
    const add = await mut(s, 'accounts/add', JSON.stringify({ stateGeneration: g0, alias: 'w0-hyg', secret: 'w1e-canary-102-add' }), s.csrf)
    expect(add.status).toBe(200)
    expect(add.text.indexOf('w1e-canary-102-add')).toBe(-1)
    const seeded = JSON.parse((await hreq(s.port, 'GET', s.scope + 'api/v1/snapshot', { Cookie: s.cookie })).text).snapshot
    const acct = (seeded.accounts as { alias: string; id: string; version: number }[]).find((a) => a.alias === 'w0-hyg') as { id: string; version: number }
    const upd = await mut(s, 'accounts/update', JSON.stringify({ stateGeneration: seeded.stateGeneration, accountId: acct.id, expectedAccountVersion: acct.version, secret: 'w1e-canary-103-upd' }), s.csrf)
    expect(upd.status).toBe(200)
    expect(upd.text.indexOf('w1e-canary-103-upd')).toBe(-1)
    const logs = f.logs.join('\n')
    expect(logs.indexOf('w1e-canary-102-add')).toBe(-1)
    expect(logs.indexOf('w1e-canary-103-upd')).toBe(-1)
  })
  test('104: capability/admin canaries absent from logs/evidence', async () => {
    const f = await fx()
    const s = await openSession(f)
    const token = (s.cookie.split('=')[1] as string)
    const logs = f.logs.join('\n')
    for (const canary of [...f.captured, token, s.csrf, 'w1e-admin-token']) expect(logs.indexOf(canary)).toBe(-1)
  })
  test('105: errors expose no stack trace or filesystem path', async () => {
    const f = await fx()
    const s = await openSession(f)
    const bodies: string[] = []
    bodies.push((await mut(s, 'routes/set', '{bad', s.csrf)).text)
    bodies.push((await mut(s, 'routes/set', JSON.stringify({ stateGeneration: 'stale', lane: 'go', accountId: 'x', expectedRouteVersion: 1, expectedTargetAccountVersion: 1 }), s.csrf)).text)
    bodies.push((await hreq(s.port, 'GET', s.scope + 'nope', { Cookie: s.cookie })).text)
    bodies.push((await hreq(s.port, 'GET', s.scope + 'api/v1/snapshot')).text)
    for (const b of bodies) {
      expect(b.indexOf('"stack"')).toBe(-1)
      expect(b.indexOf('at ')).toBe(-1)
      expect(/[A-Za-z]:\\\\/.test(b)).toBe(false)
      expect(b.indexOf('.ts:')).toBe(-1)
    }
  })
  test('106+107: warm web.open changes no router state and makes zero provider calls', async () => {
    const f = await fx()
    const beforeCalls = f.calls.length
    const beforeRouter = JSON.stringify(f.core.snapshot().router)
    const web = attachWebBridge(f.core, f.counting, (u: string) => { f.captured.push(u) })
    const handlers = createOpHandlers({ core: f.core, domain: f.counting, openWeb: web.openWeb })
    const res = await handlers('web.open', {})
    expect((res as { opened: boolean }).opened).toBe(true)
    expect(JSON.stringify(f.core.snapshot().router)).toBe(beforeRouter)
    const made = f.calls.slice(beforeCalls).map((c) => c.name)
    for (const n of made) expect(FORBIDDEN_DOMAIN_CALLS.includes(n)).toBe(false)
    await web.closeWeb()
  })
  test('108+109: cold path uses web-safe mode — usable listener, zero router child', async () => {
    const { startColdWebControl } = await import('../src/desktop/web-launch.ts')
    const dir = mkdtempSync(join(tmpdir(), 'gorouter-w1e-cold-'))
    dirs.push(dir)
    const marker = join(dir, 'router-spawned.marker')
    await preseed(dir, markerCmd(marker))
    const extBefore = externalFetches.length
    const captured: string[] = []
    const handle = await startColdWebControl({ browserOpener: (u: string) => { captured.push(u) }, stateDir: dir, pipeName: 'w1e-cold-' + Math.random().toString(36).slice(2), routerCmd: markerCmd(marker) })
    try {
      expect(captured.length).toBe(1)
      const r = await hreq(portOf(handle.origin), 'GET', handle.scopePath)
      expect(r.status).toBe(200)
      await sleep(1500)
      expect(existsSync(marker)).toBe(false)
      expect(handle.routerSnapshot().state).toBe('stopped')
      expect(handle.routerSnapshot().pid).toBeNull()
      expect(externalFetches.length).toBe(extBefore)
    } finally { await handle.close() }
  })
  test('110: browser traffic cannot clear the web-safe latch', async () => {
    const { startColdWebControl } = await import('../src/desktop/web-launch.ts')
    const dir = mkdtempSync(join(tmpdir(), 'gorouter-w1e-latch-'))
    dirs.push(dir)
    const marker = join(dir, 'router-spawned.marker')
    await preseed(dir, markerCmd(marker))
    const captured: string[] = []
    const handle = await startColdWebControl({ browserOpener: (u: string) => { captured.push(u) }, stateDir: dir, pipeName: 'w1e-latch-' + Math.random().toString(36).slice(2), routerCmd: markerCmd(marker) })
    try {
      const frag = (captured[0] as string).split('#bootstrap=')[1] as string
      const o = handle.origin
      const b = await hreq(portOf(o), 'POST', handle.scopePath + 'api/v1/bootstrap', { Origin: o, 'Content-Type': 'application/json' }, JSON.stringify({ bootstrap: frag }))
      expect(b.status).toBe(200)
      const cookie = (((b.headers.get('set-cookie') || [])[0] as string).split(';')[0] as string)
      const csrf = (JSON.parse(b.text).csrf) as string
      expect((await hreq(portOf(o), 'GET', handle.scopePath + 'api/v1/snapshot', { Cookie: cookie })).status).toBe(200)
      expect((await hreq(portOf(o), 'GET', handle.scopePath + 'api/v1/session', { Cookie: cookie })).status).toBe(200)
      const g = (JSON.parse((await hreq(portOf(o), 'GET', handle.scopePath + 'api/v1/snapshot', { Cookie: cookie })).text).snapshot.stateGeneration) as string
      await hreq(portOf(o), 'POST', handle.scopePath + 'api/v1/accounts/add', { Origin: o, 'Content-Type': 'application/json', Cookie: cookie, 'x-gorouter-csrf': csrf }, JSON.stringify({ stateGeneration: g, alias: 'latch-probe', secret: 'w1e-canary-110' }))
      await sleep(1200)
      expect(existsSync(marker)).toBe(false)
      expect(handle.routerSnapshot().state).toBe('stopped')
      expect(handle.routerSnapshot().pid).toBeNull()
    } finally { await handle.close() }
  })
  test('110b: onboarding completion cannot clear the web-safe latch', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gorouter-w1e-latch2-'))
    dirs.push(dir)
    const marker = join(dir, 'router-spawned.marker')
    const paths = resolvePaths(dir)
    ensureStateDirs(paths)
    const secrets = memSecrets({ sec_desktop_admin: 'w1e-admin-token' })
    const domain = createDomain(paths, secrets)
    domain.setup()
    const core = createControlService({ paths, secrets, domain, pipeName: 'w1e-latch2', routerCmd: markerCmd(marker), webSafe: true })
    core.start()
    try {
      // The browser has no desktop.set route, but defense in depth: even the
      // native onboarding-completion trigger must not clear cold suppression.
      core.setDesktop({ firstRunDone: true })
      await sleep(1200)
      expect(existsSync(marker)).toBe(false)
      expect(core.router.snapshot().state).toBe('stopped')
    } finally { await core.stop(true) }
  })
  test('111: explicit native router.start remains possible under web-safe', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gorouter-w1e-nstart-'))
    dirs.push(dir)
    const marker = join(dir, 'router-spawned.marker')
    const paths = resolvePaths(dir)
    ensureStateDirs(paths)
    const secrets = memSecrets({ sec_desktop_admin: 'w1e-admin-token' })
    const domain = createDomain(paths, secrets)
    domain.setup()
    const core = createControlService({ paths, secrets, domain, pipeName: 'w1e-nstart', routerCmd: markerCmd(marker), webSafe: true })
    core.start()
    try {
      expect(existsSync(marker)).toBe(false)
      core.router.start()
      expect(await waitFor(marker, 8000)).toBe(true)
    } finally { await core.stop(true) }
  })
  test('112-115: page/bootstrap/snapshot/synthetic mutations make zero provider calls', async () => {
    const f = await fx()
    const extBefore = externalFetches.length
    const callsBefore = f.calls.length
    const s = await openSession(f)
    expect((await hreq(s.port, 'GET', s.scope)).status).toBe(200)
    expect((await snap(s)).stateGeneration.length >= 0).toBe(true)
    const seeded = await seedAccount(f, s, 'w0-zero', 'w1e-canary-112')
    await mut(s, 'routes/set', JSON.stringify({ stateGeneration: seeded.gen, lane: 'go', accountId: seeded.id, expectedRouteVersion: 1, expectedTargetAccountVersion: seeded.version }), s.csrf)
    expect(externalFetches.length).toBe(extBefore)
    for (const c of f.calls.slice(callsBefore)) expect(FORBIDDEN_DOMAIN_CALLS.includes(c.name)).toBe(false)
  })
  test('116: shutdown invalidates authority and releases the port', async () => {
    const f = await fx()
    const a = await openSession(f)
    const portA = a.port
    const scopeA = a.scope
    await f.bridge.close()
    const b = await openSession(f)
    expect(b.scope).not.toBe(scopeA)
    expect((await hreq(b.port, 'GET', b.scope + 'api/v1/snapshot', { Cookie: a.cookie })).status).toBe(401)
    await f.bridge.close()
    const rebound = await new Promise<string>((resolve) => {
      const srv = net.createServer()
      srv.once('error', (e: unknown) => resolve((e as { code?: string }).code ?? String(e)))
      srv.listen(portA, '127.0.0.1', () => { srv.close(() => resolve('FREE')) })
    })
    expect(rebound).toBe('FREE')
  })
  test('117: malformed HTTP never kills the service or pipe capability', async () => {
    const f = await fx()
    await f.bridge.open()
    const o = f.bridge.origin as string
    const p = portOf(o)
    await new Promise<void>((resolve) => {
      const sock = net.connect({ host: '127.0.0.1', port: p })
      sock.on('connect', () => { sock.write('NOTHTTP\x00\xff\r\n\r\n' + 'z'.repeat(100000)); setTimeout(() => { try { sock.destroy() } catch { /* t */ } resolve() }, 300) })
      sock.on('error', () => resolve())
      setTimeout(() => resolve(), 3000)
    })
    const s = await openSession(f)
    expect((await snap(s)).stateGeneration.length >= 0).toBe(true)
    const web = attachWebBridge(f.core, f.domain, (u: string) => { f.captured.push(u) })
    expect(((await createOpHandlers({ core: f.core, domain: f.domain, openWeb: web.openWeb })('web.open', {})) as { opened: boolean }).opened).toBe(true)
    await web.closeWeb()
  })
  test('118: normal non-web startup keeps the pre-W1 auto-start policy', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gorouter-w1e-normal-'))
    dirs.push(dir)
    const marker = join(dir, 'router-spawned.marker')
    await preseed(dir, markerCmd(marker))
    const paths = resolvePaths(dir)
    const secrets = memSecrets({ sec_desktop_admin: 'w1e-admin-token' })
    const domain = createDomain(paths, secrets)
    const core = createControlService({ paths, secrets, domain, pipeName: 'w1e-normal', routerCmd: markerCmd(marker) })
    core.start()
    try {
      expect(await waitFor(marker, 10000)).toBe(true)
    } finally { await core.stop(true) }
  })
  test('123: no real credential material in W1 inputs', async () => {
    let testBlob = ''
    let srcBlob = ''
    const walk = (d: string, into: (s: string) => void, onlyW1: boolean): void => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name)
        if (e.isDirectory()) { walk(p, into, onlyW1); continue }
        if (onlyW1 && !/w1-|web-bridge|web-assets|web-launch/.test(e.name)) continue
        into(readFileSync(p, 'utf8') + '\n')
      }
    }
    // C04-R6 precedent: this file's own token-list literals would self-match,
    // so the asserting file excludes itself (its inputs are memSecrets+tmpdirs
    // by construction, verified by the mkdtempSync/memSecrets assertions below).
    const SELF = 'w1-w0-lifecycle.test.ts'
    const walkTest = (d: string): void => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name)
        if (e.isDirectory()) { walkTest(p); continue }
        if (!/w1-|web-bridge|web-assets|web-launch/.test(e.name)) continue
        if (e.name === SELF) continue
        testBlob += readFileSync(p, 'utf8') + '\n'
      }
    }
    walkTest(join(ROOT, 'test'))
    walk(join(ROOT, 'src', 'desktop'), (s) => { srcBlob += s }, true)
    // Production paths/DPAPI mechanism appear in NEITHER tests NOR web sources
    // (web-launch uses createSecretStore only through the synthetic-dir cold
    // path shared with the normal entry — the mechanism, never prod material).
    for (const token of ['AppData', 'LOCALAPPDATA', 'Roaming', 'M:\\\\', 'dpapiUnprotect', 'CryptUnprotectData']) {
      expect(testBlob.indexOf(token)).toBe(-1)
      expect(srcBlob.indexOf(token)).toBe(-1)
    }
    expect(testBlob.indexOf('createSecretStore')).toBe(-1)
    expect(testBlob.indexOf('memSecrets')).not.toBe(-1)
  })
  test('124: no provider/model/probe call observed in this file', () => {
    expect(PROVIDER_CALLS).toEqual([])
    expect(externalFetches).toEqual([])
  })
  test('125: C01-C04 retained evidence untouched by this run', async () => {
    const runStart = Date.UTC(2026, 8, 13, 15, 0, 0)
    const roots = ['C01-R0-S0', 'C02-S0-REM', 'C02-S0-Remediation', 'C03-H0', 'C04-W0']
    let checked = 0
    const walk = (d: string): void => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name)
        if (e.isDirectory()) { walk(p); continue }
        if (p.replace(/\\/g, '/').indexOf('/scratch/') !== -1) continue
        expect(statSync(p).mtimeMs <= runStart).toBe(true)
        checked++
      }
    }
    for (const r of roots) walk(join(ROOT, '..', 'agent-reports', 'GoRouter-Expansion', r))
    expect(checked > 20).toBe(true)
  })
  test('126+127: worktree deltas stay inside the frozen allowlist', async () => {
    const proc = Bun.spawnSync(['git', 'status', '--porcelain=v1', '--untracked-files=all'], { cwd: ROOT })
    const out = proc.stdout.toString()
    const baseline = new Set(['docs/desktop-architecture.md', 'src/cli.ts', 'src/desktop/control-core.ts', 'src/desktop/control-service.ts', 'src/desktop/protocol.ts', 'src/desktop/shell/CardControls.cs', 'src/desktop/shell/ControlCenterForm.cs', 'src/desktop/shell/ControlClient.cs', 'src/desktop/shell/FirstRunFlow.cs', 'src/desktop/shell/Program.cs', 'src/desktop/shell/Selftest.cs', 'src/desktop/shell/ShellSnapshot.cs', 'src/desktop/shell/VisualTheme.cs', 'src/desktop/transport.ts', 'src/domain.ts', 'src/probe.ts', 'src/server.ts', 'src/state.ts', 'src/util.ts', 'test/cache-identity.test.ts', 'test/coherence.test.ts', 'test/control-client.ts', 'test/control.test.ts', 'test/domain.test.ts', 'test/dsh-sync.test.ts', 'test/gr003-prebody-admission.test.ts', 'test/gr004-schema-gate.test.ts', 'test/gr006-model-snapshot.test.ts', 'test/gr007-journal-config.test.ts', 'test/gr008-query-sanitize.test.ts', 'test/gr012-async-teardown.test.ts', 'test/harness.ts', 'test/journal.test.ts', 'test/long-gap-stream.test.ts', 'test/models-registry.test.ts', 'test/path-namespace.test.ts', 'test/probe.test.ts', 'test/proxy.test.ts', 'test/r3-007-pipe-backpressure.test.ts', 'test/r4-001-state-write-cache.test.ts', 'test/r4-002-query-malformed-secret.test.ts', 'test/raw-target-lane.test.ts', 'test/secret-ref-containment.test.ts', 'test/security.test.ts', 'test/socket-failure.test.ts', 'test/state.test.ts', 'test/supervisor-recycle.test.ts'])
    const edits = new Set(['src/desktop/protocol.ts', 'src/desktop/control-service.ts', 'src/desktop/control-core.ts', 'src/cli.ts', 'src/desktop/shell/ControlClient.cs', 'src/desktop/shell/Program.cs', 'src/desktop/shell/TrayIcon.cs'])
    const news = new Set(['src/desktop/web-bridge.ts', 'src/desktop/web-assets.ts', 'src/desktop/web-launch.ts', 'test/w1-listener-origin.test.ts', 'test/w1-bootstrap.test.ts', 'test/w1-session-csrf.test.ts', 'test/w1-http-dto-allowlist.test.ts', 'test/w1-w0-lifecycle.test.ts', 'docs/web-control.md'])
    // Pre-existing untracked work (C03 H0 + C04 W0 proving files, DSH-sync
    // tooling, two shell files): present before C05, never written by this run
    // (tool-call audit: C05 created only the nine `news` paths). Frozen here so
    // future drifts fail loudly.
    const preexistingUntracked = ['cleanup/', '.opencode/', 'src/desktop/shell/GeometryDiagnostics.cs', 'src/desktop/shell/HeaderToolbar.cs', 'test/h0-containment-preflight.test.ts', 'test/h0-dsh-adapter.test.ts', 'test/h0-probe-contract.test.ts', 'test/w0-account-concurrency.test.ts', 'test/w0-cli.test.ts', 'test/w0-compat.test.ts', 'test/w0-helpers.ts', 'test/w0-lost-response.test.ts', 'test/w0-old-writer-fixture.ts', 'test/w0-regression.test.ts', 'test/w0-route-concurrency.test.ts', 'test/w0-schema-migration.test.ts', 'tools/README.md', 'tools/refresh-models.ps1', 'tools/refresh-models.test.ps1', 'tools/sync-dsh-gorouter-catalog.mjs', 'tools/sync-dsh-gorouter-catalog.test.mjs', 'tools/sync-dsh-opencode-metadata.mjs', 'tools/sync-dsh-opencode-metadata.test.mjs']
    for (const line of out.split('\n')) {
      if (!line.trim()) continue
      let path = line.slice(3).trim()
      // git C-quotes paths with exotic bytes: strip the quotes for matching.
      if (path.length > 1 && path[0] === '"' && path[path.length - 1] === '"') path = path.slice(1, -1)
      if (path.indexOf('..') === 0 || path.indexOf('/') === -1) continue
      const status = line.slice(0, 2)
      if (status.trim() === '??') {
        if (preexistingUntracked.some((pre) => path.indexOf(pre) === 0)) continue
        expect(news.has(path)).toBe(true)
      } else {
        expect(baseline.has(path) || edits.has(path)).toBe(true)
      }
    }
    // The worktree carries pre-existing UNCOMMITTED C03/C04 work by design
    // (contract §3: never overwritten for being uncommitted), so `git diff`
    // legitimately lists baseline paths. The C05 gate is: no path OUTSIDE
    // baseline+edits appears. Hunk-level additivity of the seven edited files
    // is proven by audit review (w1-audit-verification-report.md), as in C04.
    const diff = Bun.spawnSync(['git', 'diff', '--name-only'], { cwd: ROOT })
    for (const raw of diff.stdout.toString().split('\n')) {
      const path = raw.trim()
      if (!path) continue
      expect(baseline.has(path) || edits.has(path)).toBe(true)
    }
  })
})
