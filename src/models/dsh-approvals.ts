/**
 * B.1 — persistent operator approval store for DSH catalog eligibility.
 *
 * Authority identity is exactly the four-field tuple:
 *   (lane, dshProviderId, apiProtocol, modelId)
 *
 * CRITICAL INITIALIZATION RULE: absence of the store file is NOT the same as
 * an initialized empty store. Absent = legacy/manual DSH state has not been
 * ratified; automatic reconciliation must not mutate owned DSH arrays.
 * Initialized (even with zero approvals) = explicit empty operator authority.
 *
 * Concurrency: every read-modify-write cycle runs under a dedicated
 * cross-process exclusive-create lock (same proven machinery as state.json),
 * and publication uses atomic temp+fsync+rename — a reader never observes a
 * partial file and a concurrent writer can never lose an update.
 *
 * Fail-closed: a corrupt or unsupported-version store is never silently
 * overwritten or auto-reset; it is preserved verbatim and surfaced as an
 * actionable error. No credentials are ever stored here.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteJson } from "../util.ts";
import { withFileLock } from "../lock.ts";
import type { Paths } from "../paths.ts";
import type { Lane } from "../state.ts";

export const APPROVALS_SCHEMA_VERSION = 1;

export const APPROVALS_LOCK_TIMEOUT_MS = 10_000;

/** Certified owned DSH provider binding per lane (contract §2.D). */
export const OWNED_DSH_PROVIDERS: Readonly<Record<Lane, { providerId: string; apiProtocol: string; lanePath: string }>> = {
  go: { providerId: "gorouter-go", apiProtocol: "openai-completions", lanePath: "/go/v1" },
  zen: { providerId: "gorouter-zen", apiProtocol: "openai-responses", lanePath: "/zen/v1" },
};

export type ApprovalSource = "operator" | "legacy-migration";

const APPROVAL_SOURCES: readonly ApprovalSource[] = ["operator", "legacy-migration"];

/** The exact persisted approval identity. */
export interface ApprovalTuple {
  lane: Lane;
  dshProviderId: string;
  apiProtocol: string;
  modelId: string;
}

export interface ApprovalRecord extends ApprovalTuple {
  approvedAtUtc: string;
  source: ApprovalSource;
}

export interface ApprovalStoreFile {
  version: number;
  initializedAtUtc: string;
  approvals: ApprovalRecord[];
}

export type ApprovalStoreLoad =
  | { state: "absent" }
  | { state: "corrupt"; reason: string }
  | { state: "unsupported-version"; version: number }
  | { state: "initialized"; store: ApprovalStoreFile };

export function approvalStorePathFor(paths: Paths): string {
  return (paths as unknown as { dshApprovalsJson?: string }).dshApprovalsJson ?? join(paths.state, "dsh-catalog-approvals.json");
}

function approvalsLockPath(paths: Paths): string {
  return join(paths.state, ".dsh-approvals.lock");
}

/** Canonical string form of the four-field identity (used for dedupe/order). */
export function tupleKey(t: ApprovalTuple): string {
  return JSON.stringify([t.lane, t.dshProviderId, t.apiProtocol, t.modelId]);
}

/** Deterministic persistence order: lane, provider, protocol, model id. */
export function sortTuples<T extends ApprovalTuple>(tuples: T[]): T[] {
  return [...tuples].sort((a, b) => {
    const ka = tupleKey(a);
    const kb = tupleKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

function asNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function validateStore(parsed: unknown): ApprovalStoreLoad {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { state: "corrupt", reason: "approval store root must be an object" };
  }
  const o = parsed as Record<string, unknown>;
  const version = o["version"];
  if (typeof version !== "number" || !Number.isFinite(version)) {
    return { state: "corrupt", reason: "missing or invalid version field" };
  }
  if (version !== APPROVALS_SCHEMA_VERSION) {
    return { state: "unsupported-version", version };
  }
  if (!asNonEmptyString(o["initializedAtUtc"])) {
    return { state: "corrupt", reason: "missing initializedAtUtc" };
  }
  if (!Array.isArray(o["approvals"])) {
    return { state: "corrupt", reason: "approvals must be an array" };
  }
  const seen = new Set<string>();
  const approvals: ApprovalRecord[] = [];
  for (const raw of o["approvals"]) {
    if (typeof raw !== "object" || raw === null) return { state: "corrupt", reason: "approval entry must be an object" };
    const r = raw as Record<string, unknown>;
    if (r["lane"] !== "go" && r["lane"] !== "zen") return { state: "corrupt", reason: "approval lane must be go or zen" };
    if (!asNonEmptyString(r["dshProviderId"])) return { state: "corrupt", reason: "approval dshProviderId missing" };
    if (!asNonEmptyString(r["apiProtocol"])) return { state: "corrupt", reason: "approval apiProtocol missing" };
    if (!asNonEmptyString(r["modelId"])) return { state: "corrupt", reason: "approval modelId missing" };
    if (!asNonEmptyString(r["approvedAtUtc"])) return { state: "corrupt", reason: "approval approvedAtUtc missing" };
    if (!APPROVAL_SOURCES.includes(r["source"] as ApprovalSource)) return { state: "corrupt", reason: "approval source invalid" };
    const rec: ApprovalRecord = {
      lane: r["lane"] as Lane,
      dshProviderId: r["dshProviderId"],
      apiProtocol: r["apiProtocol"],
      modelId: r["modelId"],
      approvedAtUtc: r["approvedAtUtc"],
      source: r["source"] as ApprovalSource,
    };
    const key = tupleKey(rec);
    if (seen.has(key)) return { state: "corrupt", reason: `duplicate approval identity: ${key}` };
    seen.add(key);
    approvals.push(rec);
  }
  return {
    state: "initialized",
    store: { version: APPROVALS_SCHEMA_VERSION, initializedAtUtc: o["initializedAtUtc"], approvals: sortTuples(approvals) },
  };
}

/**
 * Read-only load. Absent vs initialized-empty are distinct states.
 * Never mutates the file: corrupt/unsupported states are preserved verbatim
 * for operator inspection and every mutation refuses to touch them.
 */
export function loadApprovalStore(paths: Paths): ApprovalStoreLoad {
  const p = approvalStorePathFor(paths);
  if (!existsSync(p)) return { state: "absent" };
  let raw: string;
  try {
    raw = readFileSync(p, "utf8");
  } catch (e) {
    return { state: "corrupt", reason: `unreadable: ${e instanceof Error ? e.message : String(e)}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { state: "corrupt", reason: "invalid JSON" };
  }
  return validateStore(parsed);
}

function persistLocked(paths: Paths, store: ApprovalStoreFile): void {
  const out: ApprovalStoreFile = {
    version: APPROVALS_SCHEMA_VERSION,
    initializedAtUtc: store.initializedAtUtc,
    approvals: sortTuples(store.approvals),
  };
  atomicWriteJson(approvalStorePathFor(paths), out as unknown as Record<string, unknown>);
}

/**
 * One-time initialization. Refuses if the store file exists in ANY state
 * (initialized, corrupt, unsupported) — initialization happens exactly once.
 * Candidate tuples must be unique by the exact four-field identity.
 */
export function initializeApprovalStore(
  paths: Paths,
  tuples: ApprovalTuple[],
  source: ApprovalSource,
  opts: { nowIso?: string } = {},
): ApprovalStoreFile {
  const unique = new Map<string, ApprovalTuple>();
  for (const t of tuples) unique.set(tupleKey(t), t);
  const nowIso = opts.nowIso ?? new Date().toISOString();
  return withFileLock(approvalsLockPath(paths), APPROVALS_LOCK_TIMEOUT_MS, () => {
    const cur = loadApprovalStore(paths);
    if (cur.state !== "absent") {
      throw new Error(`approval store already exists (${cur.state}); initialization is one-time and refused`);
    }
    const store: ApprovalStoreFile = {
      version: APPROVALS_SCHEMA_VERSION,
      initializedAtUtc: nowIso,
      approvals: sortTuples([...unique.values()]).map((t) => ({ ...t, approvedAtUtc: nowIso, source })),
    };
    persistLocked(paths, store);
    return store;
  });
}

export interface ApproveOutcome {
  /** True when the exact tuple already existed (idempotent no-op). */
  duplicate: boolean;
  store: ApprovalStoreFile;
}

/**
 * Persist one operator-approved tuple. Requires an initialized store; absent/
 * corrupt/unsupported all refuse (the caller owns the first-initialization
 * policy). Idempotent for an exact tuple match.
 */
export function approveTuple(
  paths: Paths,
  tuple: ApprovalTuple,
  source: ApprovalSource,
  opts: { nowIso?: string } = {},
): ApproveOutcome {
  return withFileLock(approvalsLockPath(paths), APPROVALS_LOCK_TIMEOUT_MS, () => {
    const cur = loadApprovalStore(paths);
    if (cur.state === "absent") throw new Error("approval store not initialized; initialize via migration ratification or first explicit approval");
    if (cur.state === "corrupt") throw new Error(`approval store corrupt (${cur.reason}); refusing to mutate — fix or remove the file manually`);
    if (cur.state === "unsupported-version") throw new Error(`approval store schema version ${cur.version} unsupported; refusing to mutate — migrate the file manually`);
    const store = cur.store;
    const key = tupleKey(tuple);
    if (store.approvals.some((r) => tupleKey(r) === key)) {
      return { duplicate: true, store };
    }
    const rec: ApprovalRecord = { ...tuple, approvedAtUtc: opts.nowIso ?? new Date().toISOString(), source };
    const next: ApprovalStoreFile = { ...store, approvals: sortTuples([...store.approvals, rec]) };
    persistLocked(paths, next);
    return { duplicate: false, store: next };
  });
}

export interface RevokeOutcome {
  /** How many records matched (across historical protocol tuples). */
  removed: number;
  store: ApprovalStoreFile;
}

/**
 * Remove approval authority for (lane, owned provider, model id) — including
 * any historical protocol tuples for that same owned provider. The provider
 * is derived from the lane's certified owned binding, so an unintended
 * provider can never be revoked. Unowned providers are unreachable by
 * construction.
 */
export function revokeModelApproval(
  paths: Paths,
  req: { lane: Lane; modelId: string },
): RevokeOutcome {
  const owned = OWNED_DSH_PROVIDERS[req.lane];
  return withFileLock(approvalsLockPath(paths), APPROVALS_LOCK_TIMEOUT_MS, () => {
    const cur = loadApprovalStore(paths);
    if (cur.state === "absent") throw new Error("approval store not initialized; nothing to revoke");
    if (cur.state === "corrupt") throw new Error(`approval store corrupt (${cur.reason}); refusing to mutate — fix or remove the file manually`);
    if (cur.state === "unsupported-version") throw new Error(`approval store schema version ${cur.version} unsupported; refusing to mutate — migrate the file manually`);
    const store = cur.store;
    const kept = store.approvals.filter(
      (r) => !(r.lane === req.lane && r.dshProviderId === owned.providerId && r.modelId === req.modelId),
    );
    const removed = store.approvals.length - kept.length;
    if (removed > 0) {
      persistLocked(paths, { ...store, approvals: kept });
    }
    return { removed, store: { ...store, approvals: kept } };
  });
}
