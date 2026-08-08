/**
 * GoRouter V1.5 — cross-process mutation lock.
 *
 * The CLI and the desktop control service are separate processes that both
 * mutate the shared state file through read-modify-write cycles. Atomic
 * writes prevent half-written files, but a lost update is still possible
 * when two writers race. This module serializes the whole
 * read → validate → mutate → write cycle across processes so a
 * deterministic committed result is observable after races (contract §8).
 *
 * Acquisition is exclusive-create based (O_CREAT|O_EXCL), which Windows
 * implements atomically. A stale lock (mtime older than 10s — e.g. a writer
 * that crashed mid-cycle) is reclaimed. Lock files live in the runtime state
 * directory, never in the repository.
 */
import { openSync, closeSync, writeSync, unlinkSync, statSync, existsSync, readFileSync } from "node:fs";

const STALE_MS = 10_000;
const RETRY_INTERVAL_MS = 10;

export function lockPathFor(stateDir: string): string {
  return `${stateDir}/.state.lock`;
}

function sleep(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    Bun.sleepSync(5);
  }
}

/**
 * A stale lock is reclaimed only when its recorded holder pid is no longer
 * alive (or the file is unparseable AND older than STALE_MS). A live holder
 * is never displaced, so a slow in-lock DPAPI cycle cannot open a
 * lost-update window (contract §8).
 */
function holderAlive(lockPath: string): boolean {
  try {
    const raw = readFileSync(lockPath, "utf8");
    const parsed = JSON.parse(raw) as { pid?: unknown };
    if (typeof parsed.pid === "number") {
      try {
        process.kill(parsed.pid, 0);
        return true;
      } catch {
        return false;
      }
    }
  } catch {
    // unparseable lock content: treat as stale only via mtime
  }
  return false;
}

/**
 * Run `fn` while holding the exclusive lock at `lockPath`.
 * Throws `Error("state lock timeout")` when the lock cannot be acquired
 * within `timeoutMs`; the caller surfaces this as a conflict.
 */
export function withFileLock<T>(lockPath: string, timeoutMs: number, fn: () => T): T {
  const deadline = Date.now() + timeoutMs;
  let fd: number | null = null;
  for (;;) {
    try {
      fd = openSync(lockPath, "wx");
      writeSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now() }));
      break;
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code !== "EEXIST") throw e;
      // existing lock: reclaim only when the holder is gone
      try {
        const st = statSync(lockPath);
        if (!holderAlive(lockPath) && Date.now() - st.mtimeMs > STALE_MS) {
          try { unlinkSync(lockPath); } catch { /* raced */ }
          continue;
        }
      } catch { continue; } // lock vanished between stat and now
      if (Date.now() >= deadline) throw new Error("state lock timeout");
      sleep(RETRY_INTERVAL_MS);
    }
  }
  try {
    return fn();
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* ignore */ }
      try { unlinkSync(lockPath); } catch { /* ignore */ }
    }
  }
}

/** Best-effort removal (used by reset/cleanup paths). */
export function removeStaleLock(lockPath: string): void {
  try {
    if (existsSync(lockPath)) unlinkSync(lockPath);
  } catch { /* ignore */ }
}
