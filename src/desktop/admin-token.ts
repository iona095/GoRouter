/**
 * GoRouter V1.5 — admin token lifecycle (contract §5.1).
 *
 * The admin token is a random 32-byte base64url value stored ONLY as a
 * DPAPI blob at <state>/secrets/sec_desktop_admin.bin through the existing
 * secret store. It authenticates every control-channel message; it is never
 * displayed, never logged, never in argv, never in OMP config.
 *
 * The blob is created exactly once: creation runs inside the cross-process
 * mutation lock so two concurrently starting services agree on one token,
 * and an existing blob is never overwritten (the shell's "reset desktop
 * control credential" flow deletes the blob, and the next service start
 * recreates it).
 */
import { randomBytes } from 'node:crypto'
import { withFileLock, lockPathFor } from '../lock.ts'
import type { Paths } from '../paths.ts'
import type { SecretStore } from '../secret-store.ts'

export const ADMIN_TOKEN_REF = 'sec_desktop_admin'
const ADMIN_TOKEN_LOCK_TIMEOUT_MS = 5_000

/**
 * Return the admin token, creating the DPAPI blob if absent. Never logs
 * the value.
 *
 * R3-005: the read fast-path runs OUTSIDE the mutation lock — a cold or
 * failing DPAPI decrypt (synchronous PowerShell, up to tens of seconds)
 * must never hold state mutations hostage. Only creation takes the lock,
 * with a re-check inside, so concurrently starting services still agree on
 * one token and an existing blob is never overwritten. A present-but-
 * unreadable blob fails closed (manual repair); it is never replaced.
 */
export function ensureAdminToken(paths: Paths, secrets: SecretStore): string {
  try {
    if (secrets.exists(ADMIN_TOKEN_REF)) return secrets.get(ADMIN_TOKEN_REF)
  } catch {
    // Missing/corrupt/failing read falls through to the locked section,
    // which re-checks and either reads, creates, or surfaces the failure.
    // (A just-recorded decrypt failure is nearly free on re-attempt thanks
    // to the store's negative failure cache.)
  }
  return withFileLock(lockPathFor(paths.state), ADMIN_TOKEN_LOCK_TIMEOUT_MS, () => {
    if (secrets.exists(ADMIN_TOKEN_REF)) {
      return secrets.get(ADMIN_TOKEN_REF)
    }
    const token = randomBytes(32).toString('base64url')
    secrets.put(ADMIN_TOKEN_REF, token)
    return token
  })
}
