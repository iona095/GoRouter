/**
 * R3-008 regression: a refresh-claim FILESYSTEM failure (EACCES, ENOSPC,
 * EROFS, EISDIR - anything but EEXIST) is an explicit local failure,
 * never "another models refresh is in progress", and never waits on a
 * lock the claimant could not even create.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePaths, ensureStateDirs } from "../src/paths.ts";
import { refreshRegistry, clearRefreshSingleFlightForTests } from "../src/models/refresh.ts";

const dirs: string[] = [];
beforeEach(() => { clearRefreshSingleFlightForTests(); });
afterEach(() => {
  clearRefreshSingleFlightForTests();
  for (const d of dirs.splice(0)) {
    for (let i = 0; i < 5; i++) {
      try { rmSync(d, { recursive: true, force: true }); break; } catch { Bun.sleepSync(50 * (i + 1)); }
    }
  }
});

function breakClaim(): ReturnType<typeof resolvePaths> {
  const dir = mkdtempSync(join(tmpdir(), "gorouter-r3008-"));
  dirs.push(dir);
  const paths = resolvePaths(dir);
  ensureStateDirs(paths);
  // A FILE where the state directory was: exclusive-create under it throws
  // a non-EEXIST filesystem error (ENOENT on Windows) on every platform,
  // standing in for the EACCES/ENOSPC/EROFS class the audit names. (A
  // directory at the claim path throws EEXIST on Windows - the held-lock
  // path, not a claim failure - so it cannot serve here.)
  rmSync(paths.state, { recursive: true, force: true });
  writeFileSync(paths.state, "not-a-directory");
  return paths;
}

const OPTS = { upstreamGo: "http://127.0.0.1:1", upstreamZen: "http://127.0.0.1:1", refreshWaitMs: 2000 };

describe("R3-008 refresh claim error truthfulness", () => {
  test("claim failure is explicit, fast, and never a busy report", async () => {
    const paths = breakClaim();
    const t0 = Date.now();
    const r = await refreshRegistry(paths, { ...OPTS });
    const elapsed = Date.now() - t0;
    expect(r.success).toBe(false);
    expect(r.error ?? "").toMatch(/lock claim failed/);
    expect(r.error ?? "").not.toMatch(/another models refresh is in progress/);
    expect(elapsed).toBeLessThan(2000);
  });

  test("forced refresh with a broken claim also fails explicitly", async () => {
    const paths = breakClaim();
    const r = await refreshRegistry(paths, { ...OPTS, forced: true });
    expect(r.success).toBe(false);
    expect(r.error ?? "").toMatch(/lock claim failed/);
    expect(r.error ?? "").not.toMatch(/another models refresh is in progress/);
  });
});
