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
import { randomUUID } from "node:crypto";

const STALE_MS = 10_000;
/**
 * Absolute reclaim ceiling (F-10): a recycled PID can make a dead holder
 * look alive to kill(pid, 0) forever, wedging the lock. No live holder
 * keeps the lock anywhere near this long (in-lock cycles are ms-scale),
 * so past this age the claim is reclaimed regardless of pid liveness.
 */
const ABSOLUTE_STALE_MS = 120_000;
const RETRY_INTERVAL_MS = 10;

export function lockPathFor(stateDir: string): string {
  return `${stateDir}/.state.lock`;
}

/**
 * CURRENT-003 — lock claim shape. Every acquisition mints a fresh `nonce`
 * (the ownership token); release unlinks only the claim carrying its own
 * nonce, so a late finally can never remove a successor's claim.
 */
interface LockClaim {
  pid: number;
  ts: number;
  nonce: string;
}

function readClaim(lockPath: string): LockClaim | null {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, "utf8")) as Partial<LockClaim>;
    if (typeof parsed.pid === "number" && typeof parsed.nonce === "string") {
      return { pid: parsed.pid, ts: typeof parsed.ts === "number" ? parsed.ts : 0, nonce: parsed.nonce };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Ownership predicate (exported as the CURRENT-003 test seam): true only
 * when the on-disk claim still carries `nonce`. Missing, unparseable, and
 * legacy nonce-less claims are never "owned" — release leaves them alone
 * (stale-claim reclaim on the acquire path handles orphans).
 */
export function isLockOwner(lockPath: string, nonce: string): boolean {
  return readClaim(lockPath)?.nonce === nonce;
}

/** Publish a claim on an already-open exclusive fd; returns the minted nonce. */
function writeClaim(fd: number): string {
  const nonce = randomUUID();
  writeSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now(), nonce } satisfies LockClaim));
  return nonce;
}

/**
 * Ownership-safe release: close the held fd, then unlink only when the
 * on-disk claim is still ours. A successor claim (reclaimed + re-acquired
 * while this holder was preempted past the absolute ceiling) is preserved.
 */
function releaseIfOwner(lockPath: string, fd: number | null, nonce: string | null): void {
  if (fd !== null) {
    try { closeSync(fd); } catch { /* ignore */ }
  }
  if (nonce === null) return;
  if (!isLockOwner(lockPath, nonce)) return;
  try { unlinkSync(lockPath); } catch { /* raced */ }
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
 *
 * Exported for the refresh-claim protocol (models/refresh.ts), which needs
 * the same liveness question for its own lock file.
 */
export function isLockHolderAlive(lockPath: string): boolean {
  try {
    const raw = readFileSync(lockPath, "utf8");
    const parsed = JSON.parse(raw) as { pid?: unknown };
    if (typeof parsed.pid === "number") {
      try {
        process.kill(parsed.pid, 0);
        return true;
      } catch (e) {
        // ESRCH: no such process (dead). Any other error — notably EPERM for
        // a live but unpermissioned pid (e.g. an elevated sibling) — must read
        // as ALIVE, or a 10s-old lock is reclaimed from a live holder.
        return (e as { code?: string }).code !== "ESRCH";
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
  let nonce: string | null = null;
  for (;;) {
    try {
      fd = openSync(lockPath, "wx");
      // CURRENT-003: mint the ownership token at publish.
      nonce = writeClaim(fd);
      break;
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code !== "EEXIST") throw e;
      // existing lock: reclaim when the holder is gone (fast path), or
      // past the absolute ceiling regardless of pid liveness (F-10: a
      // recycled PID can report a dead holder alive forever).
      try {
        const st = statSync(lockPath);
        const ageMs = Date.now() - st.mtimeMs;
        if (ageMs > ABSOLUTE_STALE_MS || (!isLockHolderAlive(lockPath) && ageMs > STALE_MS)) {
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
    // CURRENT-003: ownership-safe release (never a successor's claim).
    releaseIfOwner(lockPath, fd, nonce);
  }
}

/**
 * Async variant of withFileLock: identical exclusive-create + liveness
 * semantics, but the wait yields the event loop (Bun.sleep) instead of
 * busy-spinning it. REQUIRED for callers on a live server loop (e.g. an
 * async migration racing routine state writers): the sync variant would
 * freeze all request handling for up to timeoutMs on contention. Sync
 * contexts (domain mutations) keep withFileLock.
 */
export async function withFileLockAsync<T>(lockPath: string, timeoutMs: number, fn: () => T | Promise<T>): Promise<T> {
  return withFileLockAsyncAt(lockPath, { timeoutMs }, fn);
}

/** Tuning for withFileLockAsyncAt (CURRENT-006 reuse). */
export interface FileLockAtOptions {
  /** Acquire deadline in ms (waiters throw past it; the holder is untouched). */
  timeoutMs: number;
  /** Orphan reclaim age for a dead holder (default STALE_MS). */
  staleMs?: number;
  /** Absolute reclaim ceiling regardless of liveness (default ABSOLUTE_STALE_MS). */
  absoluteMs?: number;
  /** File mode for the claim file (default: process umask). */
  mode?: number;
  /** Timeout error message (default "state lock timeout"). */
  timeoutMessage?: string;
}

/**
 * Async exclusive lock at an arbitrary path with the shared ownership-safe
 * policy (CURRENT-003 nonce claims + CURRENT-006 reuse): exclusive-create,
 * dead-holder/absolute-ceiling reclaim, ownership-checked release, and the
 * CURRENT-003b settle-before-release guarantee. withFileLockAsync is the
 * state-lock specialization of this core.
 */
export async function withFileLockAsyncAt<T>(lockPath: string, opts: FileLockAtOptions, fn: () => T | Promise<T>): Promise<T> {
  const staleMs = opts.staleMs ?? STALE_MS;
  const absoluteMs = opts.absoluteMs ?? ABSOLUTE_STALE_MS;
  const timeoutMessage = opts.timeoutMessage ?? "state lock timeout";
  const deadline = Date.now() + opts.timeoutMs;
  let fd: number | null = null;
  let nonce: string | null = null;
  for (;;) {
    try {
      fd = opts.mode === undefined ? openSync(lockPath, "wx") : openSync(lockPath, "wx", opts.mode);
      // CURRENT-003: mint the ownership token at publish.
      nonce = writeClaim(fd);
      break;
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code !== "EEXIST") throw e;
      try {
        const st = statSync(lockPath);
        const ageMs = Date.now() - st.mtimeMs;
        if (ageMs > absoluteMs || (!isLockHolderAlive(lockPath) && ageMs > staleMs)) {
          try { unlinkSync(lockPath); } catch { /* raced */ }
          continue;
        }
      } catch { continue; }
      if (Date.now() >= deadline) throw new Error(timeoutMessage);
      await Bun.sleep(RETRY_INTERVAL_MS);
    }
  }
  try {
    // CURRENT-003b: `return await` (not bare `return`) so the claim is held
    // until an async fn SETTLES. A bare `return fn()` runs the finally while
    // the inner promise is still pending — releasing the lock mid-hold and
    // admitting a second holder into the critical section.
    return await fn();
  } finally {
    // CURRENT-003: ownership-safe release (never a successor's claim).
    releaseIfOwner(lockPath, fd, nonce);
  }
}
export function removeStaleLock(lockPath: string): void {
  try {
    if (existsSync(lockPath)) unlinkSync(lockPath);
  } catch { /* ignore */ }
}
