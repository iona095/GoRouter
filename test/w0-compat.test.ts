/** W0 proving: writer/control compatibility (criteria 55-72, 77). Synthetic-only. */
import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { resolvePaths, ensureStateDirs } from '../src/paths.ts';
import { createDomain } from '../src/domain.ts';
import { createControlService } from '../src/desktop/control-core.ts';
import { createOpHandlers } from '../src/desktop/control-service.ts';
import { serveControlPipe } from '../src/desktop/transport.ts';
import { PROTOCOL_VERSION } from '../src/desktop/protocol.ts';
import { memSecrets } from './harness.ts';
import { ControlClient } from './control-client.ts';
import { expectConflict, sweepDirs } from './w0-helpers.ts';

const dirs: string[] = [];
afterEach(() => sweepDirs(dirs));

function freshService() {
  const dir = mkdtempSync(join(tmpdir(), 'gorouter-w0-compat-'));
  dirs.push(dir);
  const paths = resolvePaths(dir);
  ensureStateDirs(paths);
  const secrets = memSecrets();
  const domain = createDomain(paths, secrets);
  domain.setup();
  const core = createControlService({ paths, secrets, domain, pipeName: 'w0-test-pipe' });
  const handlers = createOpHandlers({ core, domain });
  return { paths, secrets, domain, core, handlers };
}

async function livePipe() {
  const f = freshService();
  const sock = join(f.paths.state, 'w0-test.sock');
  const token = 'w0-admin-token';
  const transport = serveControlPipe(sock, token, f.handlers);
  await transport.listening;
  const client = new ControlClient(sock, token);
  return { ...f, transport, client, token, sock };
}

async function rawFrame(sock: string, token: string, id: number, op: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const s = net.connect({ path: sock });
    let buf = '';
    s.on('data', (d: Buffer) => {
      buf += d.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl >= 0) {
        try { resolve(JSON.parse(buf.slice(0, nl)) as Record<string, unknown>); }
        catch (e) { reject(e); }
        s.destroy();
      }
    });
    s.on('error', reject);
    s.on('connect', () => s.write(JSON.stringify({ id, token, op, params }) + '\n'));
  });
}

describe('protocol version + hello gating (contract 6.4)', () => {
  test('55: protocol advances to 2', () => {
    expect(PROTOCOL_VERSION).toBe(2);
  });

  test('56: hello requires the expected protocol identifier', async () => {
    const t = await livePipe();
    try {
      const missing = await rawFrame(t.sock, t.token, 1, 'hello', { app: 't' });
      expect(missing.ok).toBe(false);
      expect((missing.error as { code: string }).code).toBe('unsupported');
      const wrong = await rawFrame(t.sock, t.token, 2, 'hello', { app: 't', protocol: 1 });
      expect(wrong.ok).toBe(false);
      expect((wrong.error as { code: string }).code).toBe('unsupported');
      const good = await rawFrame(t.sock, t.token, 3, 'hello', { app: 't', protocol: 2 });
      expect(good.ok).toBe(true);
    } finally {
      await t.transport.close();
    }
  });

  test('57: failed hello unlocks nothing; retry hello restores capability', async () => {
    const t = await livePipe();
    try {
      const s = net.connect({ path: t.sock });
      const seen: string[] = [];
      s.on('data', (d: Buffer) => seen.push(d.toString('utf8')));
      const send = (id: number, op: string, params: Record<string, unknown>) =>
        s.write(JSON.stringify({ id, token: t.token, op, params }) + '\n');
      const waitId = (id: number) => new Promise<string>((res) => {
        const iv = setInterval(() => {
          if (seen.join('').includes('"id":' + id)) { clearInterval(iv); res(seen.join('')); }
        }, 25);
      });
      send(1, 'hello', { app: 't', protocol: 999 });
      const r1 = await waitId(1);
      expect(r1).toContain('"ok":false');
      send(2, 'snapshot', {});
      const r2 = await waitId(2);
      expect(r2).toContain('"ok":false');
      expect(r2).toContain('hello must complete');
      send(3, 'hello', { app: 't', protocol: 2 });
      const r3 = await waitId(3);
      expect(r3).toContain('"ok":true');
      send(4, 'snapshot', {});
      const r4 = await waitId(4);
      expect(r4).toContain('"ok":true');
      s.destroy();
    } finally {
      await t.transport.close();
    }
  });

  test('58: old client (no protocol) cannot mutate', async () => {
    const t = await livePipe();
    try {
      const hello = await rawFrame(t.sock, t.token, 1, 'hello', { app: 'old' });
      expect(hello.ok).toBe(false);
      const mut = await rawFrame(t.sock, t.token, 2, 'route.clear', { lane: 'go' });
      expect(mut.ok).toBe(false);
      const snap = t.core.snapshot();
      expect(snap.routes.go.version).toBe(1);
    } finally {
      await t.transport.close();
    }
  });
});

describe('snapshot + versioned service ops (contract 8.1/8.2)', () => {
  test('59: snapshot exposes generation plus route/account versions', async () => {
    const t = await livePipe();
    try {
      const c = t.client;
      await c.connect(5_000);
      const snap = await c.snapshot(5_000);
      expect(typeof snap.stateGeneration).toBe('string');
      expect(snap.stateGeneration.length).toBeGreaterThan(0);
      expect((snap.routes.go as unknown as { version: number }).version).toBe(1);
      const gen = snap.stateGeneration;
      await c.request('account.add', { alias: 'a', secret: 'sk-a', expectedStateGeneration: gen });
      const snap2 = await c.snapshot(5_000);
      const acc = snap2.accounts.find((a) => a.alias === 'a')!;
      expect((acc as unknown as { version: number }).version).toBe(1);
      expect(snap2.stateGeneration).toBe(gen);
      await c.close();
    } finally {
      await t.transport.close();
    }
  });

  test('60: service rejects versionless mutations (desktop MUST send reviewed values)', async () => {
    const t = await livePipe();
    try {
      const c = t.client;
      await c.connect(5_000);
      const snap = await c.snapshot(5_000);
      const gen = snap.stateGeneration;
      const badRoute = (await c.request('route.clear', { lane: 'go' })) as unknown as { ok: boolean; error?: { code: string } };
      expect(badRoute.ok).toBe(false);
      expect(badRoute.error?.code).toBe('validation');
      const badAdd = (await c.request('account.add', { alias: 'x', secret: 'sk-x' })) as unknown as { ok: boolean; error?: { code: string } };
      expect(badAdd.ok).toBe(false);
      expect(badAdd.error?.code).toBe('validation');
      const laneVer = (snap.routes.go as unknown as { version: number }).version;
      const goodClear = (await c.request('route.clear', { lane: 'go', expectedStateGeneration: gen, expectedRouteVersion: laneVer })) as unknown as { ok: boolean; data?: { changed: boolean } };
      expect(goodClear.ok).toBe(true);
      expect(goodClear.data?.changed).toBe(false);
      await c.close();
    } finally {
      await t.transport.close();
    }
  });
});
describe('cross-writer serialization (contract 7/8.2)', () => {
  test('63: competing CLI-visible vs control writers serialize; one stale writer conflicts', async () => {
    const t = await livePipe();
    try {
      const c = t.client;
      await c.connect(5_000);
      const snap = await c.snapshot(5_000);
      const gen = snap.stateGeneration;
      const added = await c.request('account.add', { alias: 'w', secret: 'sk-w', expectedStateGeneration: gen });
      expect((added as { ok: boolean }).ok).toBe(true);
      const snap2 = await c.snapshot(5_000);
      const w = snap2.accounts.find((a) => a.alias === 'w')!;
      const wVer = (w as unknown as { version: number }).version;
      const laneVer = (snap2.routes.go as unknown as { version: number }).version;
      // control writer commits first with the frozen versions…
      const first = (await c.request('route.set', {
        lane: 'go', accountId: w.id, expectedStateGeneration: gen,
        expectedRouteVersion: laneVer, expectedTargetAccountVersion: wVer,
      })) as unknown as { ok: boolean; data?: { changed: boolean; routeVersion: number } };
      expect(first.ok).toBe(true);
      expect(first.data?.changed).toBe(true);
      // …so the CLI-side frozen intent (same lane version) now conflicts.
      const stale = (await c.request('route.clear', {
        lane: 'go', expectedStateGeneration: gen, expectedRouteVersion: laneVer,
      })) as unknown as { ok: boolean; error?: { code: string; reason?: string } };
      expect(stale.ok).toBe(false);
      expect(stale.error?.code).toBe('conflict');
      expect(stale.error?.reason).toBe('route_version_mismatch');
      await c.close();
    } finally {
      await t.transport.close();
    }
  });

  test('64: control-service vs control-service stale writer conflicts', async () => {
    const t = await livePipe();
    try {
      const c = t.client;
      await c.connect(5_000);
      const snap = await c.snapshot(5_000);
      const gen = snap.stateGeneration;
      await c.request('account.add', { alias: 'q', secret: 'sk-q', expectedStateGeneration: gen });
      const s1 = await c.snapshot(5_000);
      const q = s1.accounts.find((a) => a.alias === 'q')!;
      const qVer = (q as unknown as { version: number }).version;
      const ok1 = (await c.request('account.rename', {
        accountId: q.id, newAlias: 'q1', expectedStateGeneration: gen, expectedAccountVersion: qVer,
      })) as unknown as { ok: boolean };
      expect(ok1.ok).toBe(true);
      const stale = (await c.request('account.rename', {
        accountId: q.id, newAlias: 'q2', expectedStateGeneration: gen, expectedAccountVersion: qVer,
      })) as unknown as { ok: boolean; error?: { code: string; reason?: string } };
      expect(stale.ok).toBe(false);
      expect(stale.error?.reason).toBe('account_version_mismatch');
      await c.close();
    } finally {
      await t.transport.close();
    }
  });

  test('65: every mutating op rejects stale generation first', async () => {
    const t = await livePipe();
    try {
      const ops: [string, Record<string, unknown>][] = [
        ['route.set', { lane: 'go', accountId: 'acct-x', expectedStateGeneration: 'stale', expectedRouteVersion: 1, expectedTargetAccountVersion: 1 }],
        ['route.clear', { lane: 'go', expectedStateGeneration: 'stale', expectedRouteVersion: 1 }],
        ['account.add', { alias: 'x', secret: 'sk-x', expectedStateGeneration: 'stale' }],
        ['account.update', { accountId: 'acct-x', secret: 'sk-x', expectedStateGeneration: 'stale', expectedAccountVersion: 1 }],
        ['account.rename', { accountId: 'acct-x', newAlias: 'y', expectedStateGeneration: 'stale', expectedAccountVersion: 1 }],
        ['account.remove', { accountId: 'acct-x', expectedStateGeneration: 'stale', expectedAccountVersion: 1 }],
      ];
      for (const [op, params] of ops) {
        const r = (await t.handlers(op, params).then(
          (data) => ({ ok: true as const, data }),
          (e: { code?: string; reason?: string }) => ({ ok: false as const, code: e.code, reason: e.reason }),
        )) as { ok: boolean; code?: string; reason?: string };
        expect(r.ok).toBe(false);
        expect(r.code).toBe('conflict');
        expect(r.reason).toBe('state_generation_mismatch');
      }
      const snap = t.core.snapshot();
      expect(snap.accounts).toEqual([]);
    } finally {
      await t.transport.close();
    }
  });
});

describe('writer preservation + reset + commit shape (contract 7.8/9)', () => {
  test('66/67/68: setup/rotation/config preserve generation and versions', () => {
    const f = freshService();
    const gen = f.core.snapshot().stateGeneration;
    f.domain.accountAdd('keep', 'sk-keep');
    const before = f.domain.status();
    const accVer = before.accounts.find((a) => a.alias === 'keep')!.version;
    f.domain.setup();
    f.domain.rotateLocalCredential();
    f.domain.configSet('port', '8899');
    const after = f.domain.status();
    expect(after.stateGeneration).toBe(gen);
    expect(after.accounts.find((a) => a.alias === 'keep')!.version).toBe(accVer);
    expect(after.routes.find((x) => x.lane === 'go')!.version).toBe(before.routes.find((x) => x.lane === 'go')!.version);
    expect(after.settings.port).toBe(8899);
  });

  test('69: unrelated writers (journal/registry) untouched by account/route mutations', () => {
    const f = freshService();
    const gen = f.core.snapshot().stateGeneration;
    expect(f.domain.journalStats().records).toBe(0);
    const added = f.domain.accountAddChecked('a', 'sk-a', { expectedStateGeneration: gen });
    const st = f.domain.status();
    f.domain.routeSetChecked('go', added.account.id, {
      expectedStateGeneration: gen,
      expectedRouteVersion: st.routes.find((x) => x.lane === 'go')!.version,
      expectedTargetAccountVersion: added.account.version,
    });
    expect(f.domain.journalStats().records).toBe(0);
    expect(f.domain.modelsStatus().exists).toBe(false);
  });

  test('70: reset clears accounts; re-added accounts restart at version 1', () => {
    const f = freshService();
    const gen = f.core.snapshot().stateGeneration;
    const added = f.domain.accountAddChecked('a', 'sk-a', { expectedStateGeneration: gen });
    f.domain.accountUpdateChecked(added.account.id, 'sk-a2', { expectedStateGeneration: gen, expectedAccountVersion: 1 });
    f.domain.reset();
    const mid = f.domain.status();
    expect(mid.accounts).toEqual([]);
    expect(mid.stateGeneration).not.toBe(gen);
    const re = f.domain.accountAddChecked('b', 'sk-b', { expectedStateGeneration: mid.stateGeneration });
    expect(re.account.version).toBe(1);
    expect(f.domain.status().routes.find((x) => x.lane === 'go')!.version).toBe(1);
  });

  test('71: every checked mutation returns own-transaction commit data', () => {
    const f = freshService();
    const gen = f.core.snapshot().stateGeneration;
    const add = f.domain.accountAddChecked('a', 'sk-a', { expectedStateGeneration: gen });
    expect(add).toMatchObject({ changed: true, stateGeneration: gen });
    expect(add.account.version).toBe(1);
    const st = f.domain.status();
    const set = f.domain.routeSetChecked('go', add.account.id, {
      expectedStateGeneration: gen,
      expectedRouteVersion: st.routes.find((x) => x.lane === 'go')!.version,
      expectedTargetAccountVersion: add.account.version,
    });
    expect(set).toMatchObject({ changed: true, stateGeneration: gen, lane: 'go', routeVersion: 2, accountId: add.account.id });
    const upd = f.domain.accountUpdateChecked(add.account.id, 'sk-a2', { expectedStateGeneration: gen, expectedAccountVersion: 1 });
    expect(upd).toMatchObject({ changed: true, stateGeneration: gen });
    expect(upd.account.version).toBe(2);
    const ren = f.domain.accountRenameChecked(add.account.id, 'a2', { expectedStateGeneration: gen, expectedAccountVersion: 2 });
    expect(ren).toMatchObject({ changed: true, previousAlias: 'a' });
    expect(ren.account.alias).toBe('a2');
    expect(ren.account.version).toBe(3);
    const clr = f.domain.routeClearChecked('go', { expectedStateGeneration: gen, expectedRouteVersion: 2 });
    expect(clr).toMatchObject({ changed: true, routeVersion: 3, accountId: null });
    const rem = f.domain.accountRemoveChecked(add.account.id, false, { expectedStateGeneration: gen, expectedAccountVersion: 3 });
    expect(rem).toMatchObject({ changed: true, removedAccountId: add.account.id, removedAccountVersion: 3 });
    expect(rem.clearedLanes).toEqual([]);
  });

  test('72: B commits after A unlocks without masquerading as A state', () => {
    const f = freshService();
    const gen = f.core.snapshot().stateGeneration;
    const a = f.domain.accountAddChecked('a', 'sk-a', { expectedStateGeneration: gen });
    const b = f.domain.accountAddChecked('b', 'sk-b', { expectedStateGeneration: gen });
    const st = f.domain.status();
    const goVer = st.routes.find((x) => x.lane === 'go')!.version;
    const resA = f.domain.routeSetChecked('go', a.account.id, {
      expectedStateGeneration: gen, expectedRouteVersion: goVer, expectedTargetAccountVersion: a.account.version,
    });
    const resB = f.domain.routeSetChecked('go', b.account.id, {
      expectedStateGeneration: gen, expectedRouteVersion: resA.routeVersion, expectedTargetAccountVersion: b.account.version,
    });
    expect(resA.accountId).toBe(a.account.id);
    expect(resA.routeVersion).toBe(goVer + 1);
    expect(resB.accountId).toBe(b.account.id);
    expect(resB.routeVersion).toBe(goVer + 2);
    expect(resA.routeVersion).not.toBe(resB.routeVersion);
  });

  test('77: manual restore boundary is documented', async () => {
    const { readFileSync: rf } = await import('node:fs');
    const doc = rf('docs/desktop-architecture.md', 'utf8');
    expect(doc).toContain('lineage replacement');
    expect(doc).toContain('restart/re-read before mutating');
  });
});
