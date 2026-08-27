/**
 * Slice B — eligibility / routability gate and deterministic ordering.
 *
 * DISCOVERY != ROUTABILITY. Unknown newly discovered IDs are withheld.
 */

import type { ModelEntry } from "./types.ts";

export interface EligibilityResult {
  desiredGo: ModelEntry[];
  desiredZen: ModelEntry[];
  withheldGo: string[];
  withheldZen: string[];
  /** Whether an eligible removal is required (active model absent from registry). */
  removalsGo: string[];
  removalsZen: string[];
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

/**
 * Derive desired DSH arrays from registry membership and local known IDs.
 *
 * @param currentGo - currently configured DSH go models (preserve overrides)
 * @param currentZen - currently configured DSH zen models
 * @param registryGoIds - authoritative registry go ids (sorted by registry)
 * @param registryZenIds - authoritative registry zen ids
 * @param knownGoIds - set of ids whose request semantics are known (defaults to currentGo ids)
 * @param knownZenIds - set of ids whose request semantics are known (defaults to currentZen ids)
 * @param registryGoEntries - optional registry ModelEntry objects to use as new model templates
 * @param registryZenEntries - optional registry ModelEntry objects
 */
export function deriveDesiredDshState(opts: {
  currentGo: ModelEntry[];
  currentZen: ModelEntry[];
  registryGoIds: string[];
  registryZenIds: string[];
  knownGoIds?: Set<string>;
  knownZenIds?: Set<string>;
  registryGoEntries?: Map<string, ModelEntry>;
  registryZenEntries?: Map<string, ModelEntry>;
}): EligibilityResult {
  const { currentGo, currentZen, registryGoIds, registryZenIds } = opts;
  const knownGo = opts.knownGoIds ?? new Set(currentGo.map((m) => m.id));
  const knownZen = opts.knownZenIds ?? new Set(currentZen.map((m) => m.id));

  const regGoSet = new Set(registryGoIds);
  const regZenSet = new Set(registryZenIds);

  const withheldGo = registryGoIds.filter((id) => !knownGo.has(id));
  const withheldZen = registryZenIds.filter((id) => !knownZen.has(id));

  // Surviving: currently configured eligible models that still exist in registry, preserving current order
  const survivingGo = currentGo.filter((m) => regGoSet.has(m.id));
  const survivingZen = currentZen.filter((m) => regZenSet.has(m.id));

  const survivingGoIds = new Set(survivingGo.map((m) => m.id));
  const survivingZenIds = new Set(survivingZen.map((m) => m.id));

  // Removals: currently configured but absent from registry (eligible removals)
  const removalsGo = currentGo.filter((m) => !regGoSet.has(m.id)).map((m) => m.id);
  const removalsZen = currentZen.filter((m) => !regZenSet.has(m.id)).map((m) => m.id);

  // Newly eligible: registry ids that are known, not already surviving, sorted deterministically
  const newlyGoIds = registryGoIds.filter((id) => knownGo.has(id) && !survivingGoIds.has(id)).sort();
  const newlyZenIds = registryZenIds.filter((id) => knownZen.has(id) && !survivingZenIds.has(id)).sort();

  const newlyGo: ModelEntry[] = newlyGoIds.map((id) => {
    const src = opts.registryGoEntries?.get(id);
    if (src) return { ...src };
    return { id, input: [], compat: { chatTemplateKwargs: {} } } as ModelEntry;
  });
  const newlyZen: ModelEntry[] = newlyZenIds.map((id) => {
    const src = opts.registryZenEntries?.get(id);
    if (src) return { ...src };
    return { id, input: [], compat: { chatTemplateKwargs: {} } } as ModelEntry;
  });

  return {
    desiredGo: [...survivingGo, ...newlyGo],
    desiredZen: [...survivingZen, ...newlyZen],
    withheldGo,
    withheldZen,
    removalsGo,
    removalsZen,
  };
}
