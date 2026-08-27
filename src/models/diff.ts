/**
 * Slice A — diff between registry snapshots.
 * Deterministic, no fake changes from reordering.
 */
import type { Lane } from "../state.ts";
import type { RegistryFile, DiffEntry, ModelEntry } from "./types.ts";

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k])).join(",") + "}";
}

/**
 * B.1 — semantic model equality. Exactly the TOP-LEVEL `created` field is
 * ignored: upstream `created` is volatile origin-generated metadata proven to
 * churn across otherwise-identical catalog refreshes. Every other field —
 * including id, object, owned_by and any future unknown metadata — remains
 * significant. Raw registry publication still preserves the latest `created`.
 */
function semanticModelStringify(m: ModelEntry): string {
  const rest = { ...m } as Record<string, unknown>;
  delete rest["created"];
  return stableStringify(rest);
}

function entriesEqual(a: ModelEntry, b: ModelEntry): boolean {
  return semanticModelStringify(a) === semanticModelStringify(b);
}

export function computeDiff(prev: RegistryFile | null, curr: RegistryFile): DiffEntry[] {
  const out: DiffEntry[] = [];
  const lanes: Lane[] = ["go", "zen"];
  for (const lane of lanes) {
    const p = lane === "go" ? prev?.go ?? null : prev?.zen ?? null;
    const c = lane === "go" ? curr.go : curr.zen;
    if (!c) continue;
    const pMap = new Map<string, ModelEntry>();
    const cMap = new Map<string, ModelEntry>();
    if (p) for (const m of p.models) pMap.set(m.id, m);
    for (const m of c.models) cMap.set(m.id, m);
    const ids = new Set<string>([...pMap.keys(), ...cMap.keys()]);
    for (const id of ids) {
      const hasPrev = pMap.has(id);
      const hasCurr = cMap.has(id);
      if (hasCurr && !hasPrev) {
        out.push({ kind: "MODEL_ADDED", lane, id, curr: cMap.get(id)! });
      } else if (!hasCurr && hasPrev) {
        out.push({ kind: "MODEL_REMOVED", lane, id, prev: pMap.get(id)! });
      } else if (hasCurr && hasPrev) {
        const a = pMap.get(id)!;
        const b = cMap.get(id)!;
        if (!entriesEqual(a, b)) out.push({ kind: "MODEL_CHANGED", lane, id, prev: a, curr: b });
      }
    }
  }
  // Deterministic order: lane, kind, id
  out.sort((x, y) => {
    if (x.lane !== y.lane) return x.lane < y.lane ? -1 : 1;
    if (x.kind !== y.kind) return x.kind < y.kind ? -1 : 1;
    return x.id < y.id ? -1 : x.id > y.id ? 1 : 0;
  });
  return out;
}
