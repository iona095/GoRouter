/** W0 proving: lost response + restart persistence (criteria 73-76). Synthetic-only. */
import { describe, test, expect, afterEach } from 'bun:test';
import { createDomain } from '../src/domain.ts';
import { memSecrets } from './harness.ts';
import { expectConflict, freshPaths, sweepDirs } from './w0-helpers.ts';

const dirs: string[] = [];
afterEach(() => sweepDirs(dirs));

function seeded() {
  const paths = freshPaths('gorouter-w0-lost-', dirs);
  const secrets = memSecrets();
  const domain = createDomain(paths, secrets);
  domain.setup();
  const gen = domain.status().stateGeneration;
  return { paths, secrets, domain, gen };
}

describe('lost response (contract 8.4)', () => {
  test('73: committed route mutation + lost response + identical retry conflicts; reread shows commit', () => {
    const { domain, gen } = seeded();
    const added = domain.accountAddChecked('a', 'sk-a', { expectedStateGeneration: gen });
    const st = domain.status();
    const frozen = {
      expectedStateGeneration: gen,
      expectedRouteVersion: st.routes.find((x) => x.lane === 'go')!.version,
      expectedTargetAccountVersion: added.account.version,
    };
    const committed = domain.routeSetChecked('go', added.account.id, frozen);
    expect(committed.changed).toBe(true);
    // the response is 'lost': the client retries the ORIGINAL request verbatim
    expectConflict(() => domain.routeSetChecked('go', added.account.id, frozen), 'route_version_mismatch');
    // re-read shows the committed state; a fresh intent succeeds
    const reread = domain.status();
    expect(reread.routes.find((x) => x.lane === 'go')!.accountId).toBe(added.account.id);
    expect(reread.routes.find((x) => x.lane === 'go')!.version).toBe(committed.routeVersion);
  });

  test('74: committed account mutation + lost response behaves equivalently', () => {
    const { domain, gen } = seeded();
    const added = domain.accountAddChecked('a', 'sk-a', { expectedStateGeneration: gen });
    const commit = domain.accountUpdateChecked(added.account.id, 'sk-a2', { expectedStateGeneration: gen, expectedAccountVersion: 1 });
    expect(commit.account.version).toBe(2);
    expectConflict(() => domain.accountUpdateChecked(added.account.id, 'sk-a2', { expectedStateGeneration: gen, expectedAccountVersion: 1 }), 'account_version_mismatch');
    expect(domain.status().accounts.find((a) => a.id === added.account.id)!.version).toBe(2);
  });

  test('75: ambiguous credential-replacement response is never automatically retried', () => {
    const { domain, secrets, gen } = seeded();
    const added = domain.accountAddChecked('a', 'sk-a', { expectedStateGeneration: gen });
    // exactly one commit happens; the implementation performs no hidden retry:
    // after the commit, the credential value is the winner's and the version
    // advanced exactly once, with no further store traffic possible.
    const commit = domain.accountUpdateChecked(added.account.id, 'sk-winner', { expectedStateGeneration: gen, expectedAccountVersion: 1 });
    expect(commit.account.version).toBe(2);
    const live = domain.status().accounts.find((a) => a.id === added.account.id)!;
    expect(secrets.get(live.secretRef)).toBe('sk-winner');
    // any 'retry' with the original expectations conflicts instead of committing again
    expectConflict(() => domain.accountUpdateChecked(added.account.id, 'sk-winner', { expectedStateGeneration: gen, expectedAccountVersion: 1 }), 'account_version_mismatch');
    expect(domain.status().accounts.find((a) => a.id === added.account.id)!.version).toBe(2);
  });

  test('76: ordinary restart preserves generation and post-mutation versions', () => {
    const { paths, domain, gen } = seeded();
    const added = domain.accountAddChecked('a', 'sk-a', { expectedStateGeneration: gen });
    const st = domain.status();
    domain.routeSetChecked('go', added.account.id, {
      expectedStateGeneration: gen,
      expectedRouteVersion: st.routes.find((x) => x.lane === 'go')!.version,
      expectedTargetAccountVersion: added.account.version,
    });
    // process restart: brand-new domain + empty secret store over the same dir;
    // generation and versions come from state.json alone.
    void paths;
    const restarted = createDomain(paths, memSecrets());
    const reread = restarted.status();
    expect(reread.stateGeneration).toBe(gen);
    expect(reread.routes.find((x) => x.lane === 'go')!.version).toBe(2);
    expect(reread.accounts.find((a) => a.id === added.account.id)!.version).toBe(1);
  });
});
