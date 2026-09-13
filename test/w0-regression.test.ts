/**
 * W0 proving: safety + preservation (criteria 80-85). Synthetic-only.
 * PLATFORM: Windows host (asserts host repo/evidence/git paths + worktree
 * identity that exist only outside the disposable Linux snapshot). Runs on the
 * host with synthetic fixtures; never in Linux containment. Not a skip:
 * executed and green on its bound platform (see w0-proving-evidence.md matrix).
 * Criteria 78 (full contained suite green) and 79 (frozen H0 set green) are
 * run-level gates evidenced in w0-proving-evidence.md, not unit tests: a test
 * file cannot execute its own suite. This file proves everything provable
 * in-process: no provider traffic (80), no real credentials (81/82), prior
 * evidence untouched (83), unrelated work preserved (84), allowlist-only
 * diff (85).
 */
import { describe, test, expect, afterEach } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createDomain } from '../src/domain.ts';
import { memSecrets } from './harness.ts';
import { freshPaths, sweepDirs } from './w0-helpers.ts';

const MAIN = 'M:/AIFUN/GoRouter/Main';
const REPORTS = 'M:/AIFUN/GoRouter/agent-reports/GoRouter-Expansion';

const dirs: string[] = [];
afterEach(() => sweepDirs(dirs));

describe('no provider traffic, no real credentials (contract 2/8.5)', () => {
  test('80: W0 mutation flows perform zero fetch traffic', async () => {
    let calls = 0;
    const realFetch = globalThis.fetch;
    (globalThis as unknown as { fetch: unknown }).fetch = (..._a: unknown[]) => { calls++; return Promise.reject(new Error('network disabled')); };
    try {
      const paths = freshPaths('gorouter-w0-nofetch-', dirs);
      const domain = createDomain(paths, memSecrets());
      domain.setup();
      const gen = domain.status().stateGeneration;
      const a = domain.accountAddChecked('a', 'sk-a', { expectedStateGeneration: gen });
      const st = domain.status();
      domain.routeSetChecked('go', a.account.id, {
        expectedStateGeneration: gen,
        expectedRouteVersion: st.routes.find((x) => x.lane === 'go')!.version,
        expectedTargetAccountVersion: a.account.version,
      });
      domain.accountUpdateChecked(a.account.id, 'sk-a2', { expectedStateGeneration: gen, expectedAccountVersion: 1 });
      domain.accountRenameChecked(a.account.id, 'a2', { expectedStateGeneration: gen, expectedAccountVersion: 2 });
      domain.journalStats();
      domain.modelsStatus();
      domain.status();
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(calls).toBe(0);
  });

  test('81/82: w0 tests use synthetic secrets + synthetic state roots only', () => {
    // This scanner file is excluded: its assertion literals name the forbidden
    // tokens without using them (verified by inspection of this file's diff).
    const files = readdirSync(join(MAIN, 'test')).filter((f) => f.startsWith('w0-') && f !== 'w0-regression.test.ts');
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const text = readFileSync(join(MAIN, 'test', f), 'utf8');
      expect(text).not.toContain('createSecretStore');
      expect(text).not.toContain('dpapiUnprotect');
      expect(text).not.toContain('dpapiProtect');
      expect(text).not.toContain('LOCALAPPDATA');
      expect(text).not.toContain('.gorouter');
      expect(text).not.toContain('C:/Users');
      expect(text).not.toContain('C:\\Users');
      // GOROUTER_STATE_DIR appears only assigned to synthetic tmp dirs:
      for (const m of text.match(/GOROUTER_STATE_DIR[^\n]*/g) ?? []) {
        expect(m).toContain('stateDir');
      }
      expect(text).not.toContain('resolvePaths()');
    }
    expect(files).toContain('w0-old-writer-fixture.ts');
  });
});

describe('evidence + worktree preservation (contract 10 items 83-85)', () => {
  test('83: C01/C02/C03 retained evidence predates this run (untouched)', () => {
    const runBirth = statSync(join(REPORTS, 'C04-W0', 'C04-20260913T1223Z-R1')).birthtimeMs;
    const roots = ['C01-R0-S0', 'C02-S0-REM', 'C02-S0-Remediation', 'C03-H0'];
    let checked = 0;
    const walk = (dir: string) => {
      for (const name of readdirSync(dir, { withFileTypes: true })) {
        if (name.name === 'node_modules') continue;
        const full = join(dir, name.name);
        if (name.isDirectory()) walk(full);
        else {
          expect(statSync(full).mtimeMs).toBeLessThan(runBirth);
          checked++;
        }
      }
    };
    for (const r of roots) walk(join(REPORTS, r));
    expect(checked).toBeGreaterThan(20);
  });

  test('84/85: worktree diff is allowlist-only; unrelated work preserved', () => {
    // Frozen C04 allowlist (report 2 + amendments A1/A2/A3): every other
    // worktree change fails this test.
    const allowlist = new Set([
      'src/state.ts',
      'src/domain.ts',
      'src/cli.ts',
      'src/desktop/protocol.ts',
      'src/desktop/control-service.ts',
      'src/desktop/control-core.ts',
      'src/desktop/transport.ts',
      'src/desktop/shell/ShellSnapshot.cs',
      'src/desktop/shell/ControlClient.cs',
      'src/desktop/shell/ControlCenterForm.cs',
      'src/desktop/shell/FirstRunFlow.cs',
      'src/desktop/shell/Program.cs',
      'src/desktop/shell/Selftest.cs',
      'test/harness.ts',
      'test/control-client.ts',
      'test/control.test.ts',
      'test/coherence.test.ts',
      'test/proxy.test.ts',
      'test/secret-ref-containment.test.ts',
      'test/state.test.ts',
      'test/gr004-schema-gate.test.ts',
      'test/r4-001-state-write-cache.test.ts',
      'test/gr007-journal-config.test.ts',
      'test/cache-identity.test.ts',
      'test/domain.test.ts',
      'test/socket-failure.test.ts',
      'test/journal.test.ts',
      'test/long-gap-stream.test.ts',
      'test/models-registry.test.ts',
      'test/path-namespace.test.ts',
      'test/security.test.ts',
      'test/gr006-model-snapshot.test.ts',
      'test/dsh-sync.test.ts',
      'test/gr003-prebody-admission.test.ts',
      'test/gr008-query-sanitize.test.ts',
      'test/r4-002-query-malformed-secret.test.ts',
      'test/raw-target-lane.test.ts',
      'test/coherence.test.ts',
      'test/gr012-async-teardown.test.ts',
      'test/supervisor-recycle.test.ts',
      'test/r3-007-pipe-backpressure.test.ts',
      'test/security.test.ts',
      'docs/desktop-architecture.md',
    ]);
    const diffNames: string[] = execFileSync('git', ['diff', '--name-only'], { cwd: MAIN, encoding: 'utf8' }).split('\n').map((s) => s.trim()).filter(Boolean);
    const untracked: string[] = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], { cwd: MAIN, encoding: 'utf8' }).split('\n').map((s) => s.trim()).filter(Boolean);
    // Baseline pre-existing changes (report 1 section 3): C04 must preserve
    // them and add nothing outside the allowlist on top.
    const baseline = new Set([
      'src/desktop/shell/CardControls.cs',
      'src/desktop/shell/Selftest.cs',
      'src/desktop/shell/VisualTheme.cs',
      'src/probe.ts',
      'src/server.ts',
      'src/util.ts',
      'test/domain.test.ts',
      'test/probe.test.ts',
      'test/proxy.test.ts',
      '.opencode/',
      'cleanup/',
      'src/desktop/shell/GeometryDiagnostics.cs',
      'src/desktop/shell/HeaderToolbar.cs',
      'test/h0-containment-preflight.test.ts',
      'test/h0-dsh-adapter.test.ts',
      'test/h0-probe-contract.test.ts',
      'tools/',
    ]);
    const changed = new Set([...diffNames, ...untracked]);
    for (const f of changed) {
      const isBaseline = baseline.has(f) || [...baseline].some((b) => b.endsWith('/') && f.startsWith(b));
      const ok = allowlist.has(f) || f.startsWith('test/w0-') || isBaseline;
      expect(ok, 'non-allowlisted change: ' + f).toBe(true);
    }
    for (const b of [...baseline].filter((x) => !x.endsWith('/'))) {
      expect(changed.has(b) || allowlist.has(b), 'baseline path lost: ' + b).toBe(true);
    }
    expect(changed.size).toBeGreaterThan(5);
  });
});
