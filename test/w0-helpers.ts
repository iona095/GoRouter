/** W0 proving shared helpers: synthetic-only, no secrets, no network. */
import { expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolvePaths, ensureStateDirs, type Paths } from '../src/paths.ts';
import { isDomainConflict, type ConflictReason } from '../src/domain.ts';

/** Assert fn throws DomainConflict with the exact stable reason. */
export function expectConflict(fn: () => unknown, reason: ConflictReason): void {
  try {
    fn();
  } catch (e) {
    expect(isDomainConflict(e)).toBe(true);
    expect((e as { reason?: string }).reason).toBe(reason);
    return;
  }
  expect.unreachable('expected conflict [' + reason + ']');
}

/** Fresh synthetic state dirs, callee-owned cleanup via afterEach(sweep). */
export function freshDir(prefix: string, registry: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  registry.push(dir);
  return dir;
}

export function freshPaths(prefix: string, registry: string[]): Paths {
  const dir = freshDir(prefix, registry);
  const paths = resolvePaths(dir);
  ensureStateDirs(paths);
  return paths;
}

export function sweepDirs(registry: string[]): void {
  // Windows AV/indexer locks (the F-13 class) can hold a fresh state dir
  // briefly; retry boundedly instead of failing the test on cleanup.
  for (const d of registry.splice(0)) {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        rmSync(d, { recursive: true, force: true });
        break;
      } catch {
        if (attempt === 4) break;
        Bun.sleepSync(25 * (attempt + 1));
      }
    }
  }
}
