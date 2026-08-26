/**
 * Slice A — refresh orchestrator: transactional Go+Zen, single-flight, TTL/cooldown.
 */
import { join } from "node:path";
import { log } from "../util.ts";
import type { Paths } from "../paths.ts";
import type { Lane } from "../state.ts";
import { MODELS_SCHEMA_VERSION, MODELS_TTL_MS, MODELS_COOLDOWN_MS, type RegistryFile, type AttemptInfo } from "./types.ts";
import { loadRegistry, storeRegistry, isFresh, isCooldown, registryAgeMs, emptyRegistryFile } from "./registry.ts";
import { fetchLane, type FetchFn } from "./fetcher.ts";
import { computeDiff } from "./diff.ts";

export interface RefreshResult {
  success: boolean;
  registry: RegistryFile | null;
  error: string | null;
  fromCache: boolean;
  diff: ReturnType<typeof computeDiff>;
}

export interface RefreshOptions {
  fetchFn?: FetchFn;
  nowMs?: number;
  nowIso?: string;
  forced?: boolean;
  upstreamGo: string;
  upstreamZen: string;
}

// Single-flight state — module-level.
let inFlight: Promise<RefreshResult> | null = null;

export function clearRefreshSingleFlightForTests(): void {
  inFlight = null;
}

function attemptInfo(success: boolean, httpStatus: number | null, error: string | null, durationMs: number, atUtc: string): AttemptInfo {
  return { atUtc, success, httpStatus, error: error ? error.slice(0, 300) : null, durationMs };
}

function parseHttpStatus(errorMsg: string): number | null {
  const m = /status\s+(\d{3})/.exec(errorMsg);
  return m ? Number(m[1]) : null;
}

export async function refreshRegistry(paths: Paths, opts: RefreshOptions): Promise<RefreshResult> {
  // Single-flight: coalesce concurrent callers
  if (inFlight) return inFlight;
  const p = doRefresh(paths, opts).finally(() => {
    inFlight = null;
  });
  inFlight = p;
  return p;
}

async function doRefresh(paths: Paths, opts: RefreshOptions): Promise<RefreshResult> {
  const nowMs = opts.nowMs ?? Date.now();
  const nowIso = opts.nowIso ?? new Date(nowMs).toISOString();
  const prev = loadRegistry(paths);

  // Freshness / cooldown gating: automatic obeys TTL+cooldown, manual (forced) bypasses both
  if (prev) {
    if (!opts.forced && isCooldown(prev, nowMs)) {
      return { success: false, registry: prev, error: "cooldown: retry after " + Math.ceil((Date.parse(prev.lastAttempt.combinedAtUtc!) + MODELS_COOLDOWN_MS - nowMs) / 1000) + "s", fromCache: true, diff: [] };
    }
    if (!opts.forced && isFresh(prev, nowMs)) {
      const age = registryAgeMs(prev, nowMs);
      return { success: true, registry: prev, error: null, fromCache: true, diff: prev.lastDiff };
    }
  }

  // Transactional fetch: both lanes must succeed
  const started = opts.nowMs ?? Date.now();
  const laneResults: Record<Lane, { ok: boolean; snapshot?: import("./types.ts").LaneSnapshot; error?: string; httpStatus: number | null; durationMs: number }> = {
    go: { ok: false, httpStatus: null, durationMs: 0 },
    zen: { ok: false, httpStatus: null, durationMs: 0 },
  };

  async function fetchOne(lane: Lane, upstream: string): Promise<void> {
    const t0 = Date.now();
    try {
      const snap = await fetchLane(lane, upstream, { fetchFn: opts.fetchFn });
      // Override fetchedAtUtc to deterministic nowIso when caller provides it (tests)
      if (opts.nowIso) snap.fetchedAtUtc = nowIso;
      laneResults[lane] = { ok: true, snapshot: snap, error: undefined, httpStatus: 200, durationMs: Date.now() - t0 };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      laneResults[lane] = { ok: false, error: msg.slice(0, 300), httpStatus: parseHttpStatus(msg), durationMs: Date.now() - t0 };
    }
  }

  await Promise.all([fetchOne("go", opts.upstreamGo), fetchOne("zen", opts.upstreamZen)]);

  const combinedAtUtc = nowIso;
  const goAttempt = attemptInfo(laneResults.go.ok, laneResults.go.httpStatus, laneResults.go.error ?? null, laneResults.go.durationMs, combinedAtUtc);
  const zenAttempt = attemptInfo(laneResults.zen.ok, laneResults.zen.httpStatus, laneResults.zen.error ?? null, laneResults.zen.durationMs, combinedAtUtc);

  const allOk = laneResults.go.ok && laneResults.zen.ok;
  if (!allOk) {
    // Failure: preserve known-good snapshots, do NOT bump updatedAtUtc
    // On failure with no prev, publish an epoch-aged empty registry so isFresh=false
    // (retry allowed after cooldown, not blocked 24h). Spec: updatedAtUtc is last SUCCESS time.
    const toStore: RegistryFile = prev
      ? { ...prev, lastAttempt: { go: goAttempt, zen: zenAttempt, combinedAtUtc } }
      : {
          schemaVersion: MODELS_SCHEMA_VERSION,
          updatedAtUtc: "1970-01-01T00:00:00.000Z",
          go: null,
          zen: null,
          lastAttempt: { go: goAttempt, zen: zenAttempt, combinedAtUtc },
          lastDiff: [],
        };
    // If prev existed, keep its updatedAtUtc and snapshots; only lastAttempt advances (so TTL stays old, cooldown starts)
    if (prev) {
      // already spread; do not touch go/zen/updatedAtUtc/lastDiff
    } else {
      // First attempt failed and there was no prev: still write a failure file so cooldown applies
    }
    try {
      storeRegistry(paths, toStore);
    } catch (e) {
      log.error(`models registry store failed (failure record): ${e instanceof Error ? e.message : String(e)}`);
    }
    const firstError = laneResults.go.error ?? laneResults.zen.error ?? "unknown";
    return { success: false, registry: toStore, error: firstError, fromCache: false, diff: [] };
  }

  // Success: transactional publish
  const next: RegistryFile = {
    schemaVersion: MODELS_SCHEMA_VERSION,
    updatedAtUtc: nowIso,
    go: laneResults.go.snapshot!,
    zen: laneResults.zen.snapshot!,
    lastAttempt: { go: goAttempt, zen: zenAttempt, combinedAtUtc },
    lastDiff: [], // filled below
  };
  next.lastDiff = computeDiff(prev, next);
  try {
    storeRegistry(paths, next);
  } catch (e) {
    // Atomic write failure: do not claim success; preserve prev on disk (write failed)
    const msg = e instanceof Error ? e.message : String(e);
    log.error(`models registry store failed: ${msg}`);
    return { success: false, registry: prev, error: `persist failed: ${msg}`, fromCache: false, diff: [] };
  }
  return { success: true, registry: next, error: null, fromCache: false, diff: next.lastDiff };
}

/**
 * Startup trigger: if no registry or stale, kick off background refresh (non-blocking).
 * Returns the promise for callers that want to await; otherwise fire-and-forget.
 */
export function maybeRefreshOnStartup(paths: Paths, upstreamGo: string, upstreamZen: string, opts: { fetchFn?: FetchFn } = {}): Promise<RefreshResult> | null {
  const prev = loadRegistry(paths);
  const now = Date.now();
  if (prev && isFresh(prev, now)) return null;
  if (prev && isCooldown(prev, now)) return null;
  const p = refreshRegistry(paths, { upstreamGo, upstreamZen, fetchFn: opts.fetchFn }).catch((e) => {
    log.warn(`models startup refresh failed: ${e instanceof Error ? e.message : String(e)}`);
    return { success: false, registry: prev, error: e instanceof Error ? e.message : String(e), fromCache: false, diff: [] } as RefreshResult;
  });
  // Don't unhandled-reject: log
  p.then((r) => {
    if (r.success) log.info(`models registry refreshed on startup (${r.registry?.go?.models.length ?? 0} go, ${r.registry?.zen?.models.length ?? 0} zen)`);
    else log.warn(`models startup refresh: ${r.error}`);
  });
  return p;
}
