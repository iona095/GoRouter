/**
 * Slice B — DSH reconciliation orchestrator (revision-aware, coherent, failure-isolated).
 */

import type { RegistryFile, ModelEntry } from "./types.ts";
import { MAX_REVISION_RETRIES, emptyDshSyncStatus } from "./dsh-types.ts";
import type { DshSyncStatus } from "./dsh-types.ts";
import type { DshClient, DshSnapshot } from "./dsh-client.ts";
import { isConflictError } from "./dsh-client.ts";
import { deriveDesiredDshState, isSemanticNoOp } from "./dsh-eligibility.ts";
import { redact, log } from "../util.ts";

export interface DshSyncState {
  status: DshSyncStatus;
  /** Monotonic attempt counter for observability. */
  attemptCount: number;
}

export interface DshSyncOptions {
  knownGoIds?: Set<string>;
  knownZenIds?: Set<string>;
}

// Single-flight for concurrent syncs
let inFlight: Promise<DshSyncStatus> | null = null;

export function clearDshSyncSingleFlightForTests(): void {
  inFlight = null;
}

function nowIso(): string {
  return new Date().toISOString();
}

function sanitizeError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return redact(msg).slice(0, 500);
}

function isAuthoritative(registry: RegistryFile): boolean {
  return registry.go !== null && registry.zen !== null;
}

/**
 * Reconcile an authoritative registry into DSH live catalogs.
 * Must be called only after a successful authoritative registry publication.
 * Failure is isolated: registryPreserved always true on success path; never throws to rollback registry.
 */
export async function reconcileDshCatalog(
  registry: RegistryFile,
  client: DshClient,
  opts: DshSyncOptions = {},
  persist?: (status: DshSyncStatus) => void,
  loadStatus?: () => DshSyncStatus | null,
): Promise<DshSyncStatus> {
  if (inFlight) return inFlight;
  const p = doReconcile(registry, client, opts, persist, loadStatus).finally(() => {
    inFlight = null;
  });
  inFlight = p;
  return p;
}

async function doReconcile(
  registry: RegistryFile,
  client: DshClient,
  opts: DshSyncOptions,
  persist: ((s: DshSyncStatus) => void) | undefined,
  _loadStatus: (() => DshSyncStatus | null) | undefined,
): Promise<DshSyncStatus> {
  const attemptAt = nowIso();

  // Guard: non-authoritative registry must NOT mutate DSH
  if (!isAuthoritative(registry)) {
    const status: DshSyncStatus = {
      ...emptyDshSyncStatus(),
      reachable: null,
      lastAttemptAt: attemptAt,
      outcome: "pending",
      mutationPerformed: false,
      lastError: "non-authoritative registry: both lanes must be present",
      withheldGoCount: 0,
      withheldZenCount: 0,
    };
    if (persist) try { persist(status); } catch {}
    return status;
  }

  const regGoIds = (registry.go!.models ?? []).map((m) => m.id);
  const regZenIds = (registry.zen!.models ?? []).map((m) => m.id);
  const regGoMap = new Map(registry.go!.models.map((m) => [m.id, m] as const));
  const regZenMap = new Map(registry.zen!.models.map((m) => [m.id, m] as const));

  // Read latest DSH snapshot + revision
  let snapshot: DshSnapshot | null;
  try {
    snapshot = await client.read();
  } catch (e) {
    const sanitized = sanitizeError(e);
    log.warn(`dsh sync read failed (registry preserved): ${sanitized}`);
    const status: DshSyncStatus = {
      ...emptyDshSyncStatus(),
      reachable: false,
      lastAttemptAt: attemptAt,
      outcome: "pending",
      mutationPerformed: false,
      lastError: sanitized,
      activeGoCount: null,
      activeZenCount: null,
      withheldGoCount: null,
      withheldZenCount: null,
    };
    if (persist) try { persist(status); } catch {}
    return status;
  }

  if (!snapshot) {
    const status: DshSyncStatus = {
      ...emptyDshSyncStatus(),
      reachable: false,
      lastAttemptAt: attemptAt,
      outcome: "pending",
      mutationPerformed: false,
      lastError: "DSH not reachable or namespace not registered",
    };
    if (persist) try { persist(status); } catch {}
    return status;
  }

  const deriveFor = (snap: DshSnapshot) =>
    deriveDesiredDshState({
      currentGo: snap.go,
      currentZen: snap.zen,
      registryGoIds: regGoIds,
      registryZenIds: regZenIds,
      knownGoIds: opts.knownGoIds,
      knownZenIds: opts.knownZenIds,
      registryGoEntries: regGoMap,
      registryZenEntries: regZenMap,
    });

  let derived = deriveFor(snapshot);
  let observedRevision = snapshot.revision;

  // Semantic no-op -> zero mutation
  if (isSemanticNoOp(snapshot.go, snapshot.zen, derived.desiredGo, derived.desiredZen)) {
    const status: DshSyncStatus = {
      enabled: true,
      reachable: true,
      lastAttemptAt: attemptAt,
      lastSuccessAt: attemptAt,
      outcome: "no-op",
      mutationPerformed: false,
      observedRevision,
      committedRevision: observedRevision,
      activeGoCount: snapshot.go.length,
      activeZenCount: snapshot.zen.length,
      withheldGoCount: derived.withheldGo.length,
      withheldZenCount: derived.withheldZen.length,
      lastError: null,
    };
    if (persist) try { persist(status); } catch {}
    return status;
  }

  // Mutate with bounded retry on conflict
  let lastErrorSanitized: string | null = null;
  for (let attempt = 0; attempt <= MAX_REVISION_RETRIES; attempt++) {
    try {
      const res = await client.mutate(derived.desiredGo, derived.desiredZen, observedRevision);
      // Re-read and verify
      let committed: DshSnapshot | null;
      try {
        committed = await client.read();
      } catch (e) {
        const sanitized = sanitizeError(e);
        log.warn(`dsh sync verification read failed: ${sanitized}`);
        const status: DshSyncStatus = {
          enabled: true,
          reachable: true,
          lastAttemptAt: attemptAt,
          lastSuccessAt: null,
          outcome: "pending",
          mutationPerformed: true,
          observedRevision,
          committedRevision: res.revision,
          activeGoCount: derived.desiredGo.length,
          activeZenCount: derived.desiredZen.length,
          withheldGoCount: derived.withheldGo.length,
          withheldZenCount: derived.withheldZen.length,
          lastError: `verification read failed: ${sanitized}`,
        };
        if (persist) try { persist(status); } catch {}
        return status;
      }
      if (!committed) {
        const status: DshSyncStatus = {
          enabled: true,
          reachable: false,
          lastAttemptAt: attemptAt,
          lastSuccessAt: null,
          outcome: "pending",
          mutationPerformed: true,
          observedRevision,
          committedRevision: res.revision,
          activeGoCount: derived.desiredGo.length,
          activeZenCount: derived.desiredZen.length,
          withheldGoCount: derived.withheldGo.length,
          withheldZenCount: derived.withheldZen.length,
          lastError: "verification: DSH snapshot vanished",
        };
        if (persist) try { persist(status); } catch {}
        return status;
      }
      const ok = isSemanticNoOp(derived.desiredGo, derived.desiredZen, committed.go, committed.zen);
      if (!ok) {
        const status: DshSyncStatus = {
          enabled: true,
          reachable: true,
          lastAttemptAt: attemptAt,
          lastSuccessAt: null,
          outcome: "pending",
          mutationPerformed: true,
          observedRevision,
          committedRevision: committed.revision,
          activeGoCount: committed.go.length,
          activeZenCount: committed.zen.length,
          withheldGoCount: derived.withheldGo.length,
          withheldZenCount: derived.withheldZen.length,
          lastError: "verification mismatch: committed DSH state does not match desired",
        };
        if (persist) try { persist(status); } catch {}
        return status;
      }
      const status: DshSyncStatus = {
        enabled: true,
        reachable: true,
        lastAttemptAt: attemptAt,
        lastSuccessAt: attemptAt,
        outcome: "current",
        mutationPerformed: true,
        observedRevision,
        committedRevision: committed.revision,
        activeGoCount: derived.desiredGo.length,
        activeZenCount: derived.desiredZen.length,
        withheldGoCount: derived.withheldGo.length,
        withheldZenCount: derived.withheldZen.length,
        lastError: null,
      };
      if (persist) try { persist(status); } catch {}
      return status;
    } catch (e) {
      if (isConflictError(e)) {
        lastErrorSanitized = sanitizeError(e);
        if (attempt >= MAX_REVISION_RETRIES) {
          const status: DshSyncStatus = {
            enabled: true,
            reachable: true,
            lastAttemptAt: attemptAt,
            lastSuccessAt: null,
            outcome: "pending",
            mutationPerformed: false,
            observedRevision,
            committedRevision: null,
            activeGoCount: snapshot.go.length,
            activeZenCount: snapshot.zen.length,
            withheldGoCount: derived.withheldGo.length,
            withheldZenCount: derived.withheldZen.length,
            lastError: `revision conflict exhausted after ${MAX_REVISION_RETRIES} retries: ${lastErrorSanitized}`,
          };
          if (persist) try { persist(status); } catch {}
          return status;
        }
        // Re-read and re-derive
        try {
          const fresh = await client.read();
          if (!fresh) {
            const status: DshSyncStatus = {
              enabled: true,
              reachable: false,
              lastAttemptAt: attemptAt,
              outcome: "pending",
              mutationPerformed: false,
              observedRevision,
              committedRevision: null,
              activeGoCount: null,
              activeZenCount: null,
              withheldGoCount: derived.withheldGo.length,
              withheldZenCount: derived.withheldZen.length,
              lastError: "conflict retry: DSH snapshot vanished",
              lastSuccessAt: null,
            };
            if (persist) try { persist(status); } catch {}
            return status;
          }
          snapshot = fresh;
          observedRevision = fresh.revision;
          derived = deriveFor(fresh);
          if (isSemanticNoOp(fresh.go, fresh.zen, derived.desiredGo, derived.desiredZen)) {
            const status: DshSyncStatus = {
              enabled: true,
              reachable: true,
              lastAttemptAt: attemptAt,
              lastSuccessAt: attemptAt,
              outcome: "no-op",
              mutationPerformed: false,
              observedRevision,
              committedRevision: observedRevision,
              activeGoCount: fresh.go.length,
              activeZenCount: fresh.zen.length,
              withheldGoCount: derived.withheldGo.length,
              withheldZenCount: derived.withheldZen.length,
              lastError: null,
            };
            if (persist) try { persist(status); } catch {}
            return status;
          }
          log.warn(`dsh sync conflict, retry ${attempt + 1}/${MAX_REVISION_RETRIES}`);
          continue;
        } catch (re) {
          const sanitized = sanitizeError(re);
          const status: DshSyncStatus = {
            enabled: true,
            reachable: false,
            lastAttemptAt: attemptAt,
            outcome: "pending",
            mutationPerformed: false,
            observedRevision,
            committedRevision: null,
            activeGoCount: null,
            activeZenCount: null,
            withheldGoCount: derived.withheldGo.length,
            withheldZenCount: derived.withheldZen.length,
            lastError: `conflict retry read failed: ${sanitized}`,
            lastSuccessAt: null,
          };
          if (persist) try { persist(status); } catch {}
          return status;
        }
      }
      // Non-conflict error
      const sanitized = sanitizeError(e);
      log.warn(`dsh sync mutate failed (registry preserved): ${sanitized}`);
      const status: DshSyncStatus = {
        enabled: true,
        reachable: false,
        lastAttemptAt: attemptAt,
        outcome: "error",
        mutationPerformed: false,
        observedRevision,
        committedRevision: null,
        activeGoCount: snapshot.go.length,
        activeZenCount: snapshot.zen.length,
        withheldGoCount: derived.withheldGo.length,
        withheldZenCount: derived.withheldZen.length,
        lastError: sanitized,
        lastSuccessAt: null,
      };
      if (persist) try { persist(status); } catch {}
      return status;
    }
  }
  // Should not reach
  const status: DshSyncStatus = {
    enabled: true,
    reachable: true,
    lastAttemptAt: attemptAt,
    outcome: "pending",
    mutationPerformed: false,
    observedRevision,
    committedRevision: null,
    activeGoCount: snapshot.go.length,
    activeZenCount: snapshot.zen.length,
    withheldGoCount: derived.withheldGo.length,
    withheldZenCount: derived.withheldZen.length,
    lastError: lastErrorSanitized ?? "unknown",
    lastSuccessAt: null,
  };
  if (persist) try { persist(status); } catch {}
  return status;
}

function desiredLength(arr: ModelEntry[]): number { return arr.length; }
