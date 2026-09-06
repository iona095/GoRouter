/** R4-C02 validation: stale reclaim must not unlink a successor lock. */
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePaths, ensureStateDirs } from "../src/paths.ts";
import { refreshLockPath, tryClaimRefreshLock } from "../src/models/refresh.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function staleClaim(pid: number, nonce: string): string {
  return JSON.stringify({ pid, ts: Date.now() - 200_000, nonce });
}

describe("R4-C02 refresh-lock successor protection", () => {
  test("stale A never removes successor B (TOCTOU)", () => {
    const dir = mkdtempSync(join(tmpdir(), "gorouter-c02-")); dirs.push(dir);
    const paths = resolvePaths(dir); ensureStateDirs(paths);
    const lockPath = refreshLockPath(paths);
    // Stale orphan: dead pid, ancient mtime.
    writeFileSync(lockPath, staleClaim(999999999, "nonce-stale-A"));
    const ancient = new Date(Date.now() - 200_000);
    utimesSync(lockPath, ancient, ancient);
    // Between A stale-decision and unlink, B reclaims and owns a new lock.
    const successor = JSON.stringify({ pid: process.pid, ts: Date.now(), nonce: "nonce-successor-B" });
    const result = tryClaimRefreshLock(lockPath, { onStaleDecision: () => { writeFileSync(lockPath, successor); } });
    void result;
    // Successor must survive A.
    expect(existsSync(lockPath)).toBe(true);
    expect(readFileSync(lockPath, "utf8")).toBe(successor);
  });

  test("genuine stale orphan is still reclaimed", () => {
    const dir = mkdtempSync(join(tmpdir(), "gorouter-c02-")); dirs.push(dir);
    const paths = resolvePaths(dir); ensureStateDirs(paths);
    const lockPath = refreshLockPath(paths);
    writeFileSync(lockPath, staleClaim(999999999, "nonce-stale"));
    const ancient = new Date(Date.now() - 200_000);
    utimesSync(lockPath, ancient, ancient);
    const nonce = tryClaimRefreshLock(lockPath);
    expect(nonce).not.toBeNull();
    expect(JSON.parse(readFileSync(lockPath, "utf8")).nonce).toBe(nonce);
  });
});
