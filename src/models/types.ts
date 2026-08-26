/**
 * Slice A — Dynamic Model Registry types.
 *
 * Persistence via atomically-written JSON under the existing state dir
 * (see src/paths.ts / docs/model-registry-spec.md). No secrets are stored
 * here; only upstream model catalog snapshots and attempt metadata.
 */

import type { Lane } from "../state.ts";

export const MODELS_SCHEMA_VERSION = 1;

/** Freshness: 24h — after this a /models request triggers background refresh. */
export const MODELS_TTL_MS = 24 * 60 * 60 * 1000;

/** Retry cooldown after a failed refresh: 5m. */
export const MODELS_COOLDOWN_MS = 5 * 60 * 1000;

/** Upstream fetch timeout per lane. */
export const MODELS_FETCH_TIMEOUT_MS = 15_000;

export interface ModelEntry {
  id: string;
  [k: string]: unknown;
}

export interface LaneSnapshot {
  fetchedAtUtc: string;
  models: ModelEntry[];
}

export interface AttemptInfo {
  atUtc: string;
  success: boolean;
  httpStatus: number | null;
  error: string | null;
  durationMs: number;
}

export interface RegistryFile {
  schemaVersion: number;
  updatedAtUtc: string;
  go: LaneSnapshot | null;
  zen: LaneSnapshot | null;
  lastAttempt: { go: AttemptInfo | null; zen: AttemptInfo | null; combinedAtUtc: string | null };
  lastDiff: DiffEntry[];
}

export type DiffKind = "MODEL_ADDED" | "MODEL_REMOVED" | "MODEL_CHANGED";

export interface DiffEntry {
  kind: DiffKind;
  lane: Lane;
  id: string;
  prev?: ModelEntry | null;
  curr?: ModelEntry | null;
}
