/**
 * GoRouter V1.5 — shared authoritative domain operations.
 *
 * Every state/secret mutation the product performs — CLI or desktop control
 * service — goes through this module so domain validation and destructive-
 * operation rules live in exactly one implementation (contract §5:
 * one authoritative set of domain operations; no GUI-side reimplementation).
 *
 * All read-modify-write cycles run inside the cross-process mutation lock
 * (src/lock.ts), so concurrent CLI and control-service writers serialize and
 * a deterministic committed result is observable after races (contract §8).
 *
 * Secrets never appear in returned values except where a credential is
 * explicitly the operation's product (setup/rotate local credential, probe).
 * Provider secrets are accepted as function arguments (from stdin in the
 * CLI, from the authenticated control channel in the desktop) and stored via
 * the DPAPI secret store; they are never logged or echoed.
 */
import { existsSync } from "node:fs";
import { ensureStateDirs, type Paths } from "./paths.ts";
import { generateLocalCredential, newRef, type SecretStore } from "./secret-store.ts";
import {
  createStateStore,
  defaultState,
  findAccount,
  findAccountById,
  findAccountByAlias,
  accountUsedByRoute,
  makeAccount,
  validateAlias,
  validateUpstreamUrl,
  isValidPort,
  isValidJournalMaxRecords,
  isValidRetentionDays,
  isVersionNumber,
  newStateGeneration,
  JOURNAL_MAX_RECORDS_MAX,
  JOURNAL_RETENTION_DAYS_MAX,
  LANES,
  type StateFile,
  type Lane,
  type AccountRecord,
} from "./state.ts";
import { isValidSecretRef } from "./secret-store.ts";
import { createJournal, type JournalStats } from "./journal.ts";
import { tryUnlink, redact, log } from "./util.ts";
import { registryPathFor, loadRegistry, peekRegistry, storeRegistry, registryAgeMs, isFresh, isCooldown, cooldownRemainingMs } from "./models/registry.ts";
import { refreshRegistry, type RefreshResult } from "./models/refresh.ts";
import { MODELS_TTL_MS, MODELS_COOLDOWN_MS, type RegistryFile, type ModelEntry, type DiffEntry } from "./models/types.ts";
import { emptyDshSyncStatus, type DshSyncStatus } from "./models/dsh-types.ts";
import { loadDshSyncStatus, storeDshSyncStatus } from "./models/dsh-sync-state.ts";
import { createDshClient, type DshClient } from "./models/dsh-client.ts";
import { reconcileDshCatalog } from "./models/dsh-sync.ts";
import { probeAccountKey, type ProbeResult } from "./probe.ts";
import {
  OWNED_DSH_PROVIDERS,
  loadApprovalStore,
  initializeApprovalStore,
  approveTuple,
  revokeModelApproval,
  type ApprovalTuple,
  type ApprovalRecord,
  type ApprovalStoreLoad,
} from "./models/dsh-approvals.ts";
import { checkOwnedProviderBindings, type LaneBindingCheck } from "./models/dsh-binding.ts";
import { computeMigrationPreview, applyMigration } from "./models/dsh-migration.ts";
import { withFileLock, lockPathFor } from "./lock.ts";

const MUTATE_LOCK_TIMEOUT_MS = 10_000;

export interface AccountView extends AccountRecord {
  secretPresent: boolean;
  usedBy: Lane[];
}

export interface RouteView {
  lane: Lane;
  accountId: string | null;
  /** alias when the selected account exists; null when none selected or dangling */
  alias: string | null;
  /** true when a lane points at an account id that no longer exists */
  accountMissing: boolean;
  /** W0 lane version (committed). */
  version: number;
}

/**
 * W0 machine-readable conflict reasons (contract 7.7). Thrown as
 * DomainConflict; the control layer maps them beneath wire code 'conflict'
 * (or not_found for identity misses) with the reason preserved.
 */
export type ConflictReason =
  | "state_generation_mismatch"
  | "route_version_mismatch"
  | "account_version_mismatch"
  | "account_in_use"
  | "alias_conflict"
  | "not_found"
  | "target_not_selectable";

export class DomainConflict extends Error {
  readonly reason: ConflictReason;
  constructor(reason: ConflictReason, message: string) {
    super(message);
    this.name = "DomainConflict";
    this.reason = reason;
  }
}

export function isDomainConflict(e: unknown): e is DomainConflict {
  return e instanceof DomainConflict;
}

/** Expected concurrency inputs for one checked mutation (contract 7). */
export interface CheckedExpectations {
  expectedStateGeneration: string;
}

/** Transaction-specific commit result (contract 7.8): captured from the locked
 * candidate, never from a post-lock re-read. */
export interface MutationCommit {
  changed: boolean;
  stateGeneration: string;
}

/** Committed route-selection result (contract 7.8). */
export interface RouteCommit extends MutationCommit {
  lane: Lane;
  routeVersion: number;
  accountId: string | null;
  targetAccountId: string | null;
  targetAccountVersion: number | null;
}

/** Committed account result (contract 7.8). */
export interface AccountCommit extends MutationCommit {
  account: CheckedAccount;
}

/** Committed rename result (contract 7.8). */
export interface RenameCommit extends AccountCommit {
  previousAlias: string;
}

/** Committed removal result (contract 7.8). */
export interface RemoveCommit extends MutationCommit {
  removedAccountId: string;
  removedAccountVersion: number;
  clearedLanes: { lane: Lane; routeVersion: number }[];
  secretDeleted: boolean;
}

/** Checked account identity returned by committing mutations (no secret material). */
export interface CheckedAccount {
  id: string;
  alias: string;
  version: number;
  secretPresent: boolean;
  usedBy: Lane[];
  createdAtUtc: string;
  updatedAtUtc: string;
}

export interface StatusView {
  initialized: boolean;
  localCredentialConfigured: boolean;
  stateCorrupt: boolean;
  /** On-disk schema version when it is not ours (GR-004 gate active). */
  stateUnsupportedVersion: number | null;
  /** W0: established lineage generation ("" when unestablished). */
  stateGeneration: string;
  /** W0: on-disk schema version as loaded (1 = legacy view, 2 = current). */
  schemaVersion: number;
  routes: RouteView[];
  accounts: AccountView[];
  settings: StateFile["settings"];
  journalExists: boolean;
  stateDir: string;
}

export interface ModelsStatusView {
  exists: boolean;
  corrupt: boolean;
  registry: RegistryFile | null;
  ageMs: number | null;
  ageHuman: string | null;
  ttlMs: number;
  cooldownMs: number;
  isFresh: boolean | null;
  isCooldown: boolean;
  cooldownRemainingMs: number;
  retryEligible: boolean;
  counts: Record<Lane, number>;
  diffSummary: { added: number; removed: number; changed: number; total: number; lastDiffAtUtc: string | null };
  lastAttempt: RegistryFile["lastAttempt"] | null;
  /** Slice B: DSH sync status (when available). */
  dshSync?: DshSyncStatus | null;
}

export interface ModelsListView {
  lane: Lane;
  count: number;
  fetchedAtUtc: string | null;
  models: ModelEntry[];
}

export interface Domain {
  setup(): { created: boolean; credential: string | null };
  localCredential(): string;
  rotateLocalCredential(): string;
  accountAdd(alias: string, secret: string): AccountView;
  accountUpdate(alias: string, secret: string): AccountView;
  accountList(): AccountView[];
  accountRename(alias: string, newAlias: string): { renamed: AccountView; previousAlias: string };
  accountRemove(alias: string, force: boolean): { removed: AccountView; clearedLanes: Lane[]; secretDeleted: boolean };
  accountTest(alias: string, lanes: Lane[]): Promise<ProbeResult[]>;
  routeSet(lane: Lane, aliasOrId: string): RouteView;
  routeClear(lane: Lane): void;
  /**
   * W0 establishment (contract 6.2): durably establish the v2 lineage under
   * lock and return its generation for the caller to freeze reviewed versions
   * against. Idempotent on established state.
   */
  ensureState(): { stateGeneration: string };
  /** W0 checked mutations (contract 7): generation-first, in-lock, commit-captured results. */
  routeSetChecked(lane: Lane, accountId: string, exp: CheckedExpectations & { expectedRouteVersion: number; expectedTargetAccountVersion: number }): RouteCommit;
  routeClearChecked(lane: Lane, exp: CheckedExpectations & { expectedRouteVersion: number }): RouteCommit;
  accountAddChecked(alias: string, secret: string, exp: CheckedExpectations): AccountCommit;
  accountUpdateChecked(accountId: string, secret: string, exp: CheckedExpectations & { expectedAccountVersion: number }): AccountCommit;
  accountRenameChecked(accountId: string, newAlias: string, exp: CheckedExpectations & { expectedAccountVersion: number }): RenameCommit;
  accountRemoveChecked(accountId: string, force: boolean, exp: CheckedExpectations & { expectedAccountVersion: number }): RemoveCommit;
  status(): StatusView;
  journalStats(): JournalStats;
  configShow(): StateFile["settings"];
  configSet(key: string, value: string): void;
  reset(): void;
  modelsStatus(): ModelsStatusView;
  modelsList(lane: Lane): ModelsListView;
  modelsRefresh(opts?: { dshClient?: DshClient }): Promise<RefreshResult & { dshSync?: DshSyncStatus | null }>;
  modelsDiff(): DiffEntry[];
  /** Slice B: trigger DSH reconciliation for current registry (downstream, non-blocking). */
  dshSync(opts?: { dshClient?: DshClient }): Promise<DshSyncStatus | null>;
  /** B.1 — DSH catalog approval operations. */
  approvalsStatus(opts?: { dshClient?: DshClient }): Promise<ApprovalStatusView>;
  approvalsApprove(lane: Lane, modelId: string, opts?: { dshClient?: DshClient }): Promise<{ tuple: ApprovalTuple; duplicate: boolean; dshSync?: DshSyncStatus | null }>;
  approvalsRevoke(lane: Lane, modelId: string, opts?: { dshClient?: DshClient }): Promise<{ removed: number; dshSync?: DshSyncStatus | null }>;
  approvalsMigratePreview(opts?: { dshClient?: DshClient }): Promise<MigrationPreviewView>;
  approvalsMigrateApply(proposalId: string, opts?: { dshClient?: DshClient }): Promise<{ applied: true; candidates: ApprovalTuple[]; proposalId: string; dshSync?: DshSyncStatus | null }>;
}

export interface ApprovalStatusView {
  storeState: "absent" | "initialized" | "corrupt" | "unsupported-version";
  version: number | null;
  corruptReason: string | null;
  initializedAtUtc: string | null;
  approvals: ApprovalRecord[];
  countsByLane: Record<Lane, number>;
  registryPresent: boolean;
  binding: { valid: boolean; go: LaneBindingCheck; zen: LaneBindingCheck } | null;
  bindingError: string | null;
  migrationRequired: boolean;
  migrationCandidateCount: number | null;
  activeCounts: Record<Lane, number> | null;
  withheldCounts: Record<Lane, number> | null;
  approvedAbsentCounts: Record<Lane, number> | null;
  dshSync: DshSyncStatus | null;
}

export interface MigrationPreviewView {
  proposalId: string;
  candidates: ApprovalTuple[];
  bindingsValid: boolean;
  revision: number;
  computedAtUtc: string;
}

function viewAccount(state: StateFile, secrets: SecretStore, a: AccountRecord): AccountView {
  return {
    ...a,
    secretPresent: secrets.exists(a.secretRef),
    usedBy: LANES.filter((l) => state.routes[l].accountId === a.id),
  };
}

function viewRoutes(state: StateFile): RouteView[] {
  return LANES.map((lane) => {
    const sel = state.routes[lane];
    const accountId = sel.accountId;
    if (!accountId) return { lane, accountId: null, alias: null, accountMissing: false, version: sel.version };
    const account = state.accounts.find((a) => a.id === accountId);
    return {
      lane,
      accountId,
      alias: account ? account.alias : null,
      accountMissing: !account,
      version: sel.version,
    };
  });
}

function formatAge(ms: number): string {
  if (ms < 1000) return ms + "ms";
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  const remS = s % 60;
  if (m < 60) return m + "m" + (remS ? " " + remS + "s" : "");
  const h = Math.floor(m / 60);
  const remM = m % 60;
  if (h < 24) return h + "h" + (remM ? " " + remM + "m" : "");
  const d = Math.floor(h / 24);
  const remH = h % 24;
  return d + "d" + (remH ? " " + remH + "h" : "");
}

export function createDomain(paths: Paths, secrets: SecretStore): Domain {
  const state = createStateStore(paths, secrets);
  const lockPath = lockPathFor(paths.state);
  /** Run a read-modify-write cycle under the cross-process lock (fn applied exactly once). */
  const mutateLocked = <T>(fn: (s: StateFile) => T): T =>
    withFileLock(lockPath, MUTATE_LOCK_TIMEOUT_MS, () => {
      // W0: every locked cycle first durably establishes the v2 lineage
      // (absent -> fresh; v1/legacy-v1 -> migrate; v2 -> validate). Lazy
      // migration preserves data; established files are untouched.
      state.ensureV2();
      let result!: T;
      state.mutate((s) => {
        result = fn(s);
      });
      return result;
    });

  /**
   * W0 checked cycle (contract 7): establish, then run fn against a clone of
   * the established state; persist ONLY when fn commits (no-op mutations must
   * not rewrite state merely to refresh timestamps, 5.4). fn captures its
   * commit result from the candidate (7.8).
   */
  const checkedMutate = <T>(fn: (s: StateFile) => { result: T; commit: boolean }): T =>
    withFileLock(lockPath, MUTATE_LOCK_TIMEOUT_MS, () => {
      state.ensureV2();
      const established = state.read();
      const candidate = structuredClone(established);
      const { result, commit } = fn(candidate);
      if (commit) state.write(candidate);
      return result;
    });

  /** First authoritative in-lock check (contract 7): generation before anything else. */
  function requireGeneration(s: StateFile, expected: string): void {
    if (s.stateGeneration === "" || expected !== s.stateGeneration) {
      throw new DomainConflict("state_generation_mismatch", "state generation mismatch: re-read state and retry the operation");
    }
  }

  function requireRouteVersion(s: StateFile, lane: Lane, expected: number): void {
    if (!isVersionNumber(expected) || s.routes[lane].version !== expected) {
      throw new DomainConflict("route_version_mismatch", `route version mismatch for lane '${lane}': re-read state and retry the operation`);
    }
  }

  function requireAccountVersion(a: AccountRecord, expected: number): void {
    if (!isVersionNumber(expected) || a.version !== expected) {
      throw new DomainConflict("account_version_mismatch", `account version mismatch for '${a.alias}': re-read state and retry the operation`);
    }
  }

  /** Version-exhaustion guard (contract 5.6): refuse at the safe-integer maximum, never wrap. */
  function nextVersion(current: number, what: string): number {
    if (!isVersionNumber(current) || current >= Number.MAX_SAFE_INTEGER) {
      throw new Error(`${what} version exhausted (safe-integer maximum): refusing mutation`);
    }
    return current + 1;
  }

  function checkedView(s: StateFile, a: AccountRecord): CheckedAccount {
    return {
      id: a.id,
      alias: a.alias,
      version: a.version,
      secretPresent: secrets.exists(a.secretRef),
      usedBy: LANES.filter((l) => s.routes[l].accountId === a.id),
      createdAtUtc: a.createdAtUtc,
      updatedAtUtc: a.updatedAtUtc,
    };
  }

  return {
    setup() {
      ensureStateDirs(paths);
      let created = false;
      let credential: string | null = null;
      try {
        credential = state.localCredential();
      } catch {
        // R4-003 option B: an explicit setup invocation is the documented
        // repair. When the corrupt source is gone (quarantined away or
        // deleted), acknowledge the latch so re-setup can proceed
        // without a process restart. A still-present corrupt file stays
        // fail-closed (acknowledge re-evaluates it via load()).
        if (!existsSync(paths.stateJson) && state.health().corrupt) {
          state.acknowledgeCorruptRepair();
        }
        const cred = generateLocalCredential();
        credential = cred;
        const ref = newRef();
        // DPAPI spawn OUTSIDE the lock (F-08): a slow protect cycle must not
        // hold the cross-process lock. An orphan blob on lock loss is benign
        // (no ref points to it); the re-check under the lock stays authoritative.
        secrets.put(ref, cred);
        try {
          mutateLocked((s) => {
            // re-check under the lock: a concurrent setup may have won
            if (s.localCredentialRef !== null) return;
            s.localCredentialRef = ref;
          });
        } catch (e) {
          // Claim failed (lock loss, corrupt-state refusal): the ref is
          // unclaimed by construction — reap before surfacing the error.
          try {
            secrets.delete(ref);
          } catch { /* best effort */ }
          throw e;
        }
        created = state.read().localCredentialRef === ref;
        // Losing racer (or lock-timeout orphan): our ref is unclaimed — reap
        // the blob so repeated concurrent setups cannot leak DPAPI entries.
        if (!created) {
          try {
            secrets.delete(ref);
          } catch { /* winner-referenced or already gone; benign either way */ }
        }
      }
      return { created, credential: created ? credential : null };
    },

    localCredential() {
      return state.localCredential();
    },

    rotateLocalCredential() {
      // New secret is stored BEFORE claiming it (F-08: DPAPI outside the lock).
      // A put failure leaves the old credential untouched; a mutate failure
      // leaves a benign orphan blob while the old credential stays live.
      const credential = generateLocalCredential();
      const ref = newRef();
      secrets.put(ref, credential);
      let oldRef: string | null = null;
      try {
        mutateLocked((s) => {
          oldRef = s.localCredentialRef;
          s.localCredentialRef = ref;
        });
      } catch (e) {
        // GR-001 (same class): the swap never committed — reap the staged
        // blob so a failed rotation cannot leak DPAPI entries.
        try {
          secrets.delete(ref);
        } catch { /* best effort */ }
        throw e;
      }
      // The new credential is live and returned regardless: a stale-blob
      // delete failure must never surface as a rotate failure (the caller
      // would never learn the new credential and would rotate again).
      if (oldRef) {
        try {
          secrets.delete(oldRef);
        } catch (e) {
          log.warn(`stale local credential blob cleanup failed (harmless orphan): ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      return credential;
    },

    accountAdd(alias, secret) {
      // W0 legacy adapter: same signature/semantics; freezes reviewed values
      // from one fresh established read, then commits through the checked core
      // (a concurrent writer surfaces as conflict, never a silent overwrite).
      const { stateGeneration } = this.ensureState();
      const r = this.accountAddChecked(alias, secret, { expectedStateGeneration: stateGeneration });
      const s = state.read();
      return viewAccount(s, secrets, s.accounts.find((x) => x.id === r.account.id)!);
    },

    accountUpdate(alias, secret) {
      // W0 legacy adapter: freeze by alias, then commit by immutable ID.
      const { stateGeneration } = this.ensureState();
      const frozen = state.read();
      const existing = findAccount(frozen, alias);
      if (!existing) throw new Error(`account '${alias}' not found`);
      this.accountUpdateChecked(existing.id, secret, {
        expectedStateGeneration: stateGeneration,
        expectedAccountVersion: existing.version,
      });
      const s = state.read();
      return viewAccount(s, secrets, s.accounts.find((x) => x.id === existing.id)!);
    },

    accountList() {
      const s = state.read();
      return s.accounts.map((a) => viewAccount(s, secrets, a));
    },

    accountRename(alias, newAlias) {
      // W0 legacy adapter: freeze by alias, then commit by immutable ID.
      const { stateGeneration } = this.ensureState();
      const frozen = state.read();
      const existing = findAccount(frozen, alias);
      if (!existing) throw new Error(`account '${alias}' not found`);
      const r = this.accountRenameChecked(existing.id, newAlias, {
        expectedStateGeneration: stateGeneration,
        expectedAccountVersion: existing.version,
      });
      const s = state.read();
      return { renamed: viewAccount(s, secrets, s.accounts.find((x) => x.id === existing.id)!), previousAlias: r.previousAlias };
    },

    accountRemove(alias, force) {
      // W0 legacy adapter: freeze by alias, then commit by immutable ID.
      const { stateGeneration } = this.ensureState();
      const frozen = state.read();
      const existing = findAccount(frozen, alias);
      if (!existing) throw new Error(`account '${alias}' not found`);
      const r = this.accountRemoveChecked(existing.id, force, {
        expectedStateGeneration: stateGeneration,
        expectedAccountVersion: existing.version,
      });
      // post-removal view: usedBy is empty and secretPresent false by construction
      // post-removal view from the frozen record against fresh routes:
      // usedBy is empty by construction; secretPresent reflects the store.
      const s = state.read();
      return {
        removed: viewAccount(s, secrets, existing),
        clearedLanes: r.clearedLanes.map((c) => c.lane),
        secretDeleted: r.secretDeleted,
      };
    },

    async accountTest(alias, lanes) {
      const s = state.read();
      const account = findAccount(s, alias);
      if (!account) throw new Error(`account '${alias}' not found`);
      const secret = secrets.get(account.secretRef);
      const results: ProbeResult[] = [];
      for (const lane of lanes) {
        const base = lane === "go" ? s.settings.upstreamGo : s.settings.upstreamZen;
        results.push(await probeAccountKey(lane, secret, base));
      }
      return results;
    },

    /** Select the lane's account by alias OR stable account id (findAccount semantics). */
    routeSet(lane, aliasOrId) {
      // W0 legacy adapter: freeze by alias-or-ID, then commit by immutable ID.
      const { stateGeneration } = this.ensureState();
      const frozen = state.read();
      const target = findAccount(frozen, aliasOrId);
      if (!target) throw new Error(`account '${aliasOrId}' not found`);
      this.routeSetChecked(lane, target.id, {
        expectedStateGeneration: stateGeneration,
        expectedRouteVersion: frozen.routes[lane].version,
        expectedTargetAccountVersion: target.version,
      });
      return viewRoutes(state.read()).find((r) => r.lane === lane)!;
    },

    routeClear(lane) {
      // W0 legacy adapter: freeze, then commit through the checked core.
      const { stateGeneration } = this.ensureState();
      const frozen = state.read();
      this.routeClearChecked(lane, {
        expectedStateGeneration: stateGeneration,
        expectedRouteVersion: frozen.routes[lane].version,
      });
    },

    ensureState() {
      return withFileLock(lockPath, MUTATE_LOCK_TIMEOUT_MS, () => {
        const established = state.ensureV2();
        return { stateGeneration: established.stateGeneration };
      });
    },

    routeSetChecked(lane, accountId, exp) {
      return checkedMutate<RouteCommit>((s) => {
        requireGeneration(s, exp.expectedStateGeneration);
        requireRouteVersion(s, lane, exp.expectedRouteVersion);
        const target = findAccountById(s, accountId);
        if (!target) throw new DomainConflict("not_found", `account id '${accountId}' not found`);
        requireAccountVersion(target, exp.expectedTargetAccountVersion);
        if (!isValidSecretRef(target.secretRef) || !secrets.exists(target.secretRef)) {
          throw new DomainConflict("target_not_selectable", `account '${target.alias}' is not selectable (stored credential missing)`);
        }
        const cur = s.routes[lane];
        const base = {
          stateGeneration: s.stateGeneration,
          lane,
          targetAccountId: target.id,
          targetAccountVersion: target.version,
        };
        if (cur.accountId === target.id) {
          return { result: { changed: false, ...base, routeVersion: cur.version, accountId: cur.accountId }, commit: false };
        }
        cur.accountId = target.id;
        cur.version = nextVersion(cur.version, `route ${lane}`);
        return { result: { changed: true, ...base, routeVersion: cur.version, accountId: cur.accountId }, commit: true };
      });
    },

    routeClearChecked(lane, exp) {
      return checkedMutate<RouteCommit>((s) => {
        requireGeneration(s, exp.expectedStateGeneration);
        requireRouteVersion(s, lane, exp.expectedRouteVersion);
        const cur = s.routes[lane];
        const base = {
          stateGeneration: s.stateGeneration,
          lane,
          targetAccountId: null as string | null,
          targetAccountVersion: null as number | null,
        };
        if (cur.accountId === null) {
          return { result: { changed: false, ...base, routeVersion: cur.version, accountId: null as string | null }, commit: false };
        }
        cur.accountId = null;
        cur.version = nextVersion(cur.version, `route ${lane}`);
        return { result: { changed: true, ...base, routeVersion: cur.version, accountId: null as string | null }, commit: true };
      });
    },

    accountAddChecked(alias, secret, exp) {
      const aliasErr = validateAlias(alias);
      if (aliasErr) throw new Error(aliasErr);
      if (secret.length === 0 || secret.length > 1024) throw new Error("invalid secret");
      const ref = newRef();
      secrets.put(ref, secret);
      let committed = false;
      try {
        return checkedMutate<AccountCommit>((s) => {
          requireGeneration(s, exp.expectedStateGeneration);
          if (findAccountByAlias(s.accounts, alias)) {
            throw new DomainConflict("alias_conflict", `account '${alias}' already exists`);
          }
          const account = makeAccount(alias, ref);
          s.accounts.push(account);
          committed = true;
          return { result: { changed: true, stateGeneration: s.stateGeneration, account: checkedView(s, account) }, commit: true };
        });
      } catch (e) {
        // Pre-commit failure (stale generation, alias race): the ref is
        // unclaimed — reap (contract 10 item 39). A write failure after the
        // push keeps the benign-orphan precedent (nothing references it, but
        // the failure is already fatal to the caller).
        if (!committed) {
          try { secrets.delete(ref); } catch { /* best effort */ }
        }
        throw e;
      }
    },

    accountUpdateChecked(accountId, secret, exp) {
      if (secret.length === 0 || secret.length > 1024) throw new Error("invalid secret");
      const ref = newRef();
      secrets.put(ref, secret);
      let committed = false;
      let replacedRef: string | null = null;
      try {
        const out = checkedMutate<AccountCommit>((s) => {
          requireGeneration(s, exp.expectedStateGeneration);
          const a = findAccountById(s, accountId);
          if (!a) throw new DomainConflict("not_found", `account id '${accountId}' not found`);
          requireAccountVersion(a, exp.expectedAccountVersion);
          replacedRef = a.secretRef;
          a.secretRef = ref;
          a.updatedAtUtc = new Date().toISOString();
          a.version = nextVersion(a.version, `account '${a.alias}'`);
          committed = true;
          return { result: { changed: true, stateGeneration: s.stateGeneration, account: checkedView(s, a) }, commit: true };
        });
        if (replacedRef !== null && replacedRef !== ref) {
          try { secrets.delete(replacedRef); } catch (e) {
            log.warn(`stale account credential blob cleanup failed (harmless orphan): ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        return out;
      } catch (e) {
        if (!committed) {
          try { secrets.delete(ref); } catch { /* best effort */ }
        }
        throw e;
      }
    },

    accountRenameChecked(accountId, newAlias, exp) {
      const aliasErr = validateAlias(newAlias);
      if (aliasErr) throw new Error(aliasErr);
      return checkedMutate<RenameCommit>((s) => {
        requireGeneration(s, exp.expectedStateGeneration);
        const a = findAccountById(s, accountId);
        if (!a) throw new DomainConflict("not_found", `account id '${accountId}' not found`);
        requireAccountVersion(a, exp.expectedAccountVersion);
        if (a.alias === newAlias) {
          return {
            result: { changed: false, stateGeneration: s.stateGeneration, account: checkedView(s, a), previousAlias: a.alias },
            commit: false,
          };
        }
        const other = findAccountByAlias(s.accounts, newAlias);
        if (other && other.id !== a.id) {
          throw new DomainConflict("alias_conflict", `account '${newAlias}' already exists`);
        }
        const previousAlias = a.alias;
        a.alias = newAlias;
        a.updatedAtUtc = new Date().toISOString();
        a.version = nextVersion(a.version, `account '${previousAlias}'`);
        return {
          result: { changed: true, stateGeneration: s.stateGeneration, account: checkedView(s, a), previousAlias },
          commit: true,
        };
      });
    },

    accountRemoveChecked(accountId, force, exp) {
      let secretRef: string | null = null;
      const out = checkedMutate<RemoveCommit>((s) => {
        requireGeneration(s, exp.expectedStateGeneration);
        const account = findAccountById(s, accountId);
        if (!account) throw new DomainConflict("not_found", `account id '${accountId}' not found`);
        requireAccountVersion(account, exp.expectedAccountVersion);
        const inUse: Lane[] = LANES.filter((l) => s.routes[l].accountId === account.id);
        if (inUse.length > 0 && !force) {
          throw new DomainConflict("account_in_use", `account '${account.alias}' is the selected ${inUse.join(",").toUpperCase()} account; remove with force to clear the selection`);
        }
        const clearedLanes: { lane: Lane; routeVersion: number }[] = [];
        if (force) {
          for (const l of LANES) {
            if (s.routes[l].accountId === account.id) {
              s.routes[l].accountId = null;
              s.routes[l].version = nextVersion(s.routes[l].version, `route ${l}`);
              clearedLanes.push({ lane: l, routeVersion: s.routes[l].version });
            }
          }
        }
        s.accounts = s.accounts.filter((x) => x.id !== account.id);
        secretRef = account.secretRef;
        return {
          result: {
            changed: true,
            stateGeneration: s.stateGeneration,
            removedAccountId: account.id,
            removedAccountVersion: account.version,
            clearedLanes,
            secretDeleted: false,
          },
          commit: true,
        };
      });
      const secretDeleted = secretRef ? secrets.delete(secretRef) : false;
      out.secretDeleted = secretDeleted;
      return out;
    },

    status() {
      const s = state.read();
      return {
        initialized: s.localCredentialRef !== null,
        localCredentialConfigured: s.localCredentialRef !== null && secrets.exists(s.localCredentialRef),
        stateCorrupt: state.health().corrupt,
        stateUnsupportedVersion: state.health().unsupportedSchemaVersion,
        stateGeneration: s.stateGeneration,
        schemaVersion: s.schemaVersion,
        routes: viewRoutes(s),
        accounts: s.accounts.map((a) => viewAccount(s, secrets, a)),
        settings: { ...s.settings },
        journalExists: existsSync(paths.journalDb),
        stateDir: paths.state,
      };
    },

    journalStats() {
      const s = state.read();
      const journal = createJournal(paths.journalDb, s.settings.journalRetentionDays, s.settings.journalMaxRecords);
      try {
        return journal.stats();
      } finally {
        journal.close();
      }
    },

    configShow() {
      return { ...state.read().settings };
    },

    configSet(key, value) {
      mutateLocked((s) => {
        const settings = s.settings as unknown as Record<string, unknown>;
        if (!(key in settings)) {
          throw new Error(`unknown setting '${key}'; known: ${Object.keys(settings).join(", ")}`);
        }
        let parsed: unknown = value;
        if (key === "port" || key === "journalRetentionDays" || key === "journalMaxRecords") {
          parsed = Number(value);
          // GR-007: key-specific messages first (they subsume positivity),
          // generic guard retained as the backstop for any numeric key.
          // CURRENT-012: fractional ports are silently truncated by listen —
          // reject them at the authoritative mutation boundary instead.
          if (key === "port" && !isValidPort(parsed)) throw new Error(`invalid port '${value}': must be an integer 1..65535`);
          // GR-007: fractional journalMaxRecords deterministically degrades
          // SQLite (LIMIT/OFFSET datatype mismatch) — reject at the same
          // boundary instead of accepting a config that breaks observability.
          if (key === "journalMaxRecords" && !isValidJournalMaxRecords(parsed)) {
            throw new Error(`invalid journalMaxRecords '${value}': must be an integer 1..${JOURNAL_MAX_RECORDS_MAX}`);
          }
          // GR-007: fractional retention days are meaningful (continuous-day
          // cutoff math) and stay allowed; non-positive/unbounded rejected.
          if (key === "journalRetentionDays" && !isValidRetentionDays(parsed)) {
            throw new Error(`invalid journalRetentionDays '${value}': must be a finite number > 0 and <= ${JOURNAL_RETENTION_DAYS_MAX}`);
          }
        }
        if (key === "upstreamGo" || key === "upstreamZen") {
          const v = validateUpstreamUrl(value);
          if (!v.ok) throw new Error(v.reason);
          parsed = v.url.toString().replace(/\/+$/, "");
        }
        if (key === "host" && value !== "127.0.0.1" && value !== "localhost" && value !== "::1") {
          throw new Error("non-loopback binding requires explicit --host at serve time; refusing to persist");
        }
        settings[key] = parsed;
      });
    },

    reset() {
      let refs: string[] = [];
      mutateLocked((x) => {
        refs = x.accounts.map((a) => a.secretRef);
        if (x.localCredentialRef) refs.push(x.localCredentialRef);
        const fresh = defaultState();
        x.accounts = fresh.accounts;
        x.routes = fresh.routes;
        x.localCredentialRef = null;
        // W0 reset boundary (contract 6.5): a new lineage so pre-reset
        // requests fail even if version numbers are numerically reused.
        x.stateGeneration = newStateGeneration();
      });
      for (const r of refs) secrets.delete(r);
      // Slice A: reset also removes persisted registry (clean slate)
      try { tryUnlink(registryPathFor(paths)); } catch {}
    },

    modelsStatus(): ModelsStatusView {
      const peek = peekRegistry(paths);
      const reg = peek.file;
      const dshSync = loadDshSyncStatus(paths);
      if (!reg) {
        // R4-C01: a future registry is neither corrupt nor retry-eligible —
        // refresh fails closed with an upgrade message (no fetch/overwrite).
        const future = peek.unsupportedVersion !== null && peek.unsupportedVersion !== undefined ? peek.unsupportedVersion : null;
        return {
          exists: peek.exists,
          corrupt: peek.corrupt,
          registry: null,
          ageMs: null,
          ageHuman: null,
          ttlMs: MODELS_TTL_MS,
          cooldownMs: MODELS_COOLDOWN_MS,
          isFresh: null,
          isCooldown: false,
          cooldownRemainingMs: 0,
          retryEligible: future === null,
          counts: { go: 0, zen: 0 },
          diffSummary: { added: 0, removed: 0, changed: 0, total: 0, lastDiffAtUtc: null },
          lastAttempt: null,
          dshSync,
        };
      }
      const now = Date.now();
      const ageMs = registryAgeMs(reg, now);
      const fresh = isFresh(reg, now);
      const cd = isCooldown(reg, now);
      const rem = cooldownRemainingMs(reg, now);
      const counts = { go: reg.go?.models.length ?? 0, zen: reg.zen?.models.length ?? 0 } as Record<Lane, number>;
      const added = reg.lastDiff.filter((d) => d.kind === "MODEL_ADDED").length;
      const removed = reg.lastDiff.filter((d) => d.kind === "MODEL_REMOVED").length;
      const changed = reg.lastDiff.filter((d) => d.kind === "MODEL_CHANGED").length;
      const ageHuman = formatAge(ageMs);
      return {
        exists: true,
        corrupt: false,
        registry: reg,
        ageMs,
        ageHuman,
        ttlMs: MODELS_TTL_MS,
        cooldownMs: MODELS_COOLDOWN_MS,
        isFresh: fresh,
        isCooldown: cd,
        cooldownRemainingMs: rem,
        retryEligible: !cd,
        counts,
        diffSummary: { added, removed, changed, total: reg.lastDiff.length, lastDiffAtUtc: reg.lastDiff.length > 0 ? reg.updatedAtUtc : null },
        lastAttempt: reg.lastAttempt,
        dshSync,
      };
    },

    modelsList(lane: Lane): ModelsListView {
      const reg = loadRegistry(paths);
      const snap = reg ? (lane === "go" ? reg.go : reg.zen) : null;
      if (!snap) return { lane, count: 0, fetchedAtUtc: null, models: [] };
      return { lane, count: snap.models.length, fetchedAtUtc: snap.fetchedAtUtc, models: [...snap.models] };
    },

    async modelsRefresh(opts: { dshClient?: DshClient } = {}): Promise<RefreshResult & { dshSync?: DshSyncStatus | null }> {
      const s = state.read();
      const result = await refreshRegistry(paths, {
        upstreamGo: s.settings.upstreamGo,
        upstreamZen: s.settings.upstreamZen,
        forced: true,
      });
      // Downstream DSH reconciliation after successful authoritative publication (failure-isolated).
      if (result.success && result.registry) {
        try {
          const client = opts.dshClient ?? createDshClient();
          const dshStatus = await reconcileDshCatalog(result.registry, client, { approvalStore: loadApprovalStore(paths), reloadApprovalStore: () => loadApprovalStore(paths), expectedPort: s.settings.port }, (st) => {
            try { storeDshSyncStatus(paths, st); } catch {}
          });
          return { ...result, dshSync: dshStatus };
        } catch (e) {
          log.warn(`dsh sync after refresh failed (registry preserved): ${redact(e instanceof Error ? e.message : String(e))}`);
        }
      }
      return result;
    },

    modelsDiff(): DiffEntry[] {
      const reg = loadRegistry(paths);
      if (!reg) return [];
      return [...reg.lastDiff];
    },

    async dshSync(opts: { dshClient?: DshClient } = {}): Promise<DshSyncStatus | null> {
      const reg = loadRegistry(paths);
      if (!reg || !reg.go || !reg.zen) return null;
      const client = opts.dshClient ?? createDshClient();
      const status = await reconcileDshCatalog(reg, client, { approvalStore: loadApprovalStore(paths), reloadApprovalStore: () => loadApprovalStore(paths), expectedPort: state.read().settings.port }, (st) => {
        try { storeDshSyncStatus(paths, st); } catch {}
      });
      return status;
    },

    // ------------------------------------------------------------------
    // B.1 — DSH catalog approvals
    // ------------------------------------------------------------------

    async approvalsStatus(opts: { dshClient?: DshClient } = {}): Promise<ApprovalStatusView> {
      const cur = loadApprovalStore(paths);
      const reg = loadRegistry(paths);
      const port = state.read().settings.port;
      let binding: ApprovalStatusView["binding"] = null;
      let migrationCandidateCount: number | null = null;
      try {
        // Factory inside the boundary (M7): an ambient invalid DSH_WEB_URL
        // must degrade to binding:null like any read failure, never hard-
        // fail this read-only status view.
        const client = opts.dshClient ?? createDshClient();
        const snap = await client.read();
        if (snap) {
          const b = checkOwnedProviderBindings(snap, port);
          binding = { valid: b.valid, go: b.go, zen: b.zen };
          if (cur.state === "absent") {
            migrationCandidateCount = snap.go.length + snap.zen.length;
          }
        }
      } catch (e) {
        log.warn(`approvals status: DSH snapshot read failed: ${redact(e instanceof Error ? e.message : String(e))}`);
      }
      const approvals = cur.state === "initialized" ? cur.store.approvals : [];
      const countsByLane: Record<Lane, number> = {
        go: approvals.filter((a) => a.lane === "go").length,
        zen: approvals.filter((a) => a.lane === "zen").length,
      };
      let activeCounts: Record<Lane, number> | null = null;
      let withheldCounts: Record<Lane, number> | null = null;
      let approvedAbsentCounts: Record<Lane, number> | null = null;
      if (cur.state === "initialized" && reg && reg.go && reg.zen) {
        const perLane = (lane: Lane) => {
          const owned = OWNED_DSH_PROVIDERS[lane];
          const approved = new Set(
            cur.store.approvals
              .filter((a) => a.lane === lane && a.dshProviderId === owned.providerId && a.apiProtocol === owned.apiProtocol)
              .map((a) => a.modelId),
          );
          const regModels = lane === "go" ? reg.go!.models : reg.zen!.models;
          const regIds = new Set(regModels.map((m) => m.id));
          const active = [...regIds].filter((id) => approved.has(id)).length;
          const withheld = [...regIds].filter((id) => !approved.has(id)).length;
          const absent = [...approved].filter((id) => !regIds.has(id)).length;
          return { active, withheld, absent };
        };
        const g = perLane("go");
        const z = perLane("zen");
        activeCounts = { go: g.active, zen: z.active };
        withheldCounts = { go: g.withheld, zen: z.withheld };
        approvedAbsentCounts = { go: g.absent, zen: z.absent };
      }
      return {
        storeState: cur.state,
        version: cur.state === "unsupported-version" ? cur.version : cur.state === "initialized" ? cur.store.version : null,
        corruptReason: cur.state === "corrupt" ? cur.reason : null,
        initializedAtUtc: cur.state === "initialized" ? cur.store.initializedAtUtc : null,
        approvals,
        countsByLane,
        registryPresent: reg !== null,
        binding,
        bindingError: binding && !binding.valid ? [binding.go.reason, binding.zen.reason].filter(Boolean).join("; ") : null,
        migrationRequired: cur.state === "absent",
        migrationCandidateCount,
        activeCounts,
        withheldCounts,
        approvedAbsentCounts,
        dshSync: loadDshSyncStatus(paths),
      };
    },

    async approvalsApprove(lane: Lane, modelId: string, opts: { dshClient?: DshClient } = {}) {
      const owned = OWNED_DSH_PROVIDERS[lane];
      const reg = loadRegistry(paths);
      const laneSnap = reg ? (lane === "go" ? reg.go : reg.zen) : null;
      if (!laneSnap) {
        throw new Error(`no ${lane} registry snapshot; run \`gorouter models refresh\` before approving`);
      }
      if (!laneSnap.models.some((m) => m.id === modelId)) {
        throw new Error(`model '${modelId}' not present in the current ${lane} registry snapshot`);
      }
      const tuple: ApprovalTuple = { lane, dshProviderId: owned.providerId, apiProtocol: owned.apiProtocol, modelId };
      const cur = loadApprovalStore(paths);
      if (cur.state === "corrupt") throw new Error(`approval store corrupt (${cur.reason}); refusing to mutate — fix or remove the file manually`);
      if (cur.state === "unsupported-version") throw new Error(`approval store schema version ${cur.version} unsupported; refusing to mutate`);
      let duplicate = false;
      if (cur.state === "absent") {
        // FIRST-INITIALIZATION SAFETY: legacy entries present => ratification required.
        const client = opts.dshClient ?? createDshClient();
        const dsh = await client.read();
        if (dsh && (dsh.go.length > 0 || dsh.zen.length > 0)) {
          throw new Error("migration required: owned DSH providers already contain legacy model entries; ratify `gorouter models approvals migrate` before approving");
        }
        try {
          initializeApprovalStore(paths, [tuple], "operator");
        } catch (e) {
          // L5: a concurrent first-approve won the init race — the store now
          // exists, so converge onto approve instead of failing spuriously
          // (the operator retries nothing; the tuple still lands exactly once).
          const again = loadApprovalStore(paths);
          if (again.state !== "initialized") throw e;
          const out = approveTuple(paths, tuple, "operator");
          duplicate = out.duplicate;
        }
      } else {
        const out = approveTuple(paths, tuple, "operator");
        duplicate = out.duplicate;
      }
      // Best-effort reconciliation; approval state stays truthful on DSH failure.
      let dshSync: DshSyncStatus | null = null;
      try {
        dshSync = await this.dshSync(opts);
      } catch (e) {
        log.warn(`dsh sync after approve failed (approval preserved): ${redact(e instanceof Error ? e.message : String(e))}`);
      }
      return { tuple, duplicate, dshSync };
    },

    async approvalsRevoke(lane: Lane, modelId: string, opts: { dshClient?: DshClient } = {}) {
      const out = revokeModelApproval(paths, { lane, modelId });
      let dshSync: DshSyncStatus | null = null;
      try {
        dshSync = await this.dshSync(opts);
      } catch (e) {
        log.warn(`dsh sync after revoke failed (approval preserved): ${redact(e instanceof Error ? e.message : String(e))}`);
      }
      return { removed: out.removed, dshSync };
    },

    async approvalsMigratePreview(opts: { dshClient?: DshClient } = {}): Promise<MigrationPreviewView> {
      const client = opts.dshClient ?? createDshClient();
      const snap = await client.read();
      if (!snap) throw new Error("DSH settings not found or llm-pi-ai namespace missing");
      const port = state.read().settings.port;
      const preview = computeMigrationPreview(snap, port, new Date().toISOString());
      return {
        proposalId: preview.proposalId,
        candidates: preview.candidates,
        bindingsValid: preview.bindings.valid,
        revision: preview.revision,
        computedAtUtc: preview.computedAtUtc,
      };
    },

    async approvalsMigrateApply(proposalId: string, opts: { dshClient?: DshClient } = {}) {
      const client = opts.dshClient ?? createDshClient();
      const port = state.read().settings.port;
      // The snapshot is read inside applyMigration, immediately before the
      // proposal check — a caller-supplied snapshot could be stale or forged.
      const res = await applyMigration(paths, () => client.read(), proposalId, port);
      if (!res.ok) throw new Error(res.reason);
      let dshSync: DshSyncStatus | null = null;
      try {
        dshSync = await this.dshSync(opts);
      } catch (e) {
        log.warn(`dsh sync after migration apply failed (approval preserved): ${redact(e instanceof Error ? e.message : String(e))}`);
      }
      return { applied: true as const, candidates: res.candidates, proposalId: res.proposalId, dshSync };
    },
  };
}
