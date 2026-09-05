/**
 * CURRENT-003 — ownership-safe lock release.
 *
 * Claims carry a per-acquisition nonce; release unlinks only its own claim.
 * A late finally (preempted between close and unlink while another process
 * reclaimed and re-acquired) must never remove the successor's claim.
 * The ownership decision is covered deterministically through the isLockOwner
 * seam; the claim format and the preserved reclaim/normal paths run live.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withFileLock, withFileLockAsync, lockPathFor, isLockOwner } from "../src/lock.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function freshLock(): string {
  const dir = mkdtempSync(join(tmpdir(), "gorouter-lockown-"));
  dirs.push(dir);
  return lockPathFor(dir);
}

describe("CURRENT-003 ownership-safe release", () => {
  test("published claim carries pid + unique nonce (ownership token)", async () => {
    const lockPath = freshLock();
    let releaseGate!: () => void;
    const gate = new Promise<void>((r) => { releaseGate = r; });
    const h = withFileLockAsync(lockPath, 5_000, async () => {
      const raw = JSON.parse(readFileSync(lockPath, "utf8"));
      expect(typeof raw.pid).toBe("number");
      expect(typeof raw.nonce).toBe("string");
      expect(raw.nonce.length).toBeGreaterThan(8);
      await gate;
      return "held";
    });
    await Bun.sleep(50);
    releaseGate();
    expect(await h).toBe("held");
    expect(existsSync(lockPath)).toBe(false);
  });

  test("isLockOwner: own nonce true; alien/missing/garbage/legacy false", () => {
    const lockPath = freshLock();
    expect(isLockOwner(lockPath, "anything")).toBe(false); // missing
    writeFileSync(lockPath, "{ not json", "utf8");
    expect(isLockOwner(lockPath, "anything")).toBe(false); // garbage
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, ts: Date.now() }), "utf8");
    expect(isLockOwner(lockPath, "anything")).toBe(false); // legacy: no nonce
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, ts: Date.now(), nonce: "A" }), "utf8");
    expect(isLockOwner(lockPath, "A")).toBe(true);
    expect(isLockOwner(lockPath, "B")).toBe(false);
    // successor overwrites: predecessor's nonce no longer owns
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, ts: Date.now(), nonce: "B" }), "utf8");
    expect(isLockOwner(lockPath, "A")).toBe(false);
    expect(isLockOwner(lockPath, "B")).toBe(true);
  });

  test("orphan claim (dead holder) still reclaimed; live holder never displaced", async () => {
    const lockPath = freshLock();
    // Dead pid + 11s age: reclaimed.
    writeFileSync(lockPath, JSON.stringify({ pid: 2147483647, ts: Date.now() - 11_000, nonce: "orphan" }), "utf8");
    const ancient = new Date(Date.now() - 11_000);
    utimesSync(lockPath, ancient, ancient);
    expect(withFileLock(lockPath, 5_000, () => "reclaimed")).toBe("reclaimed");
    // Live holder (self pid) + fresh: never displaced, contender times out.
    let releaseGate!: () => void;
    const gate = new Promise<void>((r) => { releaseGate = r; });
    const h = withFileLockAsync(lockPath, 5_000, async () => {
      await gate;
      return "holder";
    });
    await Bun.sleep(50);
    await expect(withFileLockAsync(lockPath, 300, async () => "intruder")).rejects.toThrow(/state lock timeout/);
    releaseGate();
    expect(await h).toBe("holder");
  });
});
