/**
 * Slice A — registry I/O (atomic persistence, validation, TTL/cooldown).
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteJson, log } from "../util.ts";
import { MODELS_SCHEMA_VERSION, MODELS_TTL_MS, MODELS_COOLDOWN_MS, type RegistryFile, type LaneSnapshot, type ModelEntry } from "./types.ts";
import type { Paths } from "../paths.ts";

export function registryPathFor(paths: Paths): string {
  return (paths as unknown as { modelsRegistryJson?: string }).modelsRegistryJson ?? join(paths.state, "models-registry.json");
}

function isModelEntry(v: unknown): v is ModelEntry {
  return typeof v === "object" && v !== null && typeof (v as Record<string, unknown>).id === "string" && ((v as Record<string, unknown>).id as string).length > 0;
}

function isLaneSnapshot(v: unknown): v is LaneSnapshot {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  if (typeof o.fetchedAtUtc !== "string") return false;
  if (!Array.isArray(o.models)) return false;
  // Validate Date parse and entries
  if (Number.isNaN(Date.parse(o.fetchedAtUtc as string))) return false;
  for (const m of o.models as unknown[]) if (!isModelEntry(m)) return false;
  // Duplicate check
  const ids = (o.models as ModelEntry[]).map((m) => m.id);
  if (new Set(ids).size !== ids.length) return false;
  return true;
}

function isAttemptInfo(v: unknown): boolean {
  if (v === null) return true;
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.atUtc === "string" && typeof o.success === "boolean" && (typeof o.httpStatus === "number" || o.httpStatus === null) && (typeof o.error === "string" || o.error === null) && typeof o.durationMs === "number";
}

export function validateRegistryFile(raw: unknown): RegistryFile | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (o.schemaVersion !== MODELS_SCHEMA_VERSION) return null;
  if (typeof o.updatedAtUtc !== "string" || Number.isNaN(Date.parse(o.updatedAtUtc as string))) return null;
  const go = o.go as unknown;
  const zen = o.zen as unknown;
  if (go !== null && !isLaneSnapshot(go)) return null;
  if (zen !== null && !isLaneSnapshot(zen)) return null;
  const la = o.lastAttempt as Record<string, unknown> | undefined;
  if (!la || typeof la !== "object") return null;
  if (!isAttemptInfo(la.go) || !isAttemptInfo(la.zen)) return null;
  if (la.combinedAtUtc !== null && (typeof la.combinedAtUtc !== "string" || Number.isNaN(Date.parse(la.combinedAtUtc as string)))) return null;
  const ld = o.lastDiff;
  if (!Array.isArray(ld)) return null;
  // Validate each diff entry has kind/lane/id
  for (const e of ld as unknown[]) {
    if (typeof e !== "object" || e === null) return null;
    const d = e as Record<string, unknown>;
    if (d.kind !== "MODEL_ADDED" && d.kind !== "MODEL_REMOVED" && d.kind !== "MODEL_CHANGED") return null;
    if (d.lane !== "go" && d.lane !== "zen") return null;
    if (typeof d.id !== "string" || d.id.length === 0) return null;
  }
  return raw as RegistryFile;
}

export function emptyRegistryFile(nowIso: string = new Date().toISOString()): RegistryFile {
  return {
    schemaVersion: MODELS_SCHEMA_VERSION,
    updatedAtUtc: nowIso,
    go: null,
    zen: null,
    lastAttempt: { go: null, zen: null, combinedAtUtc: null },
    lastDiff: [],
  };
}

export function loadRegistry(paths: Paths): RegistryFile | null {
  const r = peekRegistry(paths);
  return r.file;
}

// Slice B.2: mtime/size memo, same pattern as state.ts — /models is the only
// uncached file read on a request path. Keyed by path (tests use many state
// dirs); absent files are never cached so creation is observed immediately.
// CURRENT-010: identity includes ino (atomic registry replaces mint a new
// file identity — same-size/same-tick replacements never false-hit).
let peekCache: { path: string; mtimeMs: number; size: number; ino: number; result: { exists: boolean; corrupt: boolean; file: RegistryFile | null } } | null = null;

export function peekRegistry(paths: Paths): { exists: boolean; corrupt: boolean; file: RegistryFile | null } {
  const p = registryPathFor(paths);
  if (!existsSync(p)) {
    if (peekCache?.path === p) peekCache = null;
    return { exists: false, corrupt: false, file: null };
  }
  let sig: { mtimeMs: number; size: number; ino: number };
  try {
    const st = statSync(p);
    sig = { mtimeMs: st.mtimeMs, size: st.size, ino: st.ino };
  } catch {
    if (peekCache?.path === p) peekCache = null;
    return { exists: false, corrupt: false, file: null };
  }
  if (peekCache && peekCache.path === p && peekCache.mtimeMs === sig.mtimeMs && peekCache.size === sig.size && peekCache.ino === sig.ino) {
    return peekCache.result;
  }
  const result = peekRegistryUncached(p);
  peekCache = { path: p, mtimeMs: sig.mtimeMs, size: sig.size, ino: sig.ino, result };
  return result;
}

function peekRegistryUncached(p: string): { exists: boolean; corrupt: boolean; file: RegistryFile | null } {
  let raw: string;
  try {
    raw = readFileSync(p, "utf8");
  } catch (e) {
    log.warn(`models registry read failed: ${e instanceof Error ? e.message : String(e)}`);
    return { exists: true, corrupt: true, file: null };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    log.warn("models registry JSON corrupt; treating as absent");
    return { exists: true, corrupt: true, file: null };
  }
  const v = validateRegistryFile(parsed);
  if (!v) {
    log.warn("models registry schema invalid; treating as absent");
    return { exists: true, corrupt: true, file: null };
  }
  return { exists: true, corrupt: false, file: v };
}

export function storeRegistry(paths: Paths, file: RegistryFile): void {
  const p = registryPathFor(paths);
  atomicWriteJson(p, file);
}

// --- TTL / cooldown helpers (injectable now for tests) ---

export function registryAgeMs(file: RegistryFile, nowMs: number = Date.now()): number {
  const t = Date.parse(file.updatedAtUtc);
  if (Number.isNaN(t)) return Number.POSITIVE_INFINITY;
  return Math.max(0, nowMs - t);
}

export function isFresh(file: RegistryFile, nowMs: number = Date.now()): boolean {
  if (!file.go || !file.zen) return false;
  return registryAgeMs(file, nowMs) < MODELS_TTL_MS;
}

export function isCooldown(file: RegistryFile, nowMs: number = Date.now()): boolean {
  const ca = file.lastAttempt.combinedAtUtc;
  if (!ca) return false;
  const at = Date.parse(ca);
  if (Number.isNaN(at)) return false;
  // Cooldown only when last combined attempt was a failure (at least one lane failed)
  const lastGoOk = file.lastAttempt.go?.success ?? true;
  const lastZenOk = file.lastAttempt.zen?.success ?? true;
  const lastWasFailure = !(lastGoOk && lastZenOk);
  if (!lastWasFailure) return false;
  return nowMs - at < MODELS_COOLDOWN_MS;
}

export function cooldownRemainingMs(file: RegistryFile, nowMs: number = Date.now()): number {
  if (!isCooldown(file, nowMs)) return 0;
  const at = Date.parse(file.lastAttempt.combinedAtUtc!);
  return Math.max(0, MODELS_COOLDOWN_MS - (nowMs - at));
}

/**
 * Whether a non-forced refresh is allowed now.
 * Forced refresh bypasses TTL but still respects cooldown unless caller opts out.
 */
export function canRefresh(file: RegistryFile | null, nowMs: number = Date.now(), forced = false): boolean {
  if (!file) return true; // no registry => always allow
  if (!forced && isCooldown(file, nowMs)) return false;
  if (forced) return true;
  return !isFresh(file, nowMs);
}
