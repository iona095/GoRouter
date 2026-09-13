/** W0 proving: route concurrency (criteria 24-37). Synthetic-only. */
import { describe, test, expect, afterEach } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createDomain } from '../src/domain.ts';
import { memSecrets } from './harness.ts';
import { expectConflict, freshPaths, sweepDirs } from './w0-helpers.ts';

const dirs: string[] = [];
afterEach(() => sweepDirs(dirs));

function twoAccounts() {
  const paths = freshPaths('gorouter-w0-route-', dirs);
  const secrets = memSecrets();
  const domain = createDomain(paths, secrets);
  domain.setup();
  const gen = domain.status().stateGeneration;
  const a = domain.accountAddChecked('alpha', 'sk-alpha', { expectedStateGeneration: gen });
  const b = domain.accountAddChecked('beta', 'sk-beta', { expectedStateGeneration: gen });
  return { paths, secrets, domain, gen, alpha: a.account, beta: b.account };
}

describe('route set concurrency (contract 7.1)', () => {
  test('24: set succeeds when generation + route + target versions match', () => {
    const { domain, gen, alpha } = twoAccounts();
    const st = domain.status();
    const r = domain.routeSetChecked('go', alpha.id, {
      expectedStateGeneration: gen,
      expectedRouteVersion: st.routes.find((x) => x.lane === 'go')!.version,
      expectedTargetAccountVersion: alpha.version,
    });
    expect(r.changed).toBe(true);
    expect(r.stateGeneration).toBe(gen);
    expect(r.routeVersion).toBe(2);
    expect(r.accountId).toBe(alpha.id);
    expect(r.targetAccountVersion).toBe(1);
    const after = domain.status();
    expect(after.routes.find((x) => x.lane === 'go')!.accountId).toBe(alpha.id);
    expect(after.routes.find((x) => x.lane === 'zen')!.accountId).toBeNull();
  });

  test('25: stale generation rejects route set with zero mutation', () => {
    const { paths, domain, alpha } = twoAccounts();
    expectConflict(() => domain.routeSetChecked('go', alpha.id, {
      expectedStateGeneration: 'stale-generation',
      expectedRouteVersion: 1,
      expectedTargetAccountVersion: 1,
    }), 'state_generation_mismatch');
    const raw = JSON.parse(readFileSync(paths.stateJson, 'utf8')) as { routes: { go: { accountId: null } } };
    expect(raw.routes.go.accountId).toBeNull();
  });

  test('26: stale route version rejects with zero mutation', () => {
    const { domain, gen, alpha, beta } = twoAccounts();
    const st = domain.status();
    domain.routeSetChecked('go', alpha.id, {
      expectedStateGeneration: gen,
      expectedRouteVersion: st.routes.find((x) => x.lane === 'go')!.version,
      expectedTargetAccountVersion: alpha.version,
    });
    expectConflict(() => domain.routeSetChecked('go', beta.id, {
      expectedStateGeneration: gen,
      expectedRouteVersion: 1,
      expectedTargetAccountVersion: beta.version,
    }), 'route_version_mismatch');
    expect(domain.status().routes.find((x) => x.lane === 'go')!.accountId).toBe(alpha.id);
  });

  test('27: stale target-account version rejects with zero route mutation', () => {
    const { domain, gen, alpha, beta } = twoAccounts();
    const st = domain.status();
    domain.accountUpdateChecked(beta.id, 'sk-beta-2', { expectedStateGeneration: gen, expectedAccountVersion: beta.version });
    expectConflict(() => domain.routeSetChecked('go', beta.id, {
      expectedStateGeneration: gen,
      expectedRouteVersion: st.routes.find((x) => x.lane === 'go')!.version,
      expectedTargetAccountVersion: beta.version,
    }), 'account_version_mismatch');
    expect(domain.status().routes.find((x) => x.lane === 'go')!.accountId).toBeNull();
  });

  test('28: target removed before commit rejects', () => {
    const { domain, gen, alpha, beta } = twoAccounts();
    const st = domain.status();
    domain.accountRemoveChecked(beta.id, false, { expectedStateGeneration: gen, expectedAccountVersion: beta.version });
    expectConflict(() => domain.routeSetChecked('go', beta.id, {
      expectedStateGeneration: gen,
      expectedRouteVersion: st.routes.find((x) => x.lane === 'go')!.version,
      expectedTargetAccountVersion: beta.version,
    }), 'not_found');
    void alpha;
  });

  test('29: target whose credential vanished before commit is not selectable', () => {
    const { domain, secrets, gen, beta } = twoAccounts();
    const st = domain.status();
    // credential blob disappears out-of-band after the caller reviewed it
    // (presence check only — no secret material is read here)
    const ref = st.accounts.find((a) => a.id === beta.id)!.secretRef;
    expect(secrets.delete(ref)).toBe(true);
    expectConflict(() => domain.routeSetChecked('go', beta.id, {
      expectedStateGeneration: gen,
      expectedRouteVersion: st.routes.find((x) => x.lane === 'go')!.version,
      expectedTargetAccountVersion: beta.version,
    }), 'target_not_selectable');
    expect(domain.status().routes.find((x) => x.lane === 'go')!.accountId).toBeNull();
  });
});
describe('target drift, no-op ordering, lane independence (contract 5.3/5.4)', () => {
  test('30: target rename after preview rejects route set', () => {
    const { domain, gen, alpha } = twoAccounts();
    const st = domain.status();
    domain.accountRenameChecked(alpha.id, 'alpha-2', { expectedStateGeneration: gen, expectedAccountVersion: alpha.version });
    expectConflict(() => domain.routeSetChecked('go', alpha.id, {
      expectedStateGeneration: gen,
      expectedRouteVersion: st.routes.find((x) => x.lane === 'go')!.version,
      expectedTargetAccountVersion: alpha.version,
    }), 'account_version_mismatch');
    expect(domain.status().routes.find((x) => x.lane === 'go')!.accountId).toBeNull();
  });

  test('31: target credential replacement after preview rejects route set', () => {
    const { domain, gen, alpha } = twoAccounts();
    const st = domain.status();
    domain.accountUpdateChecked(alpha.id, 'sk-alpha-2', { expectedStateGeneration: gen, expectedAccountVersion: alpha.version });
    expectConflict(() => domain.routeSetChecked('go', alpha.id, {
      expectedStateGeneration: gen,
      expectedRouteVersion: st.routes.find((x) => x.lane === 'go')!.version,
      expectedTargetAccountVersion: alpha.version,
    }), 'account_version_mismatch');
  });

  test('32: matching-version set to already-selected account is no-change without increment', () => {
    const { paths, domain, gen, alpha } = twoAccounts();
    const st = domain.status();
    const first = domain.routeSetChecked('go', alpha.id, {
      expectedStateGeneration: gen,
      expectedRouteVersion: st.routes.find((x) => x.lane === 'go')!.version,
      expectedTargetAccountVersion: alpha.version,
    });
    expect(first.changed).toBe(true);
    expect(first.routeVersion).toBe(2);
    const before = readFileSync(paths.stateJson, 'utf8');
    const second = domain.routeSetChecked('go', alpha.id, {
      expectedStateGeneration: gen,
      expectedRouteVersion: 2,
      expectedTargetAccountVersion: alpha.version,
    });
    expect(second.changed).toBe(false);
    expect(second.routeVersion).toBe(2);
    expect(readFileSync(paths.stateJson, 'utf8')).toBe(before);
  });

  test('33: route set/clear never increments account versions or rotates generation', () => {
    const { domain, gen, alpha } = twoAccounts();
    const st = domain.status();
    domain.routeSetChecked('go', alpha.id, {
      expectedStateGeneration: gen,
      expectedRouteVersion: st.routes.find((x) => x.lane === 'go')!.version,
      expectedTargetAccountVersion: alpha.version,
    });
    domain.routeClearChecked('go', { expectedStateGeneration: gen, expectedRouteVersion: 2 });
    const after = domain.status();
    expect(after.stateGeneration).toBe(gen);
    expect(after.accounts.find((a) => a.id === alpha.id)!.version).toBe(1);
    expect(after.routes.find((x) => x.lane === 'go')!.version).toBe(3);
  });

  test('34: stale no-op request rejects even though end state matches', () => {
    const { domain, gen, alpha } = twoAccounts();
    const st = domain.status();
    domain.routeSetChecked('go', alpha.id, {
      expectedStateGeneration: gen,
      expectedRouteVersion: st.routes.find((x) => x.lane === 'go')!.version,
      expectedTargetAccountVersion: alpha.version,
    });
    expectConflict(() => domain.routeSetChecked('go', alpha.id, {
      expectedStateGeneration: gen,
      expectedRouteVersion: 1,
      expectedTargetAccountVersion: alpha.version,
    }), 'route_version_mismatch');
  });

  test('35/36: clear increments only that lane on change; matching no-op clear does not', () => {
    const { domain, gen, alpha } = twoAccounts();
    const st = domain.status();
    domain.routeSetChecked('go', alpha.id, {
      expectedStateGeneration: gen,
      expectedRouteVersion: st.routes.find((x) => x.lane === 'go')!.version,
      expectedTargetAccountVersion: alpha.version,
    });
    const zenV = domain.status().routes.find((x) => x.lane === 'zen')!.version;
    const cleared = domain.routeClearChecked('go', { expectedStateGeneration: gen, expectedRouteVersion: 2 });
    expect(cleared.changed).toBe(true);
    expect(cleared.routeVersion).toBe(3);
    const noop = domain.routeClearChecked('zen', { expectedStateGeneration: gen, expectedRouteVersion: zenV });
    expect(noop.changed).toBe(false);
    expect(noop.routeVersion).toBe(zenV);
    expect(domain.status().routes.find((x) => x.lane === 'zen')!.version).toBe(zenV);
  });

  test('37: GO mutation does not increment ZEN version and vice versa', () => {
    const { domain, gen, alpha, beta } = twoAccounts();
    const st = domain.status();
    domain.routeSetChecked('go', alpha.id, {
      expectedStateGeneration: gen,
      expectedRouteVersion: st.routes.find((x) => x.lane === 'go')!.version,
      expectedTargetAccountVersion: alpha.version,
    });
    expect(domain.status().routes.find((x) => x.lane === 'zen')!.version).toBe(1);
    domain.routeSetChecked('zen', beta.id, {
      expectedStateGeneration: gen,
      expectedRouteVersion: st.routes.find((x) => x.lane === 'zen')!.version,
      expectedTargetAccountVersion: beta.version,
    });
    expect(domain.status().routes.find((x) => x.lane === 'go')!.version).toBe(2);
  });
});
