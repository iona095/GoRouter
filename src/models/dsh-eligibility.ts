/**
 * Slice B / B.1 — eligibility / routability gate and deterministic ordering.
 *
 * DISCOVERY != ROUTABILITY. Unknown newly discovered IDs are withheld.
 *
 * B.1: desired DSH arrays are derived from the operator approval store, not
 * from "current DSH membership is the known authority". Eligibility for an
 * owned lane is: model present in that lane's registry snapshot AND an exact
 * (lane, owned provider, certified api protocol, model id) approval exists.
 * Approved-but-absent models go inactive (approval retained); identical
 * tuples reappearing become eligible again; currently configured eligible
 * survivors retain their existing relative order; newly eligible models are
 * added deterministically (sorted id).
 */

import type { ModelEntry } from "./types.ts";

export interface EligibilityResult {
  desiredGo: ModelEntry[];
  desiredZen: ModelEntry[];
  withheldGo: string[];
  withheldZen: string[];
  /** Ids removed from the currently configured arrays by this reconciliation. */
  removalsGo: string[];
  removalsZen: string[];
  /** Approved ids absent from the registry (inactive; approval retained). */
  approvedAbsentGo: string[];
  approvedAbsentZen: string[];
}

/** Deep equality for ModelEntry arrays (ordered). */
function entriesEqual(a: ModelEntry[], b: ModelEntry[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const av = a[i]!;
    const bv = b[i]!;
    if (av.id !== bv.id) return false;
    // Compare extra fields via stable stringify for override preservation check
    if (JSON.stringify(av) !== JSON.stringify(bv)) return false;
  }
  return true;
}

export function isSemanticNoOp(currentGo: ModelEntry[], currentZen: ModelEntry[], desiredGo: ModelEntry[], desiredZen: ModelEntry[]): boolean {
  return entriesEqual(currentGo, desiredGo) && entriesEqual(currentZen, desiredZen);
}

function deriveLane(
  current: ModelEntry[],
  registry: ModelEntry[],
  approvedIds: Set<string>,
): { desired: ModelEntry[]; withheld: string[]; removals: string[]; approvedAbsent: string[] } {
  const regMap = new Map(registry.map((m) => [m.id, m] as const));

  // Survivors: currently configured AND in registry AND approved (order preserved, overrides kept).
  const desired = current.filter((m) => approvedIds.has(m.id) && regMap.has(m.id));
  const desiredIds = new Set(desired.map((m) => m.id));

  // Removed from current config: unapproved-but-configured, or approved-but-absent.
  const removals = current.filter((m) => !desiredIds.has(m.id)).map((m) => m.id);

  // Newly eligible: approved, in registry, not currently configured (sorted deterministically).
  const newly = registry
    .filter((m) => approvedIds.has(m.id) && !desiredIds.has(m.id))
    .map((m) => m.id)
    .sort();

  const newlyEntries: ModelEntry[] = newly.map((id) => ({ ...regMap.get(id)! }));

  // Withheld: discovered (registry) but unapproved.
  const withheld = registry.filter((m) => !approvedIds.has(m.id)).map((m) => m.id);

  // Approved but absent upstream: inactive, approval retained.
  const approvedAbsent = [...approvedIds].filter((id) => !regMap.has(id)).sort();

  return { desired: [...desired, ...newlyEntries], withheld, removals, approvedAbsent };
}

/**
 * Derive approval-gated desired DSH arrays.
 *
 * @param approvedGoIds - model ids with an exact (go, gorouter-go, current certified api, id) approval
 * @param approvedZenIds - same for the zen owned provider
 */
export function deriveApprovalDesiredDshState(opts: {
  currentGo: ModelEntry[];
  currentZen: ModelEntry[];
  registryGo: ModelEntry[];
  registryZen: ModelEntry[];
  approvedGoIds: Set<string>;
  approvedZenIds: Set<string>;
}): EligibilityResult {
  const go = deriveLane(opts.currentGo, opts.registryGo, opts.approvedGoIds);
  const zen = deriveLane(opts.currentZen, opts.registryZen, opts.approvedZenIds);
  return {
    desiredGo: go.desired,
    desiredZen: zen.desired,
    withheldGo: go.withheld,
    withheldZen: zen.withheld,
    removalsGo: go.removals,
    removalsZen: zen.removals,
    approvedAbsentGo: go.approvedAbsent,
    approvedAbsentZen: zen.approvedAbsent,
  };
}
