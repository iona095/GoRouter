/**
 * B.1 — one-time legacy DSH migration (PREVIEW -> EXPLICIT RATIFICATION -> APPLY).
 *
 * Migration authority is limited to the current model membership of the two
 * owned DSH providers (gorouter-go.models, gorouter-zen.models). Nothing from
 * gorouter-go-responses, openrouter, static catalogs, live-discovered extras,
 * cross-lane unions or name similarity may become a candidate.
 *
 * The proposal identifier is a deterministic SHA-256 bound to the exact
 * candidate set AND the owned-provider bindings (api protocol + baseURL) AND
 * the observed DSH settings revision. Apply re-reads settings, re-derives the
 * candidates, re-checks bindings and re-computes the identifier — any
 * material drift rejects the apply with zero writes.
 */
import { createHash } from "node:crypto";
import { OWNED_DSH_PROVIDERS, initializeApprovalStore, loadApprovalStore } from "./dsh-approvals.ts";
import { checkOwnedProviderBindings, type BindingCheck } from "./dsh-binding.ts";
import type { ApprovalTuple } from "./dsh-approvals.ts";
import type { Lane } from "../state.ts";
import type { DshSnapshot } from "./dsh-client.ts";
import type { Paths } from "../paths.ts";

export type MigrationCandidate = ApprovalTuple;

export interface MigrationPreview {
  proposalId: string;
  candidates: MigrationCandidate[];
  bindings: BindingCheck;
  revision: number;
  computedAtUtc: string;
}

export type MigrationApplyResult =
  | { ok: true; candidates: MigrationCandidate[]; proposalId: string }
  | { ok: false; reason: string };

function laneCandidates(lane: Lane, snapshot: DshSnapshot): MigrationCandidate[] {
  const owned = OWNED_DSH_PROVIDERS[lane];
  const models = lane === "go" ? snapshot.go : snapshot.zen;
  return models
    .filter((m) => typeof m.id === "string" && m.id.length > 0)
    .map((m) => ({ lane, dshProviderId: owned.providerId, apiProtocol: owned.apiProtocol, modelId: m.id }));
}

/**
 * Deterministic proposal identifier bound to candidates + bindings + revision.
 * Only owned bindings participate — unowned providers cannot influence it.
 */
export function migrationProposalId(candidates: MigrationCandidate[], bindings: BindingCheck, revision: number): string {
  const material = {
    version: 1,
    bindings: {
      go: { api: bindings.go.api, baseURL: bindings.go.baseURL, valid: bindings.go.valid },
      zen: { api: bindings.zen.api, baseURL: bindings.zen.baseURL, valid: bindings.zen.valid },
    },
    revision,
    candidates: [...candidates]
      .map((c) => [c.lane, c.dshProviderId, c.apiProtocol, c.modelId])
      .sort((a, b) => (a.join("|") < b.join("|") ? -1 : a.join("|") > b.join("|") ? 1 : 0)),
  };
  return createHash("sha256").update(JSON.stringify(material)).digest("hex");
}
function deriveCandidates(snapshot: DshSnapshot): MigrationCandidate[] {
  return [...laneCandidates("go", snapshot), ...laneCandidates("zen", snapshot)].sort((a, b) => {
    const ka = `${a.lane}|${a.modelId}`;
    const kb = `${b.lane}|${b.modelId}`;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

/** Read-only preview: exact candidate tuples + deterministic proposal id. */
export function computeMigrationPreview(snapshot: DshSnapshot, expectedPort: number, nowIso: string): MigrationPreview {
  const bindings = checkOwnedProviderBindings(snapshot, expectedPort);
  const candidates = deriveCandidates(snapshot);
  return {
    proposalId: migrationProposalId(candidates, bindings, snapshot.revision),
    candidates,
    bindings,
    revision: snapshot.revision,
    computedAtUtc: nowIso,
  };
}

/**
 * APPLY — requires the exact previewed proposal id, an uninitialized approval
 * store, valid owned bindings, and an unchanged candidate set/bindings/
 * revision at apply time. Anything material changed => reject, write nothing.
 * One-time: refuses once the store exists in any state.
 *
 * The snapshot is read INSIDE apply (via readSnapshot) immediately before the
 * check-then-init sequence — callers cannot supply a stale or forged snapshot,
 * so the proposal comparison always runs against live DSH state.
 */
export async function applyMigration(
  paths: Paths,
  readSnapshot: () => Promise<DshSnapshot | null>,
  proposalId: string,
  expectedPort: number,
  opts: { nowIso?: string } = {},
): Promise<MigrationApplyResult> {
  if (typeof proposalId !== "string" || proposalId.length === 0) {
    return { ok: false, reason: "missing --proposal identifier" };
  }
  const store = loadApprovalStore(paths);
  if (store.state === "initialized") {
    return { ok: false, reason: "approval store already initialized; legacy migration is one-time and refuses to import additional entries" };
  }
  if (store.state === "corrupt") {
    return { ok: false, reason: `approval store corrupt (${store.reason}); refusing to migrate — fix or remove the file manually` };
  }
  if (store.state === "unsupported-version") {
    return { ok: false, reason: `approval store schema version ${store.version} unsupported; refusing to migrate` };
  }
  const snapshot = await readSnapshot();
  if (!snapshot) {
    return { ok: false, reason: "DSH settings not found or llm-pi-ai namespace missing" };
  }
  const bindings = checkOwnedProviderBindings(snapshot, expectedPort);
  if (!bindings.valid) {
    const bad = [bindings.go, bindings.zen].filter((b) => !b.valid).map((b) => `${b.lane}: ${b.reason}`).join("; ");
    return { ok: false, reason: `owned provider binding invalid — fail closed: ${bad}` };
  }
  const candidates = deriveCandidates(snapshot);
  const recomputed = migrationProposalId(candidates, bindings, snapshot.revision);
  if (recomputed !== proposalId) {
    return { ok: false, reason: "proposal mismatch: DSH settings, provider bindings or revision drifted since preview — re-run migration preview and ratify the new proposal" };
  }
  initializeApprovalStore(paths, candidates, "legacy-migration", opts);
  return { ok: true, candidates, proposalId };
}
