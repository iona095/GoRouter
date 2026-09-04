/**
 * Slice B — narrow persisted DSH sync status (separate from authoritative registry).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteJson, log, quarantineCorruptFile } from "../util.ts";
import type { Paths } from "../paths.ts";
import { emptyDshSyncStatus, type DshSyncStatus } from "./dsh-types.ts";

export function dshSyncStatePathFor(paths: Paths): string {
  return (paths as unknown as { dshSyncStateJson?: string }).dshSyncStateJson ?? join(paths.state, "dsh-sync-state.json");
}

function pathFor(paths: Paths): string {
  const p = (paths as unknown as { dshSyncStateJson?: string }).dshSyncStateJson;
  if (p) return p;
  return join(paths.state, "dsh-sync-state.json");
}

export function loadDshSyncStatus(paths: Paths): DshSyncStatus | null {
  const p = pathFor(paths);
  if (!existsSync(p)) return null;
  try {
    const raw = readFileSync(p, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed !== "object" || parsed === null) return null;
    const s = parsed as Record<string, unknown>;
    if (typeof s.enabled !== "boolean") return null;
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

export function storeDshSyncStatus(paths: Paths, status: DshSyncStatus): void {
  const p = pathFor(paths);
  try {
    atomicWriteJson(p, status as unknown as Record<string, unknown>);
  } catch (e) {
    log.warn(`dsh sync state store failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export function defaultDshSyncStatus(): DshSyncStatus {
  return emptyDshSyncStatus();
}
