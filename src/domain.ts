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
  accountUsedByRoute,
  makeAccount,
  validateAlias,
  validateUpstreamUrl,
  LANES,
  type StateFile,
  type Lane,
  type AccountRecord,
} from "./state.ts";
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
}

export interface StatusView {
  initialized: boolean;
  localCredentialConfigured: boolean;
  stateCorrupt: boolean;
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
  accountRemove(alias: string, force: boolean): { removed: AccountView; clearedLanes: Lane[] };
  accountTest(alias: string, lanes: Lane[]): Promise<ProbeResult[]>;
  routeSet(lane: Lane, aliasOrId: string): RouteView;
  routeClear(lane: Lane): void;
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
    const accountId = state.routes[lane].accountId;
    if (!accountId) return { lane, accountId: null, alias: null, accountMissing: false };
    const account = state.accounts.find((a) => a.id === accountId);
    return {
      lane,
      accountId,
      alias: account ? account.alias : null,
      accountMissing: !account,
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
      let result!: T;
      state.mutate((s) => {
        result = fn(s);
      });
      return result;
    });

  return {
    setup() {
      ensureStateDirs(paths);
      let created = false;
      let credential: string | null = null;
      try {
        credential = state.localCredential();
      } catch {
        const cred = generateLocalCredential();
        credential = cred;
        const ref = newRef();
        mutateLocked((s) => {
          // re-check under the lock: a concurrent setup may have won
          if (s.localCredentialRef !== null) return;
          secrets.put(ref, cred);
          s.localCredentialRef = ref;
        });
        created = state.read().localCredentialRef === ref;
      }
      return { created, credential: created ? credential : null };
    },

    localCredential() {
      return state.localCredential();
    },

    rotateLocalCredential() {
      let credential = "";
      mutateLocked((s) => {
        const oldRef = s.localCredentialRef;
        credential = generateLocalCredential();
        const ref = newRef();
        secrets.put(ref, credential);
        s.localCredentialRef = ref;
        if (oldRef) secrets.delete(oldRef);
      });
      return credential;
    },

    accountAdd(alias, secret) {
      const aliasErr = validateAlias(alias);
      if (aliasErr) throw new Error(aliasErr);
      if (secret.length === 0 || secret.length > 1024) throw new Error("invalid secret");
      let account: AccountRecord | null = null;
      mutateLocked((s) => {
        if (findAccount(s, alias)) throw new Error(`account '${alias}' already exists`);
        const ref = newRef();
        secrets.put(ref, secret);
        account = makeAccount(alias, ref);
        s.accounts.push(account);
      });
      return viewAccount(state.read(), secrets, account!);
    },

    accountUpdate(alias, secret) {
      if (secret.length === 0 || secret.length > 1024) throw new Error("invalid secret");
      let updated: AccountRecord | null = null;
      mutateLocked((s) => {
        const account = findAccount(s, alias);
        if (!account) throw new Error(`account '${alias}' not found`);
        secrets.put(account.secretRef, secret);
        const a = s.accounts.find((x) => x.id === account.id)!;
        a.updatedAtUtc = new Date().toISOString();
        updated = a;
      });
      return viewAccount(state.read(), secrets, updated!);
    },

    accountList() {
      const s = state.read();
      return s.accounts.map((a) => viewAccount(s, secrets, a));
    },

    accountRename(alias, newAlias) {
      const aliasErr = validateAlias(newAlias);
      if (aliasErr) throw new Error(aliasErr);
      let renamed: AccountRecord | null = null;
      let previousAlias = '';
      mutateLocked((s) => {
        const account = findAccount(s, alias);
        if (!account) throw new Error(`account '${alias}' not found`);
        if (findAccount(s, newAlias)) throw new Error(`account '${newAlias}' already exists`);
        const a = s.accounts.find((x) => x.id === account.id)!;
        previousAlias = a.alias;
        a.alias = newAlias;
        a.updatedAtUtc = new Date().toISOString();
        renamed = a;
      });
      return { renamed: viewAccount(state.read(), secrets, renamed!), previousAlias };
    },

    accountRemove(alias, force) {
      let removed: AccountRecord | null = null;
      const clearedLanes: Lane[] = [];
      let secretRef: string | null = null;
      mutateLocked((s) => {
        const account = findAccount(s, alias);
        if (!account) throw new Error(`account '${alias}' not found`);
        const lane = accountUsedByRoute(s, account.id);
        if (lane && !force) {
          throw new Error(
            `account '${account.alias}' is the selected ${lane.toUpperCase()} account; remove with --force to clear the selection`,
          );
        }
        s.accounts = s.accounts.filter((x) => x.id !== account.id);
        if (force) {
          for (const l of LANES) {
            if (s.routes[l].accountId === account.id) {
              s.routes[l].accountId = null;
              clearedLanes.push(l);
            }
          }
        }
        removed = account;
        secretRef = account.secretRef;
      });
      if (secretRef) secrets.delete(secretRef);
      // post-removal view: usedBy is empty and secretPresent false by construction
      return { removed: viewAccount(state.read(), secrets, removed!), clearedLanes };
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
      mutateLocked((s) => {
        const account = findAccount(s, aliasOrId);
        if (!account) throw new Error(`account '${aliasOrId}' not found`);
        s.routes[lane].accountId = account.id;
      });
      return viewRoutes(state.read()).find((r) => r.lane === lane)!;
    },

    routeClear(lane) {
      mutateLocked((s) => {
        s.routes[lane].accountId = null;
      });
    },

    status() {
      const s = state.read();
      return {
        initialized: s.localCredentialRef !== null,
        localCredentialConfigured: s.localCredentialRef !== null && secrets.exists(s.localCredentialRef),
        stateCorrupt: state.health().corrupt,
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
          if (!Number.isFinite(parsed) || (parsed as number) <= 0) throw new Error(`invalid numeric value '${value}'`);
          if (key === "port" && (parsed as number) > 65535) throw new Error("port out of range");
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
          retryEligible: true,
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
          const dshStatus = await reconcileDshCatalog(result.registry, client, {}, (st) => {
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
      const status = await reconcileDshCatalog(reg, client, {}, (st) => {
        try { storeDshSyncStatus(paths, st); } catch {}
      });
      return status;
    },
  };
}
