/**
 * Slice B — narrow persisted DSH sync status (separate from authoritative registry).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteJson, log, quarantineCorruptFile } from "../util.ts";
import type { Paths } from "../paths.ts";
import { emptyDshSyncStatus, type DshSyncOutcome, type DshSyncStatus } from "./dsh-types.ts";

export function dshSyncStatePathFor(paths: Paths): string {
  return (paths as unknown as { dshSyncStateJson?: string }).dshSyncStateJson ?? join(paths.state, "dsh-sync-state.json");
}

function pathFor(paths: Paths): string {
  const p = (paths as unknown as { dshSyncStateJson?: string }).dshSyncStateJson;
  if (p) return p;
  return join(paths.state, "dsh-sync-state.json");
}

const VALID_OUTCOMES: readonly DshSyncOutcome[] = ["current", "no-op", "pending", "error", "blocked"];

function isBoolOrNull(v: unknown): boolean { return typeof v === "boolean" || v === null; }
function isStrOrNull(v: unknown): boolean { return typeof v === "string" || v === null; }
function isNumOrNull(v: unknown): boolean {
  return v === null || (typeof v === "number" && Number.isFinite(v));
}

/**
 * Strict shape validation (M9): the old check (`enabled` is boolean, cast
 * the rest) admitted any garbage object — downstream status readers then
 * branched on nonsense outcomes/counts. Unknown EXTRA fields are tolerated
 * (forward-compat); every KNOWN field must match its declared type or the
 * file is quarantined and treated as absent. Null is a valid "unknown"
 * for every nullable field.
 */
function isValidDshSyncStatus(s: Record<string, unknown>): boolean {
  if (typeof s.enabled !== "boolean") return false;
  if (!isBoolOrNull(s.reachable)) return false;
  if (!isStrOrNull(s.lastAttemptAt)) return false;
  if (!isStrOrNull(s.lastSuccessAt)) return false;
  if (typeof s.outcome !== "string" || !(VALID_OUTCOMES as readonly string[]).includes(s.outcome)) return false;
  if (typeof s.mutationPerformed !== "boolean") return false;
  for (const k of ["observedRevision", "committedRevision", "activeGoCount", "activeZenCount", "withheldGoCount", "withheldZenCount"] as const) {
    if (!isNumOrNull(s[k])) return false;
  }
  if (!isStrOrNull(s.lastError)) return false;
  if (s.approvalsInitialized !== undefined && !isBoolOrNull(s.approvalsInitialized)) return false;
  if (s.migrationRequired !== undefined && !isBoolOrNull(s.migrationRequired)) return false;
  if (s.bindingValid !== undefined && !isBoolOrNull(s.bindingValid)) return false;
  if (s.bindingError !== undefined && !isStrOrNull(s.bindingError)) return false;
  if (s.approvedAbsentGoCount !== undefined && !isNumOrNull(s.approvedAbsentGoCount)) return false;
  if (s.approvedAbsentZenCount !== undefined && !isNumOrNull(s.approvedAbsentZenCount)) return false;
  return true;
}

export function loadDshSyncStatus(paths: Paths): DshSyncStatus | null {
  const p = pathFor(paths);
  if (!existsSync(p)) return null;
  try {
    const raw = readFileSync(p, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed !== "object" || parsed === null) return null;
    const s = parsed as Record<string, unknown>;
    if (!isValidDshSyncStatus(s)) {
      log.warn(`dsh sync state shape invalid; quarantining as evidence (path=${p})`);
      quarantineCorruptFile(p, "dsh sync state");
      return null;
    }
    return parsed as unknown as DshSyncStatus;
  } catch (e) {
    log.warn(`dsh sync state read failed: ${e instanceof Error ? e.message : String(e)}`);
    // Quarantine the evidence (F-23, shared helper so both state files
    // prune identically) so the next store cannot silently overwrite the
    // only copy of the corrupt file. Best effort only.
    quarantineCorruptFile(p, "dsh sync state");
    return null;
  }
}

/**
 * Persist the status. THROWS on failure (M9: the old warn-and-swallow hid
 * unwritable state dirs). All production callers treat persistence as
 * best-effort observability and already catch — the throw only makes the
 * contract honest for callers that need to know.
 */
export function storeDshSyncStatus(paths: Paths, status: DshSyncStatus): void {
  atomicWriteJson(pathFor(paths), status as unknown as Record<string, unknown>);
}

export function defaultDshSyncStatus(): DshSyncStatus {
  return emptyDshSyncStatus();
}
