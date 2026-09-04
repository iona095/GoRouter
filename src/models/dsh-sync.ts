/**
 * Slice B / B.1 — DSH reconciliation orchestrator (revision-aware, coherent, failure-isolated).
 *
 * B.1: reconciliation is approval-gated. Eligibility is derived from the
 * persistent operator approval store — never from "current DSH membership is
 * the known authority". An uninitialized store means legacy/manual DSH state
 * has not been ratified: no mutation, migration-required status. A corrupt or
 * unsupported-version store fails closed. Both owned provider bindings must
 * validate before any mutation; either invalid means no partial two-lane
 * publication.
 */

import type { RegistryFile, ModelEntry } from "./types.ts";
import { MAX_REVISION_RETRIES, emptyDshSyncStatus } from "./dsh-types.ts";
import type { DshSyncStatus } from "./dsh-types.ts";
import type { DshClient, DshSnapshot } from "./dsh-client.ts";
import { isConflictError } from "./dsh-client.ts";
import { deriveApprovalDesiredDshState, isSemanticNoOp } from "./dsh-eligibility.ts";
import { OWNED_DSH_PROVIDERS, type ApprovalStoreLoad } from "./dsh-approvals.ts";
import { checkOwnedProviderBindings } from "./dsh-binding.ts";
import { redact, log } from "../util.ts";

export interface DshSyncState {
  status: DshSyncStatus;
  /** Monotonic attempt counter for observability. */
  attemptCount: number;
}

export interface DshSyncOptions {
  /** Canonical GoRouter listener port for the owned-binding guard. */
  expectedPort?: number;
  /** Injected approval store view (callers load it from the real store). */
  approvalStore?: ApprovalStoreLoad;
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

/** Approval ids matching the lane's EXACT current owned tuple (provider+protocol). */
function approvedIdsFor(lane: "go" | "zen", store: ApprovalStoreLoad): Set<string> {
  const owned = OWNED_DSH_PROVIDERS[lane];
  const ids = new Set<string>();
  if (store.state === "initialized") {
    for (const r of store.store.approvals) {
      if (r.lane === lane && r.dshProviderId === owned.providerId && r.apiProtocol === owned.apiProtocol) {
        ids.add(r.modelId);
      }
    }
  }
  return ids;
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

function approvalGateStatus(
  approvals: ApprovalStoreLoad,
  registry: RegistryFile,
  attemptAt: string,
): DshSyncStatus | null {
  if (approvals.state === "initialized") return null;
  if (approvals.state === "absent") {
    // State A: legacy/manual DSH state not yet ratified. Never mutate the
    // owned arrays — preserve them byte/semantically and surface the gate.
    return {
      ...emptyDshSyncStatus(),
      reachable: null,
      lastAttemptAt: attemptAt,
      outcome: "blocked",
      mutationPerformed: false,
      lastError: "approval store uninitialized: legacy DSH state requires migration ratification (gorouter models approvals migrate)",
      approvalsInitialized: false,
      migrationRequired: true,
      bindingValid: null,
      bindingError: null,
      activeGoCount: null,
      activeZenCount: null,
      withheldGoCount: registry.go?.models.length ?? 0,
      withheldZenCount: registry.zen?.models.length ?? 0,
      approvedAbsentGoCount: null,
      approvedAbsentZenCount: null,
    };
  }
  const reason = approvals.state === "corrupt"
    ? `approval store corrupt (${approvals.reason}) — fail closed; fix or remove the file manually; it was NOT auto-reset`
    : `approval store schema version ${approvals.version} unsupported — fail closed; migrate the file manually`;
  return {
    ...emptyDshSyncStatus(),
    reachable: null,
    lastAttemptAt: attemptAt,
    outcome: "error",
    mutationPerformed: false,
    lastError: reason,
    approvalsInitialized: false,
    migrationRequired: false,
    bindingValid: null,
    bindingError: null,
    activeGoCount: null,
    activeZenCount: null,
    withheldGoCount: null,
    withheldZenCount: null,
    approvedAbsentGoCount: null,
    approvedAbsentZenCount: null,
  };
}

async function doReconcile(
  registry: RegistryFile,
  client: DshClient,
  opts: DshSyncOptions,
  persist: ((s: DshSyncStatus) => void) | undefined,
  _loadStatus: (() => DshSyncStatus | null) | undefined,
): Promise<DshSyncStatus> {
  const attemptAt = nowIso();
  const expectedPort = opts.expectedPort ?? 8787;

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

  const approvals: ApprovalStoreLoad = opts.approvalStore ?? { state: "absent" };
  const gate = approvalGateStatus(approvals, registry, attemptAt);
  if (gate) {
    if (persist) try { persist(gate); } catch {}
    return gate;
  }

  const regGoIds = (registry.go!.models ?? []).map((m) => m.id);
  const regZenIds = (registry.zen!.models ?? []).map((m) => m.id);
  const approvedGo = approvedIdsFor("go", approvals);
  const approvedZen = approvedIdsFor("zen", approvals);

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
      approvalsInitialized: true,
      migrationRequired: false,
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
      approvalsInitialized: true,
      migrationRequired: false,
    };
    if (persist) try { persist(status); } catch {}
    return status;
  }

  // Provider-binding safety guard: BOTH owned bindings must be valid;
  // one invalid owned provider means no partial two-lane mutation.
  const binding = checkOwnedProviderBindings(snapshot, expectedPort);
  if (!binding.valid) {
    const bad = [binding.go, binding.zen].filter((b) => !b.valid).map((b) => `${b.lane}: ${b.reason}`).join("; ");
    log.warn(`dsh sync blocked by invalid owned provider binding: ${redact(bad)}`);
    const status: DshSyncStatus = {
      ...emptyDshSyncStatus(),
      reachable: true,
      lastAttemptAt: attemptAt,
      outcome: "error",
      mutationPerformed: false,
      lastError: `owned provider binding invalid — fail closed: ${redact(bad)}`,
      approvalsInitialized: true,
      migrationRequired: false,
      bindingValid: false,
      bindingError: redact(bad),
      activeGoCount: snapshot.go.length,
      activeZenCount: snapshot.zen.length,
      withheldGoCount: null,
      withheldZenCount: null,
    };
    if (persist) try { persist(status); } catch {}
    return status;
  }

  const deriveFor = (snap: DshSnapshot) =>
    deriveApprovalDesiredDshState({
      currentGo: snap.go,
      currentZen: snap.zen,
      registryGo: registry.go!.models ?? [],
      registryZen: registry.zen!.models ?? [],
      approvedGoIds: approvedGo,
      approvedZenIds: approvedZen,
    });

  // Sanitizer refusals are operator-visible: without this an approved id
  // would sit in no bucket (not desired, withheld, or absent) and the sync
  // would perpetually withhold it for no visible reason. Warned on every
  // fresh derive (initial + conflict-retry re-derives), so an id that becomes
  // unrepresentable only on a later view cannot go silent.
  const warnSanitizedOut = (d: { sanitizedOutGo: string[]; sanitizedOutZen: string[] }): void => {
    if (d.sanitizedOutGo.length > 0 || d.sanitizedOutZen.length > 0) {
      log.warn(`dsh sync withheld by sanitizer (approved but unrepresentable): go=[${d.sanitizedOutGo.join(",")}] zen=[${d.sanitizedOutZen.join(",")}]`);
    }
  };
  let derived = deriveFor(snapshot);
  let observedRevision = snapshot.revision;
  warnSanitizedOut(derived);

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
      approvalsInitialized: true,
      migrationRequired: false,
      bindingValid: true,
      bindingError: null,
      approvedAbsentGoCount: derived.approvedAbsentGo.length,
      approvedAbsentZenCount: derived.approvedAbsentZen.length,
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
          approvalsInitialized: true,
          migrationRequired: false,
          bindingValid: true,
          bindingError: null,
          approvedAbsentGoCount: derived.approvedAbsentGo.length,
          approvedAbsentZenCount: derived.approvedAbsentZen.length,
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
          approvalsInitialized: true,
          migrationRequired: false,
          bindingValid: true,
          bindingError: null,
          approvedAbsentGoCount: derived.approvedAbsentGo.length,
          approvedAbsentZenCount: derived.approvedAbsentZen.length,
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
          approvalsInitialized: true,
          migrationRequired: false,
          bindingValid: true,
          bindingError: null,
          approvedAbsentGoCount: derived.approvedAbsentGo.length,
          approvedAbsentZenCount: derived.approvedAbsentZen.length,
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
        withheldZenCount: derived.withheldZen.length,
        lastError: null,
        activeGoCount: derived.desiredGo.length,
        activeZenCount: derived.desiredZen.length,
        withheldGoCount: derived.withheldGo.length,
        approvalsInitialized: true,
        migrationRequired: false,
        bindingValid: true,
        bindingError: null,
        approvedAbsentGoCount: derived.approvedAbsentGo.length,
        approvedAbsentZenCount: derived.approvedAbsentZen.length,
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
            approvalsInitialized: true,
            migrationRequired: false,
            bindingValid: true,
            bindingError: null,
            approvedAbsentGoCount: derived.approvedAbsentGo.length,
            approvedAbsentZenCount: derived.approvedAbsentZen.length,
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
              approvalsInitialized: true,
              migrationRequired: false,
              bindingValid: null,
              bindingError: null,
            };
            if (persist) try { persist(status); } catch {}
            return status;
          }
          // Binding guard re-checks on the fresh view — a re-point mid-retry fails closed.
          const freshBinding = checkOwnedProviderBindings(fresh, expectedPort);
          if (!freshBinding.valid) {
            const bad = [freshBinding.go, freshBinding.zen].filter((b) => !b.valid).map((b) => `${b.lane}: ${b.reason}`).join("; ");
            const status: DshSyncStatus = {
              ...emptyDshSyncStatus(),
              reachable: true,
              lastAttemptAt: attemptAt,
              outcome: "error",
              mutationPerformed: false,
              lastError: `owned provider binding invalid on conflict retry — fail closed: ${redact(bad)}`,
              approvalsInitialized: true,
              migrationRequired: false,
              bindingValid: false,
              bindingError: redact(bad),
              activeGoCount: fresh.go.length,
              activeZenCount: fresh.zen.length,
            };
            if (persist) try { persist(status); } catch {}
            return status;
          }
          snapshot = fresh;
          observedRevision = fresh.revision;
          derived = deriveFor(fresh);
          warnSanitizedOut(derived);
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
              approvalsInitialized: true,
              migrationRequired: false,
              bindingValid: true,
              bindingError: null,
              approvedAbsentGoCount: derived.approvedAbsentGo.length,
              approvedAbsentZenCount: derived.approvedAbsentZen.length,
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
            approvalsInitialized: true,
            migrationRequired: false,
            bindingValid: null,
            bindingError: null,
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
        approvalsInitialized: true,
        migrationRequired: false,
        bindingValid: true,
        bindingError: null,
        approvedAbsentGoCount: derived.approvedAbsentGo.length,
        approvedAbsentZenCount: derived.approvedAbsentZen.length,
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
    approvalsInitialized: true,
    migrationRequired: false,
    bindingValid: true,
    bindingError: null,
  };
  if (persist) try { persist(status); } catch {}
  return status;
}
