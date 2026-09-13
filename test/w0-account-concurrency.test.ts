/** W0 proving: account concurrency (criteria 38-54). Synthetic-only. */
import { describe, test, expect, afterEach } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createDomain } from '../src/domain.ts';
import { memSecrets } from './harness.ts';
import { expectConflict, freshPaths, sweepDirs } from './w0-helpers.ts';

const dirs: string[] = [];
afterEach(() => sweepDirs(dirs));

function seeded() {
  const paths = freshPaths('gorouter-w0-account-', dirs);
  const secrets = memSecrets();
  const domain = createDomain(paths, secrets);
  domain.setup();
  const gen = domain.status().stateGeneration;
  return { paths, secrets, domain, gen };
}

describe('account add + identity (contract 7.6)', () => {
  test('38: add validates generation and creates version 1 with ID', () => {
    const { domain, gen } = seeded();
    const r = domain.accountAddChecked('alpha', 'sk-alpha', { expectedStateGeneration: gen });
    expect(r.changed).toBe(true);
    expect(r.stateGeneration).toBe(gen);
    expect(r.account.version).toBe(1);
    expect(r.account.id.startsWith('acct_')).toBe(true);
  });

  test('39: stale-generation add rejects and leaves no claimed secret reference', () => {
    const paths = freshPaths('gorouter-w0-add39-', dirs);
    const inner = memSecrets();
    const live = new Set<string>();
    const counting = {
      put(ref: string, v: string) { live.add(ref); inner.put(ref, v); },
      get: (ref: string) => inner.get(ref),
      delete: (ref: string) => { live.delete(ref); return inner.delete(ref); },
      exists: (ref: string) => inner.exists(ref),
    };
    const domain = createDomain(paths, counting);
    domain.setup();
    expect(live.size).toBe(1);
    expectConflict(() => domain.accountAddChecked('ghost', 'sk-ghost', { expectedStateGeneration: 'stale' }), 'state_generation_mismatch');
    expect(domain.status().accounts).toEqual([]);
    expect(live.size).toBe(1);
  });

  test('40: exact-ID lookup cannot be redirected by an alias equal to another ID', () => {
    const { domain, gen } = seeded();
    const idOwner = domain.accountAddChecked('id-owner', 'sk-1', { expectedStateGeneration: gen });
    const targetId = idOwner.account.id;
    const aliasOwner = domain.accountAddChecked(targetId, 'sk-2', { expectedStateGeneration: gen });
    expect(aliasOwner.account.alias).toBe(targetId);
    const st = domain.status();
    const renamed = domain.accountRenameChecked(targetId, 'renamed', {
      expectedStateGeneration: gen,
      expectedAccountVersion: st.accounts.find((a) => a.id === targetId)!.version,
    });
    // exact-ID rename hit the ID-owner even though another account's alias equals X...
    expect(renamed.account.id).toBe(targetId);
    expect(domain.status().accounts.find((a) => a.id === idOwner.account.id)!.alias).toBe('renamed');
    // ...and left the alias-owner (whose alias IS X) untouched.
    expect(domain.status().accounts.find((a) => a.id === aliasOwner.account.id)!.alias).toBe(targetId);
  });
});

describe('rename (contract 7.4)', () => {
  test('41: rename by ID increments version once', () => {
    const { domain, gen } = seeded();
    const added = domain.accountAddChecked('alpha', 'sk-a', { expectedStateGeneration: gen });
    const r = domain.accountRenameChecked(added.account.id, 'beta', { expectedStateGeneration: gen, expectedAccountVersion: 1 });
    expect(r.changed).toBe(true);
    expect(r.account.version).toBe(2);
    expect(r.previousAlias).toBe('alpha');
    expect(domain.status().accounts.find((a) => a.id === added.account.id)!.alias).toBe('beta');
  });

  test('42: identical alias on the same account is a no-op after validation', () => {
    const { paths, domain, gen } = seeded();
    const added = domain.accountAddChecked('alpha', 'sk-a', { expectedStateGeneration: gen });
    const before = readFileSync(paths.stateJson, 'utf8');
    const r = domain.accountRenameChecked(added.account.id, 'alpha', { expectedStateGeneration: gen, expectedAccountVersion: 1 });
    expect(r.changed).toBe(false);
    expect(r.account.version).toBe(1);
    expect(readFileSync(paths.stateJson, 'utf8')).toBe(before);
  });

  test('43: case-only rename obeys case-insensitive uniqueness for the same ID', () => {
    const { domain, gen } = seeded();
    const added = domain.accountAddChecked('alpha', 'sk-a', { expectedStateGeneration: gen });
    const r = domain.accountRenameChecked(added.account.id, 'ALPHA', { expectedStateGeneration: gen, expectedAccountVersion: 1 });
    expect(r.changed).toBe(true);
    expect(r.account.alias).toBe('ALPHA');
    expect(r.account.version).toBe(2);
  });

  test('44: alias rename/reuse cannot redirect a stale operation', () => {
    const { domain, gen } = seeded();
    const a = domain.accountAddChecked('alpha', 'sk-a', { expectedStateGeneration: gen });
    const b = domain.accountAddChecked('beta', 'sk-b', { expectedStateGeneration: gen });
    domain.accountRenameChecked(b.account.id, 'gamma', { expectedStateGeneration: gen, expectedAccountVersion: 1 });
    domain.accountRenameChecked(a.account.id, 'beta', { expectedStateGeneration: gen, expectedAccountVersion: 1 });
    expectConflict(() => domain.accountRenameChecked(a.account.id, 'delta', {
      expectedStateGeneration: gen,
      expectedAccountVersion: 1,
    }), 'account_version_mismatch');
    const aliases = domain.status().accounts.map((x) => x.alias).sort();
    expect(aliases).toEqual(['beta', 'gamma']);
  });

  test('45: stale rename rejects', () => {
    const { domain, gen } = seeded();
    const added = domain.accountAddChecked('alpha', 'sk-a', { expectedStateGeneration: gen });
    domain.accountUpdateChecked(added.account.id, 'sk-a2', { expectedStateGeneration: gen, expectedAccountVersion: 1 });
    expectConflict(() => domain.accountRenameChecked(added.account.id, 'beta', {
      expectedStateGeneration: gen,
      expectedAccountVersion: 1,
    }), 'account_version_mismatch');
  });
});
describe('credential replacement (contract 7.3)', () => {
  test('46: replacement increments version once on commit', () => {
    const { domain, gen } = seeded();
    const added = domain.accountAddChecked('alpha', 'sk-a', { expectedStateGeneration: gen });
    const r = domain.accountUpdateChecked(added.account.id, 'sk-a2', { expectedStateGeneration: gen, expectedAccountVersion: 1 });
    expect(r.changed).toBe(true);
    expect(r.account.version).toBe(2);
    expect(domain.status().accounts.find((a) => a.id === added.account.id)!.version).toBe(2);
  });

  test('47: concurrent replacements with same versions yield exactly one commit', () => {
    const { domain, gen } = seeded();
    const added = domain.accountAddChecked('alpha', 'sk-a', { expectedStateGeneration: gen });
    const exp = { expectedStateGeneration: gen, expectedAccountVersion: 1 };
    const first = domain.accountUpdateChecked(added.account.id, 'sk-winner', exp);
    expect(first.account.version).toBe(2);
    expectConflict(() => domain.accountUpdateChecked(added.account.id, 'sk-loser', exp), 'account_version_mismatch');
    expect(domain.status().accounts.find((a) => a.id === added.account.id)!.version).toBe(2);
  });

  test('48: losing replacement cleans its staged unclaimed reference', () => {
    const paths = freshPaths('gorouter-w0-rep48-', dirs);
    const inner = memSecrets();
    const live = new Set<string>();
    const counting = {
      put(ref: string, v: string) { live.add(ref); inner.put(ref, v); },
      get: (ref: string) => inner.get(ref),
      delete: (ref: string) => { live.delete(ref); return inner.delete(ref); },
      exists: (ref: string) => inner.exists(ref),
    };
    const domain = createDomain(paths, counting);
    domain.setup();
    const gen = domain.status().stateGeneration;
    const added = domain.accountAddChecked('alpha', 'sk-a', { expectedStateGeneration: gen });
    const afterAdd = live.size;
    domain.accountUpdateChecked(added.account.id, 'sk-winner', { expectedStateGeneration: gen, expectedAccountVersion: 1 });
    const afterWin = live.size;
    expect(afterWin).toBe(afterAdd);
    expectConflict(() => domain.accountUpdateChecked(added.account.id, 'sk-loser', { expectedStateGeneration: gen, expectedAccountVersion: 1 }), 'account_version_mismatch');
    expect(live.size).toBe(afterWin);
  });

  test('49: stale replacement leaves prior live credential authoritative', () => {
    const { domain, secrets, gen } = seeded();
    const added = domain.accountAddChecked('alpha', 'sk-a', { expectedStateGeneration: gen });
    const before = domain.status().accounts.find((a) => a.id === added.account.id)!;
    expectConflict(() => domain.accountUpdateChecked(added.account.id, 'sk-evil', {
      expectedStateGeneration: 'stale-gen', expectedAccountVersion: 1,
    }), 'state_generation_mismatch');
    const after = domain.status().accounts.find((a) => a.id === added.account.id)!;
    expect(after.secretRef).toBe(before.secretRef);
    expect(after.version).toBe(1);
    expect(secrets.get(after.secretRef)).toBe('sk-a');
  });
});

describe('removal (contract 7.5)', () => {
  function routed() {
    const paths = freshPaths('gorouter-w0-rm-', dirs);
    const domain = createDomain(paths, memSecrets());
    domain.setup();
    const gen = domain.status().stateGeneration;
    const a = domain.accountAddChecked('alpha', 'sk-a', { expectedStateGeneration: gen });
    const b = domain.accountAddChecked('beta', 'sk-b', { expectedStateGeneration: gen });
    const st = domain.status();
    domain.routeSetChecked('go', a.account.id, {
      expectedStateGeneration: gen,
      expectedRouteVersion: st.routes.find((x) => x.lane === 'go')!.version,
      expectedTargetAccountVersion: a.account.version,
    });
    domain.routeSetChecked('zen', a.account.id, {
      expectedStateGeneration: gen,
      expectedRouteVersion: st.routes.find((x) => x.lane === 'zen')!.version,
      expectedTargetAccountVersion: a.account.version,
    });
    return { domain, gen, alpha: a.account, beta: b.account };
  }

  test('50: selected-account removal without force refuses under the lock', () => {
    const { domain, gen, alpha } = routed();
    expectConflict(() => domain.accountRemoveChecked(alpha.id, false, {
      expectedStateGeneration: gen, expectedAccountVersion: alpha.version,
    }), 'account_in_use');
    expect(domain.status().accounts.length).toBe(2);
  });

  test('51: stale generation/version blocks removal', () => {
    const { domain, gen, beta } = routed();
    expectConflict(() => domain.accountRemoveChecked(beta.id, false, {
      expectedStateGeneration: 'stale', expectedAccountVersion: beta.version,
    }), 'state_generation_mismatch');
    expectConflict(() => domain.accountRemoveChecked(beta.id, false, {
      expectedStateGeneration: gen, expectedAccountVersion: 999,
    }), 'account_version_mismatch');
    expect(domain.status().accounts.length).toBe(2);
  });

  test('52: force removal clears all affected lanes atomically with versions', () => {
    const { domain, gen, alpha } = routed();
    const r = domain.accountRemoveChecked(alpha.id, true, { expectedStateGeneration: gen, expectedAccountVersion: alpha.version });
    expect(r.changed).toBe(true);
    expect(r.removedAccountId).toBe(alpha.id);
    expect(r.removedAccountVersion).toBe(1);
    expect(r.clearedLanes).toEqual([{ lane: 'go', routeVersion: 3 }, { lane: 'zen', routeVersion: 3 }]);
    const st = domain.status();
    expect(st.routes.find((x) => x.lane === 'go')!.accountId).toBeNull();
    expect(st.routes.find((x) => x.lane === 'zen')!.accountId).toBeNull();
    expect(st.routes.find((x) => x.lane === 'go')!.version).toBe(3);
    expect(st.routes.find((x) => x.lane === 'zen')!.version).toBe(3);
  });

  test('53: removal cannot leave a dangling selected account', () => {
    const { domain, gen, alpha } = routed();
    domain.accountRemoveChecked(alpha.id, true, { expectedStateGeneration: gen, expectedAccountVersion: alpha.version });
    const st = domain.status();
    for (const lane of ['go', 'zen'] as const) {
      const sel = st.routes.find((x) => x.lane === lane)!.accountId;
      if (sel !== null) expect(st.accounts.some((a) => a.id === sel)).toBe(true);
    }
    expect(st.accounts.find((a) => a.id === alpha.id)).toBeUndefined();
  });

  test('54: account mutations never rotate generation or touch route versions', () => {
    const { domain, gen } = seeded();
    const added = domain.accountAddChecked('alpha', 'sk-a', { expectedStateGeneration: gen });
    domain.accountUpdateChecked(added.account.id, 'sk-a2', { expectedStateGeneration: gen, expectedAccountVersion: 1 });
    domain.accountRenameChecked(added.account.id, 'renamed', { expectedStateGeneration: gen, expectedAccountVersion: 2 });
    const st = domain.status();
    expect(st.stateGeneration).toBe(gen);
    expect(st.routes.find((x) => x.lane === 'go')!.version).toBe(1);
    expect(st.routes.find((x) => x.lane === 'zen')!.version).toBe(1);
    expect(st.accounts.find((a) => a.id === added.account.id)!.version).toBe(3);
  });
});
