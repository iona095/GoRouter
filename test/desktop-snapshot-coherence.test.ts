/**
 * GoRouter Desktop snapshot coherence (F-I, D). Deterministic, synthetic only.
 */
import { describe, test, expect, afterEach, setDefaultTimeout } from 'bun:test'
setDefaultTimeout(120_000)
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createControlService } from '../src/desktop/control-core.ts'
import { createOpHandlers } from '../src/desktop/control-service.ts'
import { createDomain } from '../src/domain.ts'
import { resolvePaths, ensureStateDirs } from '../src/paths.ts'
import { memSecrets } from './harness.ts'
import type { Snapshot } from '../src/desktop/protocol.ts'
const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) {
    for (let a = 0; a < 30; a++) {
      try { rmSync(d, { recursive: true, force: true }); break } catch { await Bun.sleep(Math.min(200 * (a + 1), 2000)) }
    }
  }
})
function freshStateDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'gorouter-snapcoh-'))
  dirs.push(d)
  return d
}
function freshCore(opts?: { pollIntervalMs?: number; probeIntervalMs?: number }) {
  const stateDir = freshStateDir()
  const paths = resolvePaths(stateDir)
  ensureStateDirs(paths)
  const secrets = memSecrets({ sec_desktop_admin: 'test-admin-token' })
  const domain = createDomain(paths, secrets)
  const core = createControlService({ paths, secrets, domain, pipeName: 'inproc-coherence', probeIntervalMs: opts?.probeIntervalMs ?? 60_000, backoffMs: [60_000], pollIntervalMs: opts?.pollIntervalMs ?? 60_000 })
  const handlers = createOpHandlers({ core, domain })
  return { core, handlers, paths, stateDir, secrets, domain }
}
async function sleep(ms: number) { await new Promise((r) => setTimeout(r, ms)) }
async function waitFor(cond: () => boolean, timeoutMs: number, stepMs = 50): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) { if (cond()) return; if (Date.now() >= deadline) throw new Error('waitFor timed out'); await sleep(stepMs) }
}
describe('F: successful mutations push authoritative snapshots (no poll wait)', () => {
  test('account.add pushes committed state', async () => {
    const { core, handlers } = freshCore()
    core.start()
    try {
      const gen = core.snapshot().stateGeneration
      const seen: Snapshot[] = []
      const unsub = core.onSnapshot((s) => seen.push(s))
      try {
        await handlers('account.add', { alias: 'Workspace_A', secret: 'synthetic-secret-1', expectedStateGeneration: gen })
        await waitFor(() => seen.length >= 1, 5000)
        expect(seen[seen.length - 1]!.accounts.map((a) => a.alias)).toContain('Workspace_A')
      } finally { unsub() }
    } finally { await core.stop(false) }
  })
  test('account.update pushes committed state', async () => {
    const { core, handlers } = freshCore()
    core.start()
    try {
      const gen = core.snapshot().stateGeneration
      await handlers('account.add', { alias: 'acct1', secret: 'synthetic-1', expectedStateGeneration: gen })
      await sleep(800)
      const snap1 = core.snapshot()
      const acct = snap1.accounts.find((a) => a.alias === 'acct1')!
      const seen: Snapshot[] = []
      const unsub = core.onSnapshot((s) => seen.push(s))
      try {
        await handlers('account.update', { accountId: acct.id, secret: 'synthetic-2', expectedStateGeneration: gen, expectedAccountVersion: acct.version })
        await waitFor(() => seen.length >= 1, 5000)
        expect(seen[seen.length - 1]!.accounts.find((a) => a.id === acct.id)!.version).toBe(acct.version + 1)
      } finally { unsub() }
    } finally { await core.stop(false) }
  })
  test('account.rename changed pushes; no-op does not', async () => {
    const { core, handlers } = freshCore()
    core.start()
    try {
      const gen = core.snapshot().stateGeneration
      await handlers('account.add', { alias: 'acct1', secret: 'synthetic-1', expectedStateGeneration: gen })
      await sleep(800)
      const snap1 = core.snapshot()
      const acct = snap1.accounts.find((a) => a.alias === 'acct1')!
      const seen: Snapshot[] = []
      const unsub = core.onSnapshot((s) => seen.push(s))
      try {
        const r = (await handlers('account.rename', { accountId: acct.id, newAlias: 'acct1-renamed', expectedStateGeneration: gen, expectedAccountVersion: acct.version })) as { changed: boolean }
        expect(r.changed).toBe(true)
        await waitFor(() => seen.length >= 1, 5000)
        expect(seen[seen.length - 1]!.accounts.map((a) => a.alias)).toContain('acct1-renamed')
      } finally { unsub() }
      await sleep(800)
      const snap2 = core.snapshot()
      const renamed = snap2.accounts.find((a) => a.alias === 'acct1-renamed')!
      const seen2: Snapshot[] = []
      const unsub2 = core.onSnapshot((s) => seen2.push(s))
      try {
        const r2 = (await handlers('account.rename', { accountId: renamed.id, newAlias: 'acct1-renamed', expectedStateGeneration: gen, expectedAccountVersion: renamed.version })) as { changed: boolean }
        expect(r2.changed).toBe(false)
        await sleep(900)
        expect(seen2.length).toBe(0)
      } finally { unsub2() }
    } finally { await core.stop(false) }
  })
  test('account.remove with force pushes cleared lanes', async () => {
    const { core, handlers } = freshCore()
    core.start()
    try {
      const gen = core.snapshot().stateGeneration
      await handlers('account.add', { alias: 'acct1', secret: 's1', expectedStateGeneration: gen })
      await sleep(800)
      let snap = core.snapshot()
      const acct = snap.accounts.find((a) => a.alias === 'acct1')!
      await handlers('route.set', { lane: 'go', accountId: acct.id, expectedStateGeneration: gen, expectedRouteVersion: snap.routes.go.version, expectedTargetAccountVersion: acct.version })
      await sleep(800)
      snap = core.snapshot()
      expect(snap.routes.go.alias).toBe('acct1')
      const seen: Snapshot[] = []
      const unsub = core.onSnapshot((s) => seen.push(s))
      try {
        const cur = core.snapshot()
        const target = cur.accounts.find((a) => a.alias === 'acct1')!
        await handlers('account.remove', { accountId: target.id, force: true, expectedStateGeneration: gen, expectedAccountVersion: target.version })
        await waitFor(() => seen.length >= 1, 5000)
        expect(seen[seen.length - 1]!.accounts.map((a) => a.alias)).not.toContain('acct1')
        expect(seen[seen.length - 1]!.routes.go.accountId).toBeNull()
      } finally { unsub() }
    } finally { await core.stop(false) }
  })
  test('route.set pushes; no-op does not', async () => {
    const { core, handlers } = freshCore()
    core.start()
    try {
      const gen = core.snapshot().stateGeneration
      await handlers('account.add', { alias: 'Workspace_A', secret: 's1', expectedStateGeneration: gen })
      await sleep(800)
      let snap = core.snapshot()
      const acct = snap.accounts.find((a) => a.alias === 'Workspace_A')!
      const seen: Snapshot[] = []
      const unsub = core.onSnapshot((s) => seen.push(s))
      try {
        const c = (await handlers('route.set', { lane: 'go', accountId: acct.id, expectedStateGeneration: gen, expectedRouteVersion: snap.routes.go.version, expectedTargetAccountVersion: acct.version })) as { changed: boolean }
        expect(c.changed).toBe(true)
        await waitFor(() => seen.length >= 1, 5000)
        expect(seen[seen.length - 1]!.routes.go.alias).toBe('Workspace_A')
      } finally { unsub() }
      await sleep(800)
      snap = core.snapshot()
      const cur = snap.accounts.find((a) => a.alias === 'Workspace_A')!
      const seen2: Snapshot[] = []
      const unsub2 = core.onSnapshot((s) => seen2.push(s))
      try {
        const c2 = (await handlers('route.set', { lane: 'go', accountId: cur.id, expectedStateGeneration: gen, expectedRouteVersion: snap.routes.go.version, expectedTargetAccountVersion: cur.version })) as { changed: boolean }
        expect(c2.changed).toBe(false)
        await sleep(900)
        expect(seen2.length).toBe(0)
      } finally { unsub2() }
    } finally { await core.stop(false) }
  })
  test('route.clear pushes; no-op does not', async () => {
    const { core, handlers } = freshCore()
    core.start()
    try {
      const gen = core.snapshot().stateGeneration
      await handlers('account.add', { alias: 'acct1', secret: 's1', expectedStateGeneration: gen })
      await sleep(800)
      let snap = core.snapshot()
      const acct = snap.accounts.find((a) => a.alias === 'acct1')!
      await handlers('route.set', { lane: 'zen', accountId: acct.id, expectedStateGeneration: gen, expectedRouteVersion: snap.routes.zen.version, expectedTargetAccountVersion: acct.version })
      await sleep(800)
      snap = core.snapshot()
      const seen: Snapshot[] = []
      const unsub = core.onSnapshot((s) => seen.push(s))
      try {
        const c = (await handlers('route.clear', { lane: 'zen', expectedStateGeneration: gen, expectedRouteVersion: snap.routes.zen.version })) as { changed: boolean }
        expect(c.changed).toBe(true)
        await waitFor(() => seen.length >= 1, 5000)
        expect(seen[seen.length - 1]!.routes.zen.accountId).toBeNull()
      } finally { unsub() }
      await sleep(800)
      snap = core.snapshot()
      const seen2: Snapshot[] = []
      const unsub2 = core.onSnapshot((s) => seen2.push(s))
      try {
        const c2 = (await handlers('route.clear', { lane: 'zen', expectedStateGeneration: gen, expectedRouteVersion: snap.routes.zen.version })) as { changed: boolean }
        expect(c2.changed).toBe(false)
        await sleep(900)
        expect(seen2.length).toBe(0)
      } finally { unsub2() }
    } finally { await core.stop(false) }
  })
  test('rapid add-rename-route converges', async () => {
    const { core, handlers } = freshCore()
    core.start()
    try {
      const gen = core.snapshot().stateGeneration
      const seen: Snapshot[] = []
      const unsub = core.onSnapshot((s) => seen.push(s))
      try {
        await handlers('account.add', { alias: 'acct1', secret: 's1', expectedStateGeneration: gen })
        let snap = core.snapshot()
        const a = snap.accounts.find((x) => x.alias === 'acct1')!
        await handlers('account.rename', { accountId: a.id, newAlias: 'Workspace_A', expectedStateGeneration: gen, expectedAccountVersion: a.version })
        snap = core.snapshot()
        const renamed = snap.accounts.find((x) => x.alias === 'Workspace_A')!
        await handlers('route.set', { lane: 'go', accountId: renamed.id, expectedStateGeneration: gen, expectedRouteVersion: snap.routes.go.version, expectedTargetAccountVersion: renamed.version })
        await waitFor(() => seen.length >= 1, 5000)
        await sleep(800)
        expect(core.snapshot().routes.go.alias).toBe('Workspace_A')
      } finally { unsub() }
    } finally { await core.stop(false) }
  })
})
describe('G: failed mutations do not emit false success', () => {
  test('generation mismatch fails without snapshot', async () => {
    const { core, handlers } = freshCore()
    core.start()
    try {
      const seen: Snapshot[] = []
      const unsub = core.onSnapshot((s) => seen.push(s))
      try {
        await expect(handlers('account.add', { alias: 'x', secret: 's', expectedStateGeneration: 'wrong-generation' })).rejects.toMatchObject({ code: 'conflict' })
        await sleep(900)
        expect(seen.length).toBe(0)
      } finally { unsub() }
    } finally { await core.stop(false) }
  })
  test('version mismatch fails without snapshot', async () => {
    const { core, handlers } = freshCore()
    core.start()
    try {
      const gen = core.snapshot().stateGeneration
      await handlers('account.add', { alias: 'acct1', secret: 's1', expectedStateGeneration: gen })
      await sleep(800)
      const snap = core.snapshot()
      const acct = snap.accounts.find((a) => a.alias === 'acct1')!
      const seen: Snapshot[] = []
      const unsub = core.onSnapshot((s) => seen.push(s))
      try {
        await expect(handlers('route.set', { lane: 'go', accountId: acct.id, expectedStateGeneration: gen, expectedRouteVersion: 9999, expectedTargetAccountVersion: acct.version })).rejects.toMatchObject({ code: 'conflict' })
        await expect(handlers('account.rename', { accountId: acct.id, newAlias: 'other', expectedStateGeneration: gen, expectedAccountVersion: 9999 })).rejects.toMatchObject({ code: 'conflict' })
        await sleep(900)
        expect(seen.length).toBe(0)
        expect(core.snapshot().routes.go.accountId).toBeNull()
      } finally { unsub() }
    } finally { await core.stop(false) }
  })
  test('routed remove without force fails', async () => {
    const { core, handlers } = freshCore()
    core.start()
    try {
      const gen = core.snapshot().stateGeneration
      await handlers('account.add', { alias: 'acct1', secret: 's1', expectedStateGeneration: gen })
      await sleep(800)
      let snap = core.snapshot()
      const acct = snap.accounts.find((a) => a.alias === 'acct1')!
      await handlers('route.set', { lane: 'go', accountId: acct.id, expectedStateGeneration: gen, expectedRouteVersion: snap.routes.go.version, expectedTargetAccountVersion: acct.version })
      await sleep(800)
      snap = core.snapshot()
      const cur = snap.accounts.find((a) => a.alias === 'acct1')!
      const seen: Snapshot[] = []
      const unsub = core.onSnapshot((s) => seen.push(s))
      try {
        await expect(handlers('account.remove', { accountId: cur.id, force: false, expectedStateGeneration: gen, expectedAccountVersion: cur.version })).rejects.toMatchObject({ code: 'conflict' })
        await sleep(900)
        expect(seen.length).toBe(0)
      } finally { unsub() }
    } finally { await core.stop(false) }
  })
})
describe('H: initial snapshot before any mutation', () => {
  test('seeded acct1/acct2/Workspace_A plus routes visible', async () => {
    const { core, handlers } = freshCore()
    core.start()
    try {
      const gen = core.snapshot().stateGeneration
      await handlers('account.add', { alias: 'acct1', secret: 'synthetic-1', expectedStateGeneration: gen })
      await handlers('account.add', { alias: 'acct2', secret: 'synthetic-2', expectedStateGeneration: gen })
      await handlers('account.add', { alias: 'Workspace_A', secret: 'synthetic-3', expectedStateGeneration: gen })
      let snap = core.snapshot()
      const w = snap.accounts.find((a) => a.alias === 'Workspace_A')!
      const a2 = snap.accounts.find((a) => a.alias === 'acct2')!
      await handlers('route.set', { lane: 'go', accountId: w.id, expectedStateGeneration: gen, expectedRouteVersion: snap.routes.go.version, expectedTargetAccountVersion: w.version })
      snap = core.snapshot()
      await handlers('route.set', { lane: 'zen', accountId: a2.id, expectedStateGeneration: gen, expectedRouteVersion: snap.routes.zen.version, expectedTargetAccountVersion: a2.version })
      const first = core.snapshot()
      expect(first.accounts.map((a) => a.alias).sort()).toEqual(['Workspace_A', 'acct1', 'acct2'])
      expect(first.routes.go.alias).toBe('Workspace_A')
      expect(first.routes.zen.alias).toBe('acct2')
      expect(Array.isArray(core.journalRecent(10).rows)).toBe(true)
    } finally { await core.stop(false) }
  })
  test('fractional retention truthful', async () => {
    const { core, domain } = freshCore()
    core.start()
    try {
      domain.configSet('journalRetentionDays', '1.5')
      expect(core.snapshot().settings.journalRetentionDays).toBe(1.5)
      expect(core.snapshot().journal.retentionDays).toBe(1.5)
    } finally { await core.stop(false) }
  })
})
describe('I: external CLI race before first poll', () => {
  test('mutation immediately after start is pushed', async () => {
    const { core, paths, secrets } = freshCore({ pollIntervalMs: 1000, probeIntervalMs: 60_000 })
    core.start()
    try {
      const { createDomain: mkDomain } = await import('../src/domain.ts')
      const extDomain = mkDomain(paths, secrets)
      const gen = extDomain.status().stateGeneration
      extDomain.accountAddChecked('race-acct', 'synthetic-race-secret', { expectedStateGeneration: gen })
      const seen: Snapshot[] = []
      const unsub = core.onSnapshot((s) => seen.push(s))
      try {
        await waitFor(() => seen.some((s) => s.accounts.some((a) => a.alias === 'race-acct')), 8000)
      } finally { unsub() }
    } finally { await core.stop(false) }
  })
})
