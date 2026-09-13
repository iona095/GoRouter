/**
 * W0 proving: CLI stale-write protection (criteria 61-62).
 * PLATFORM: Windows/DPAPI-bound (the real CLI persists via the OS secret store).
 * Runs on the Windows host with synthetic state dirs + synthetic stdin secrets;
 * never runs in Linux containment (no DPAPI there) and never touches production
 * state, provider endpoints, or real credentials. Not a skip: executed and green
 * on its bound platform (see w0-proving-evidence.md platform matrix).
 */
import { describe, test, expect, afterEach } from 'bun:test';
import { sweepDirs } from './w0-helpers.ts';

const dirs: string[] = [];
afterEach(() => sweepDirs(dirs));

describe('CLI stale-write protection (contract 8.3)', () => {
  function cliEnv(stateDir: string): Record<string, string> {
    return { ...(process.env as Record<string, string>), GOROUTER_STATE_DIR: stateDir };
  }

  async function runCli(stateDir: string, args: string[], stdin?: string): Promise<{ code: number; out: string; err: string }> {
    const proc = Bun.spawn([process.execPath, 'src/cli.ts', ...args], {
      env: cliEnv(stateDir),
      stdin: stdin !== undefined ? 'pipe' : 'inherit',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (stdin !== undefined && proc.stdin) {
      proc.stdin.write(stdin);
      proc.stdin.end();
    }
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, out, err };
  }

  test('61: CLI freezes alias-only resolution and reports conflicts without retry', async () => {
    const { mkdtempSync: mk } = await import('node:fs');
    const { tmpdir: td } = await import('node:os');
    const { join: j } = await import('node:path');
    const dir = mk(j(td(), 'gorouter-w0-cli-'));
    dirs.push(dir);
    let r = await runCli(dir, ['setup']);
    expect(r.code).toBe(0);
    r = await runCli(dir, ['account', 'add', 'alpha'], 'sk-alpha\n');
    expect(r.code).toBe(0);
    r = await runCli(dir, ['account', 'add', 'beta'], 'sk-beta\n');
    expect(r.code).toBe(0);
    r = await runCli(dir, ['route', 'go', 'alpha']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('GO  -> alpha');
    // deterministic conflict through the same frozen checked flow: renaming
    // onto a live alias must surface conflict [alias_conflict], change nothing,
    // and exit nonzero exactly once (no silent re-resolve/retry).
    r = await runCli(dir, ['account', 'rename', 'alpha', 'beta']);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('conflict [alias_conflict]');
    r = await runCli(dir, ['account', 'list']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('alpha');
    expect(r.out).toContain('beta');
  });

  test('62: alias equal to another ID selects the alias-owner on CLI', async () => {
    const { mkdtempSync: mk } = await import('node:fs');
    const { tmpdir: td } = await import('node:os');
    const { join: j } = await import('node:path');
    const dir = mk(j(td(), 'gorouter-w0-cli62-'));
    dirs.push(dir);
    // seed deterministically through the CLI itself
    let r = await runCli(dir, ['setup']);
    expect(r.code).toBe(0);
    r = await runCli(dir, ['account', 'add', 'id-owner'], 'sk-1\n');
    expect(r.code).toBe(0);
    r = await runCli(dir, ['account', 'list']);
    const idLine = r.out.split('\n').find((l) => l.startsWith('id-owner\t'))!;
    const targetId = /id=(acct_[0-9a-f-]+)/.exec(idLine)![1]!;
    // create an account whose ALIAS equals the first account's immutable ID
    r = await runCli(dir, ['account', 'add', targetId], 'sk-2\n');
    expect(r.code).toBe(0);
    // CLI rename by that alias must hit the alias-owner, not the ID-owner
    r = await runCli(dir, ['account', 'rename', targetId, 'renamed']);
    expect(r.code).toBe(0);
    expect(r.out).toContain("'renamed'");
    r = await runCli(dir, ['account', 'list']);
    expect(r.out).toContain('id-owner');
    expect(r.out).toContain('renamed');
  });
});
