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

/**
 * Key-order-insensitive deep equality for JSON-shaped values (M4): entry
 * order in the array is significant (it is the operator's configured order),
 * but object key order is not — upstream registries and DSH files serialize
 * the same model with different key orders, and plain JSON.stringify would
 * report a phantom difference and rewrite the file on every sync.
 */
function jsonDeepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => jsonDeepEqual(v, (b as unknown[])[i]));
  }
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  const ka = Object.keys(ra).sort();
  const kb = Object.keys(rb).sort();
  if (ka.length !== kb.length) return false;
  return ka.every((k, i) => kb[i] === k && jsonDeepEqual(ra[k], rb[k]));
}

/** Deep equality for ModelEntry arrays (ordered). */
function entriesEqual(a: ModelEntry[], b: ModelEntry[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const av = a[i]!;
    const bv = b[i]!;
    if (av.id !== bv.id) return false;
    // Compare extra fields key-order-insensitively for override preservation
    if (!jsonDeepEqual(av, bv)) return false;
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

  // Upstream -> DSH-file boundary (H2): newly-eligible entries are copied from
  // upstream registry data, so sanitize before they reach another application's
  // config file. Survivors below come from the operator's own DSH file and keep
  // their overrides verbatim by contract.
  const newlyEntries: ModelEntry[] = newly
    .map((id) => sanitizeRegistryEntryForDsh(regMap.get(id)!))
    .filter((m): m is ModelEntry => m !== null);

  // Withheld: discovered (registry) but unapproved.
  const withheld = registry.filter((m) => !approvedIds.has(m.id)).map((m) => m.id);

  // Approved but absent upstream: inactive, approval retained.
  const approvedAbsent = [...approvedIds].filter((id) => !regMap.has(id)).sort();

  return { desired: [...desired, ...newlyEntries], withheld, removals, approvedAbsent };
}

/** Keys that must never flow from upstream data into another application's config file. */
const UNSAFE_DSH_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** Maximum serialized size of a single registry entry admitted into DSH files. */
export const MAX_DSH_ENTRY_BYTES = 8 * 1024;

function sanitizeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (UNSAFE_DSH_KEYS.has(k)) continue;
      out[k] = sanitizeValue(v);
    }
    return out;
  }
  return value;
}

/**
 * Boundary guard for the upstream -> DSH-file flow: strip
 * prototype-pollution-shaped keys (recursively) and refuse unbounded or
 * id-less entries. Returns null when the entry must not enter the DSH file;
 * such ids simply never become desired (fail closed — the sync never writes
 * what it cannot bound).
 */
export function sanitizeRegistryEntryForDsh(entry: ModelEntry): ModelEntry | null {
  if (typeof entry.id !== "string" || entry.id.length === 0 || entry.id.length > 256) return null;
  const clean = sanitizeValue(entry) as ModelEntry;
  if ((JSON.stringify(clean)?.length ?? 0) > MAX_DSH_ENTRY_BYTES) return null;
  return clean;
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
