/**
 * GoRouter V1 — persisted non-secret state.
 *
 * state.json holds account metadata (id, alias, secret ref), the independent
 * Go/Zen lane selections, and safe settings. It NEVER contains plaintext
 * credentials — only opaque secret references resolved through the DPAPI
 * store. Writes are atomic (temp + fsync + rename); the server re-reads the
 * file per request, so a CLI route change takes effect for the next request
 * without a router restart while every request uses one coherent snapshot.
 */
import { readFileSync, existsSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { atomicWriteJson, log, quarantineCorruptFile } from "./util.ts";
import { isValidSecretRef, type SecretStore } from "./secret-store.ts";
import type { Paths } from "./paths.ts";

export const STATE_SCHEMA_VERSION = 2;
/** Last migratable predecessor: numeric v1 migrates under lock (contract \u00a76.1). */
export const STATE_MIGRATABLE_VERSION = 1;

/** F-13: bounded attempts for a single state.json read. */
export const STATE_READ_ATTEMPTS = 3;

/**
 * F-13: transient filesystem failures that must NOT quarantine a good
 * state.json on first sight (AV/indexer locks surface as these on Windows).
 * Corruption (JSON.parse) and all other codes fail closed immediately.
 * Test seam: pure classifier.
 */
const TRANSIENT_READ_CODES = new Set(["EBUSY", "EAGAIN", "EINTR", "EPERM"]);
export function isTransientReadError(e: unknown): boolean {
  if (!e || (typeof e !== "object" && typeof e !== "function")) return false;
  const code = (e as { code?: unknown }).code;
  return typeof code === "string" && TRANSIENT_READ_CODES.has(code);
}

/**
 * F-13: read through transient failures with bounded backoff, then throw.
 * Test seam: the reader and sleeper are injected (production passes
 * readFileSync/Bun.sleepSync). Non-transient errors throw on first attempt.
 */
export function readWithTransientRetry(read: () => string, sleepMs: (ms: number) => void = (ms) => Bun.sleepSync(ms)): string {
  let last: unknown = null;
  for (let attempt = 0; attempt < STATE_READ_ATTEMPTS; attempt++) {
    try {
      return read();
    } catch (e) {
      last = e;
      if (!isTransientReadError(e) || attempt + 1 >= STATE_READ_ATTEMPTS) throw e;
      sleepMs(25 * (attempt + 1));
    }
  }
  throw last;
}

export type Lane = "go" | "zen";

export const LANES: Lane[] = ["go", "zen"];

export interface AccountRecord {
  /** Stable opaque identity — survives renames; journal uses this. */
  id: string;
  /** Human alias, unique (case-insensitive). */
  alias: string;
  /** Opaque reference into the DPAPI secret store. */
  secretRef: string;
  createdAtUtc: string;
  updatedAtUtc: string;
  /** W0 optimistic-concurrency version: positive safe integer, starts at 1. */
  version: number;
}

export interface RouteSelection {
  /** Account id, or null when no account is selected for the lane. */
  accountId: string | null;
  /** W0 lane version: positive safe integer, starts at 1. */
  version: number;
}

export interface StateFile {
  schemaVersion: number;
  /**
   * W0 persisted lineage token (UUIDv4): created once per new/migrated state
   * lineage, preserved across ordinary restart, replaced only on explicit
   * reset/reinitialization. Empty string marks an UNESTABLISHED in-memory
   * default (absent file) that no checked mutation may commit against.
   */
  stateGeneration: string;
  accounts: AccountRecord[];
  routes: Record<Lane, RouteSelection>;
  settings: {
    port: number;
    host: string;
    upstreamGo: string;
    upstreamZen: string;
    journalRetentionDays: number;
    journalMaxRecords: number;
  };
  localCredentialRef: string | null;
}

export interface RouteSnapshot {
  lane: Lane;
  accountId: string;
  alias: string;
  secret: string;
}

export const DEFAULT_UPSTREAM_GO = "https://opencode.ai/zen/go/v1";
export const DEFAULT_UPSTREAM_ZEN = "https://opencode.ai/zen/v1";

/**
 * CURRENT-012 — single shared port invariant.
 *
 * A servable port is an integer in 1..65535. Fractional values must never
 * persist: the listener truncates them silently, so accepting one would
 * serve on a port the operator never chose. Port 0 (OS-assigned ephemeral)
 * is intentionally NOT valid here — it is allowed only where explicitly
 * intended (in-process/test servers that never persist it as configuration).
 */
export function isValidPort(port: unknown): port is number {
  return typeof port === "number" && Number.isInteger(port) && port >= 1 && port <= 65535;
}

/**
 * GR-007 — journalMaxRecords invariant: a safe positive integer, bounded
 * above. SQLite's `LIMIT ... OFFSET ?` rejects fractional/non-integer
 * offsets with "datatype mismatch" and degrades the journal, so anything
 * else must never persist (configSet) or load (normalizeState).
 */
export const JOURNAL_MAX_RECORDS_MIN = 1;
export const JOURNAL_MAX_RECORDS_MAX = 10_000_000;
export function isValidJournalMaxRecords(v: unknown): v is number {
  return (
    typeof v === "number" &&
    Number.isSafeInteger(v) &&
    v >= JOURNAL_MAX_RECORDS_MIN &&
    v <= JOURNAL_MAX_RECORDS_MAX
  );
}

/**
 * GR-007 — journalRetentionDays invariant. Fractional days ARE allowed (the
 * retention cutoff is continuous-day math, so 1.5 days is meaningful and
 * harmless); the value must be finite, positive, and at most 10 years.
 */
export const JOURNAL_RETENTION_DAYS_MAX = 3650;
export function isValidRetentionDays(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 && v <= JOURNAL_RETENTION_DAYS_MAX;
}

/**
 * Allowed upstream authorities. Real stored OpenCode credentials may only be
 * forwarded to the OpenCode origin (https://opencode.ai — current live and
 * documented authority for both Go and Zen lanes) or to loopback HTTP test
 * hosts (deterministic fixture/mock testing). Any other origin is refused so
 * an operator configuration mistake can never redirect account credentials
 * to an arbitrary HTTPS host.
 */
export const ALLOWED_UPSTREAM_ORIGINS: Record<string, true> = { "https://opencode.ai": true };

export function validateUpstreamUrl(
  value: string,
): { ok: true; url: URL } | { ok: false; reason: string } {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, reason: `invalid upstream URL '${value}'` };
  }
  if (url.username || url.password) {
    return { ok: false, reason: `upstream URL must not contain embedded userinfo` };
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1";
  if (url.protocol === "http:" && loopback) return { ok: true, url };
  if (url.protocol === "https:" && ALLOWED_UPSTREAM_ORIGINS[url.origin]) return { ok: true, url };
  return {
    ok: false,
    reason:
      `upstream origin '${url.origin}' is not an allowed OpenCode authority ` +
      `(${Object.keys(ALLOWED_UPSTREAM_ORIGINS).join(", ")}) or a loopback test host`,
  };
}

/**
 * W0 concurrency-metadata validators (contract \u00a75.1/\u00a75.5). Versions are
 * positive safe integers only — never 0, negative, fractional, NaN, infinite,
 * or beyond the safe-integer range. Missing/malformed metadata fails closed;
 * it is never silently defaulted to 1.
 */
export function isVersionNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 1;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isStateGeneration(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

/** Mint one fresh lineage token (concurrency metadata, not a secret). */
export function newStateGeneration(): string {
  return randomUUID();
}

/**
 * Raw on-disk classification (contract \u00a76.1). Pure function of parsed JSON:
 * - 'v2': current schema (strict validation happens in normalizeV2).
 * - 'v1': numeric v1, migratable predecessor.
 * - 'legacy-v1': missing/non-numeric schema metadata that still satisfies the
 *   v1 structural/identity invariants (explicit migration class, never a
 *   bypass and never normalized directly as v2).
 * - 'legacy-invalid': missing/non-numeric metadata that fails v1 invariants
 *   (refuse migration rather than guess).
 * - 'unsupported': any other numeric version (fail closed).
 * - 'corrupt': not a JSON object at all.
 */
export type RawStateClass = "v2" | "v1" | "legacy-v1" | "legacy-invalid" | "unsupported" | "corrupt";
export function classifyRawState(parsed: unknown): RawStateClass {
  if (typeof parsed !== "object" || parsed === null) return "corrupt";
  const raw = parsed as Record<string, unknown>;
  const v = raw.schemaVersion;
  if (v === STATE_SCHEMA_VERSION) return "v2";
  if (v === STATE_MIGRATABLE_VERSION) return "v1";
  if (typeof v === "number") return "unsupported";
  return satisfiesV1Identity(raw) ? "legacy-v1" : "legacy-invalid";
}

/** v1 structural/identity invariants a legacy file must satisfy to migrate. */
function satisfiesV1Identity(raw: Record<string, unknown>): boolean {
  if (!Array.isArray(raw.accounts)) return false;
  const ids = new Set<string>();
  const aliases = new Set<string>();
  for (const entry of raw.accounts) {
    if (typeof entry !== "object" || entry === null) return false;
    const a = entry as Record<string, unknown>;
    if (typeof a.id !== "string" || a.id.length === 0) return false;
    if (typeof a.alias !== "string" || a.alias.length === 0) return false;
    if (!isValidSecretRef(a.secretRef)) return false;
    if (ids.has(a.id)) return false;
    ids.add(a.id);
    const folded = a.alias.toLowerCase();
    if (aliases.has(folded)) return false;
    aliases.add(folded);
  }
  if (raw.routes !== undefined) {
    if (typeof raw.routes !== "object" || raw.routes === null) return false;
    const r = raw.routes as Record<string, unknown>;
    for (const lane of LANES) {
      const sel = r[lane];
      if (sel === undefined) continue;
      if (typeof sel !== "object" || sel === null) return false;
      const id = (sel as { accountId?: unknown }).accountId;
      if (id !== null && id !== undefined && typeof id !== "string") return false;
    }
  }
  return true;
}

export function defaultState(): StateFile {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    // UNESTABLISHED marker: no checked mutation may commit against "" (D3).
    // establishV2 replaces it with one fresh persisted lineage under lock.
    stateGeneration: "",
    accounts: [],
    routes: { go: { accountId: null, version: 1 }, zen: { accountId: null, version: 1 } },
    settings: {
      port: 8787,
      host: "127.0.0.1",
      upstreamGo: DEFAULT_UPSTREAM_GO,
      upstreamZen: DEFAULT_UPSTREAM_ZEN,
      journalRetentionDays: 30,
      journalMaxRecords: 100_000,
    },
    localCredentialRef: null,
  };
}

export interface StateStore {
  read(): StateFile;
  write(state: StateFile): void;
  /** Atomically apply a mutation to state.json (read-modify-write). */
  mutate(fn: (state: StateFile) => void): StateFile;
  /** Resolve the full immutable route snapshot for a lane, or throw. */
  resolveSnapshot(lane: Lane): RouteSnapshot;
  /** Resolve the local client credential (for auth), or throw. */
  localCredential(): string;
  /**
   * R4-003 explicit repair: clear the corrupt latch without a process
   * restart. Only valid when the operator explicitly invoked recovery
   * (e.g. `gorouter setup`) and state.json is absent (quarantined away or
   * deliberately deleted) or a valid supported file is present (load()
   * re-evaluates it). Never called implicitly by reads or auto-start.
   */
  acknowledgeCorruptRepair(): void;
  /**
   * Store health. `unsupportedSchemaVersion` is the on-disk schema version
   * when it is not ours (GR-004): the file is served as defaults and every
   * write is refused until the operator restores a supported version.
   */
  health(): { corrupt: boolean; unsupportedSchemaVersion: number | null };
  /**
   * W0 establishment (contract \u00a76.1/\u00a76.2): classify the CURRENT
   * on-disk bytes (re-read AFTER the caller acquires the mutation lock) and
   * durably establish exactly one v2 lineage: absent \u2192 fresh v2;
   * v1/legacy-v1 \u2192 migrate (one fresh generation, versions 1, full
   * preservation); v2 \u2192 validate (idempotent, no new generation);
   * anything else \u2192 throw fail-closed. Returns the established state.
   * MUST be called with the cross-process mutation lock held.
   */
  ensureV2(): StateFile;
}

export function createStateStore(paths: Paths, secrets: SecretStore, opts: { quarantine?: typeof quarantineCorruptFile; writeJson?: typeof atomicWriteJson } = {}): StateStore {
  // Test seam (precedent: setInboundBodyIdleTimeoutForTests): inject a
  // failing quarantine to pin the refuse-while-unpreserved path, which real
  // filesystems trigger only on rare rename failures.
  const quarantineFile = opts.quarantine ?? quarantineCorruptFile;
  // R4-001 seam: deterministic write-failure injection. Production default
  // is the atomic writer; tests pass a throwing stub. Narrowly scoped to
  // the state writer only.
  const writeJson = opts.writeJson ?? atomicWriteJson;
  // CURRENT-010: identity includes ino (file index). All writers are atomic
  // renames, which mint a new file identity — so a same-size replacement in
  // the same mtime tick can never false-hit (the digest-equivalent without
  // re-read cost; an unstable ino only costs a re-read, never correctness).
  let cache: { mtimeMs: number; size: number; ino: number; state: StateFile } | null = null;
  let corrupt = false;
  // GR-004: on-disk schema version newer (or otherwise not ours). While set,
  // the file is served as defaults and never overwritten by this binary.
  let unsupportedSchema: number | null = null;

  // Path of the most recent quarantine backup (for refusal messages).
  let lastQuarantine: string | null = null;

  function quarantine(p: string): void {
    const backup = quarantineFile(p, "state.json");
    if (backup) lastQuarantine = backup;
  }

  /**
   * Fail-closed writes (B0): once load() has seen corruption, the in-memory
   * state is defaults — committing it would wipe the only good copy
   * (accounts, routes, refs) the moment any mutation runs. Refuse until the
   * operator restores a backup or deletes state.json and re-runs setup.
   * Healing happens via load(): an externally restored file parses and
   * clears the flag on the next read, and a missing file clears it too (the
   * evidence was quarantined away or deliberately deleted — no good copy
   * remains on disk, so re-setup is the repair, in-process or fresh).
   */
  function refuseIfCorrupt(): void {
    if (!corrupt) return;
    throw new Error(
      `refusing to write: state.json is corrupt${lastQuarantine ? ` (evidence at ${lastQuarantine})` : ""}; ` +
      `restore a backup or delete state.json and re-run setup`,
    );
  }

  /**
   * GR-004 compatibility gate (B0 for versions): an older binary must never
   * rewrite a newer schema it does not understand — a routine mutation would
   * silently drop fields and break the upgrade/rollback path. Refuse until
   * the operator restores a supported version (or deletes the file).
   */
  function refuseIfUnsupported(): void {
    if (unsupportedSchema === null) return;
    throw new Error(
      `refusing to write: state.json has unsupported schema version ${unsupportedSchema} ` +
      `(this binary supports version ${STATE_SCHEMA_VERSION}); ` +
      `upgrade GoRouter or restore a version-${STATE_SCHEMA_VERSION} backup`,
    );
  }

  function load(): StateFile {
    const p = paths.stateJson;
    if (!existsSync(p)) {
      // R4-003: a missing file does NOT implicitly heal the corrupt latch
      // when this process quarantined the only copy (lastQuarantine set) —
      // the health signal must stay latched until explicit repair, or
      // desktop auto-start would proceed on defaults after quarantine.
      // Explicit recovery is domain.setup() -> acknowledgeCorruptRepair(),
      // or an externally restored valid file observed below (option A).
      if (corrupt && lastQuarantine !== null) {
        log.warn(`state.json absent after quarantine (evidence preserved at ${lastQuarantine}); corrupt latch held — explicit setup required`);
        cache = null;
      } else if (corrupt) {
        // No quarantine evidence from this process (failed quarantine, or
        // operator reset): still require explicit repair instead of
        // silently serving re-setup. Failed-quarantine files that still
        // exist never reach here (existsSync true) and stay fail-closed.
        log.warn(`state.json absent while corrupt latch held; explicit setup required`);
        cache = null;
      }
      // GR-004: deleting the unsupported file (per the refusal message) is
      // the documented repair — clear the gate so re-setup can proceed.
      if (unsupportedSchema !== null) {
        log.warn(`state.json absent; clearing unsupported-schema gate (was v${unsupportedSchema}); repair via setup allowed`);
        unsupportedSchema = null;
        cache = null;
      }
      return defaultState();
    }
    const st = statSync(p);
    if (cache && cache.mtimeMs === st.mtimeMs && cache.size === st.size && cache.ino === st.ino) return cache.state;
    let raw: string;
    try {
      // F-13: a transient lock must not quarantine a good file on first sight.
      raw = readWithTransientRetry(() => readFileSync(p, "utf8"));
    } catch (e) {
      corrupt = true;
      quarantine(p);
      cache = null;
      const code = (e as { code?: unknown }).code;
      log.warn(`state read failed${typeof code === "string" ? ` (${code}, after ${STATE_READ_ATTEMPTS} attempts)` : ""}; using defaults (path=${p})`);
      return defaultState();
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      corrupt = true;
      quarantine(p);
      cache = null;
      log.error(`state.json corrupt; evidence quarantined, serving defaults (path=${p})`);
      return defaultState();
    }
    // W0 loader policy (contract \u00a76.1): numeric v1 is the migratable
    // predecessor (served as a legacy view until establishV2 migrates it under
    // lock); source-compatible missing/non-numeric metadata is the explicit
    // legacy-v1 class; v2 is strictly validated; every other numeric version
    // is an unsupported compatibility gate (never normalized, never
    // overwritten); anything else fails closed through the corrupt path.
    const cls = classifyRawState(parsed);
    if (cls === "unsupported") {
      const onDiskVersion = (parsed as { schemaVersion?: unknown }).schemaVersion;
      unsupportedSchema = onDiskVersion as number;
      corrupt = false;
      cache = null;
      log.error(`state.json has unsupported schema version ${onDiskVersion} (this binary supports v${STATE_SCHEMA_VERSION}); serving defaults, writes refused`);
      return defaultState();
    }
    if (cls === "corrupt" || cls === "legacy-invalid") {
      corrupt = true;
      quarantine(p);
      cache = null;
      log.error(`state.json failed structural validation; evidence quarantined, serving defaults (path=${p})`);
      return defaultState();
    }
    if (cls === "v2") {
      const state = normalizeV2(parsed);
      if (!state) {
        // Concurrency-integrity failure (\u00a75.5): quarantine + latch, same
        // policy as corrupt JSON. Never default the metadata to look valid.
        corrupt = true;
        quarantine(p);
        cache = null;
        log.error(`state.json v2 concurrency metadata invalid; evidence quarantined, serving defaults (path=${p})`);
        return defaultState();
      }
      corrupt = false;
      unsupportedSchema = null; // healed: a supported version supersedes the gate
      lastQuarantine = null; // healed: prior evidence is superseded, never name it again
      cache = { mtimeMs: st.mtimeMs, size: st.size, ino: st.ino, state };
      return state;
    }
    // v1 / legacy-v1: legacy tolerance view. Versions/generation here are
    // placeholders (generation \"\" = UNESTABLISHED); no W0 metadata is
    // exposed as committable until establishV2 migrates under lock (\u00a76.2).
    const state = normalizeV1Legacy(parsed);
    corrupt = false;
    unsupportedSchema = null;
    lastQuarantine = null;
    cache = { mtimeMs: st.mtimeMs, size: st.size, ino: st.ino, state };
    return state;
  }

  function write(state: StateFile): void {
    refuseIfUnsupported();
    refuseIfCorrupt();
    writeJson(paths.stateJson, state);
    cache = null; // force a fresh read next time
  }

  const api: StateStore = {
    read: load,
    write,
    mutate(fn) {
      // W0 (contract 6.2): establish the v2 lineage as part of every locked
      // mutation cycle, so no caller can persist an unestablished husk or
      // bypass migration. Idempotent on established state. Production callers
      // hold the cross-process mutation lock here (domain mutateLocked); the
      // classify+migrate+write sequence is atomic only under it.
      api.ensureV2();
      // R4-001 (SS-01): clone-on-mutate. The cached object must never be
      // the mutation target: if the write throws, the live cache still
      // holds the old state and a later write cannot persist the phantom.
      // StateFile is JSON-shaped so structuredClone preserves semantics.
      const current = load();
      refuseIfUnsupported();
      refuseIfCorrupt();
      const candidate = structuredClone(current);
      fn(candidate);
      write(candidate);
      return candidate;
    },
    resolveSnapshot(lane) {
      const state = load();
      const sel = state.routes[lane];
      const accountId = sel?.accountId ?? null;
      if (!accountId) {
        const err = new Error(`no account selected for lane '${lane}'`) as Error & { kind?: string };
        (err as { kind?: string }).kind = "no-route";
        throw err;
      }
      const account = state.accounts.find((a) => a.id === accountId);
      if (!account) {
        const err = new Error(
          `selected account '${accountId}' for lane '${lane}' does not exist`,
        ) as Error & { kind?: string };
        (err as { kind?: string }).kind = "dangling-route";
        throw err;
      }
      let secret: string;
      try {
        secret = secrets.get(account.secretRef);
      } catch (e) {
        const err = new Error(
          `secret unavailable for account '${account.alias}' (lane '${lane}')`,
        ) as Error & { kind?: string };
        (err as { kind?: string }).kind = "missing-secret";
        throw err;
      }
      return { lane, accountId: account.id, alias: account.alias, secret };
    },
    localCredential() {
      const state = load();
      if (!state.localCredentialRef) throw new Error("local client credential not configured; run `gorouter setup`");
      return secrets.get(state.localCredentialRef);
    },
    ensureV2() {
      // Re-read raw bytes NOW (post-lock acquisition): two racing migrators
      // serialize here; the loser observes the winner's v2 and converges
      // without minting a second generation (\u00a710 item 15).
      // NOTE: paths.stateJson is used explicitly (the load-local `p` is not
      // in scope here).
      const statePath = paths.stateJson;
      let raw: string | null = null;
      if (existsSync(statePath)) {
        try {
          raw = readWithTransientRetry(() => readFileSync(statePath, "utf8"));
        } catch (e) {
          corrupt = true;
          quarantine(statePath);
          cache = null;
          throw new Error(
            `cannot establish state schema: state.json unreadable (${(e as { code?: unknown }).code ?? "unknown"}); evidence quarantined`,
          );
        }
      }
      if (raw === null) {
        // Absent/uninitialized: metadata-only v2 lineage, no credentials.
        // Gate parity with load(): deleting the unsupported file is the
        // documented repair, so a stale gate clears here. The corrupt latch
        // is NOT implicitly healed (R4-003: explicit repair required).
        if (unsupportedSchema !== null) {
          log.warn(`state.json absent; clearing unsupported-schema gate (was v${unsupportedSchema}); repair via setup allowed`);
          unsupportedSchema = null;
          cache = null;
        }
        const fresh = defaultState();
        fresh.stateGeneration = newStateGeneration();
        refuseIfCorrupt();
        writeJson(statePath, fresh);
        cache = null;
        return load();
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        corrupt = true;
        quarantine(statePath);
        cache = null;
        // Same refusal vocabulary as refuseIfCorrupt (a failed quarantine
        // leaves the only copy in place; the mutation must refuse, never wipe).
        throw new Error(
          `refusing to write: state.json is corrupt${lastQuarantine ? ` (evidence at ${lastQuarantine})` : ""}; ` +
          `restore a backup or delete state.json and re-run setup`,
        );
      }
      const cls = classifyRawState(parsed);
      if (cls === "v2") return load(); // idempotent: validate, keep generation
      if (cls === "unsupported") {
        unsupportedSchema = (parsed as { schemaVersion?: unknown }).schemaVersion as number;
        cache = null;
        throw new Error(
          `cannot establish state schema: unsupported schema version ${unsupportedSchema} (this binary supports v${STATE_SCHEMA_VERSION})`,
        );
      }
      if (cls === "corrupt" || cls === "legacy-invalid") {
        corrupt = true;
        quarantine(statePath);
        cache = null;
        throw new Error("cannot establish state schema: state failed v1 structural/identity invariants; evidence quarantined");
      }
      // v1 / legacy-v1: migrate under this lock, atomically, preserving every
      // stable field and selection; versions initialize to 1; exactly one
      // fresh generation for the migration commit (\u00a76.1). Valid restorable
      // content heals stale latches exactly as load() does (an operator-
      // restored backup must be committable, not latched forever).
      corrupt = false;
      unsupportedSchema = null;
      lastQuarantine = null;
      const migrated = migrateV1ToV2(parsed);
      writeJson(statePath, migrated);
      cache = null;
      return load();
    },
    acknowledgeCorruptRepair() {
      // Explicit operator recovery (R4-003 option B). Absent file: the
      // quarantined/deleted copy is gone, so clear the latch and allow
      // re-setup in-process. Present file: re-evaluate it — a valid
      // supported file heals via load() (option A); a still-corrupt file
      // stays fail-closed (failed quarantine must never clear here).
      if (!existsSync(paths.stateJson)) {
        if (corrupt) log.warn(`explicit corrupt repair acknowledged (evidence${lastQuarantine ? ` was at ${lastQuarantine}` : " was never quarantined"}); latch cleared`);
        corrupt = false;
        lastQuarantine = null;
        cache = null;
        return;
      }
      load();
    },
    health() {
      return { corrupt, unsupportedSchemaVersion: unsupportedSchema };
    },
  };
  return api;
}

/**
 * Legacy v1 tolerance view (contract \u00a76.1): preserves the pre-W0
 * normalizeState semantics exactly (v1 structural data + safe-settings
 * fail-closed defaults), stamped schemaVersion 1 with UNESTABLISHED
 * placeholders. Never a commit source until establishV2 migrates it.
 */
function normalizeV1Legacy(parsed: unknown): StateFile {
  const base = defaultState();
  if (typeof parsed !== "object" || parsed === null) return base;
  const raw = parsed as Record<string, unknown>;
  const out: StateFile = base;
  out.schemaVersion = STATE_MIGRATABLE_VERSION;
  if (Array.isArray(raw.accounts)) {
    out.accounts = raw.accounts.filter(isAccountRecord).map((a) => ({ ...a, version: 1 }));
  }
  if (typeof raw.routes === "object" && raw.routes !== null) {
    const r = raw.routes as Record<string, unknown>;
    for (const lane of LANES) {
      const sel = r[lane];
      if (sel && typeof sel === "object" && "accountId" in sel) {
        const v = (sel as { accountId?: unknown }).accountId;
        out.routes[lane] = { accountId: typeof v === "string" ? v : null, version: 1 };
      }
    }
  }
  applySafeSettings(raw, out);
  return out;
}

/**
 * Strict v2 normalization (contract \u00a75.1/\u00a75.5): returns null on ANY
 * invalid concurrency metadata or identity violation. Never defaults versions
 * to 1 and never discards invalid entries — failure quarantines via load().
 */
function normalizeV2(parsed: unknown): StateFile | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const raw = parsed as Record<string, unknown>;
  if (raw.schemaVersion !== STATE_SCHEMA_VERSION) return null;
  if (!isStateGeneration(raw.stateGeneration)) return null;
  if (!Array.isArray(raw.accounts)) return null;
  const out: StateFile = defaultState();
  out.schemaVersion = STATE_SCHEMA_VERSION;
  out.stateGeneration = raw.stateGeneration;
  const ids = new Set<string>();
  const aliases = new Set<string>();
  const accounts: AccountRecord[] = [];
  for (const entry of raw.accounts) {
    if (!isAccountRecord(entry)) return null;
    const rec = entry as unknown as Record<string, unknown>;
    if (!isVersionNumber(rec.version)) return null;
    const id = entry.id;
    const folded = entry.alias.toLowerCase();
    if (id.length === 0 || ids.has(id)) return null;
    if (aliases.has(folded)) return null;
    ids.add(id);
    aliases.add(folded);
    accounts.push({ ...entry, version: rec.version as number });
  }
  out.accounts = accounts;
  if (typeof raw.routes !== "object" || raw.routes === null) return null;
  const r = raw.routes as Record<string, unknown>;
  for (const lane of LANES) {
    const sel = r[lane];
    if (!sel || typeof sel !== "object") return null;
    const rec = sel as { accountId?: unknown; version?: unknown };
    if (rec.accountId !== null && typeof rec.accountId !== "string") return null;
    if (!isVersionNumber(rec.version)) return null;
    out.routes[lane] = { accountId: rec.accountId, version: rec.version };
  }
  applySafeSettings(raw, out);
  return out;
}

/**
 * v1/legacy-v1 \u2192 v2 migration commit builder (contract \u00a76.1): preserves every stable
 * field, selection, setting, and credential reference; initializes all versions
 * to 1; mints exactly one fresh generation for the migration commit. Pure
 * (no I/O); the caller persists atomically under lock.
 */
export function migrateV1ToV2(parsed: unknown): StateFile {
  const legacy = normalizeV1Legacy(parsed);
  legacy.schemaVersion = STATE_SCHEMA_VERSION;
  legacy.stateGeneration = newStateGeneration();
  return legacy;
}

/** Pre-existing safe-settings/localCredential fail-closed defaults (unchanged). */
function applySafeSettings(raw: Record<string, unknown>, out: StateFile): void {
  const base = defaultState();
  if (typeof raw.settings === "object" && raw.settings !== null) {
    const s = raw.settings as Record<string, unknown>;
    // CURRENT-012: fractional/out-of-range persisted ports fail closed to
    // the loopback default (mirrors the non-loopback host rule below).
    // Port 0 is preserved as-is: it is the explicit ephemeral marker used by
    // in-process/test servers, never a truncated fractional.
    if (s.port === 0 || isValidPort(s.port)) out.settings.port = s.port as number;
    else if (typeof s.port === "number") {
      log.error(`state port '${s.port}' is not an integer 1..65535; failing closed to ${base.settings.port}`);
    }
    // host is validated: a non-loopback value fails closed to loopback
    if (typeof s.host === "string") {
      const loopback = s.host === "127.0.0.1" || s.host === "localhost" || s.host === "::1";
      if (loopback) out.settings.host = s.host as string;
      else {
        log.error(`state host '${s.host}' is non-loopback; failing closed to 127.0.0.1`);
        out.settings.host = "127.0.0.1";
      }
    }
    // upstream authorities are validated: a foreign/invalid value fails closed
    // to the safe default rather than ever carrying credentials elsewhere
    if (typeof s.upstreamGo === "string") {
      const v = validateUpstreamUrl(s.upstreamGo);
      out.settings.upstreamGo = v.ok ? v.url.toString().replace(/\/+$/, "") : DEFAULT_UPSTREAM_GO;
      if (!v.ok) log.error(`state upstreamGo invalid, failing closed to default: ${v.reason}`);
    }
    if (typeof s.upstreamZen === "string") {
      const v = validateUpstreamUrl(s.upstreamZen);
      out.settings.upstreamZen = v.ok ? v.url.toString().replace(/\/+$/, "") : DEFAULT_UPSTREAM_ZEN;
      if (!v.ok) log.error(`state upstreamZen invalid, failing closed to default: ${v.reason}`);
    }
    // GR-007: persisted retention values validate identically to configSet
    // (a hand-edited file must fail closed to defaults, never degrade SQLite).
    if (typeof s.journalRetentionDays === "number") {
      if (isValidRetentionDays(s.journalRetentionDays)) out.settings.journalRetentionDays = s.journalRetentionDays;
      else log.error(`state journalRetentionDays '${s.journalRetentionDays}' invalid; failing closed to ${base.settings.journalRetentionDays}`);
    }
    if (typeof s.journalMaxRecords === "number") {
      if (isValidJournalMaxRecords(s.journalMaxRecords)) out.settings.journalMaxRecords = s.journalMaxRecords;
      else log.error(`state journalMaxRecords '${s.journalMaxRecords}' invalid; failing closed to ${base.settings.journalMaxRecords}`);
    }
  }
  // CURRENT-001 layer 2: a malformed local credential ref fails closed to
  // unconfigured (operator must re-run setup) rather than flowing to the store.
  if (isValidSecretRef(raw.localCredentialRef)) out.localCredentialRef = raw.localCredentialRef;
}

function isAccountRecord(v: unknown): v is AccountRecord {
  if (typeof v !== "object" || v === null) return false;
  const a = v as Record<string, unknown>;
  // CURRENT-001 layer 2: accounts carrying malformed secret refs are
  // dropped at load (same precedent as other malformed account entries),
  // so a crafted state.json cannot smuggle an escaping ref into the store.
  return (
    typeof a.id === "string" &&
    typeof a.alias === "string" &&
    isValidSecretRef(a.secretRef)
  );
}

// ---------------------------------------------------------------------------
// Account lifecycle helpers (used by the CLI)
// ---------------------------------------------------------------------------

export function findAccount(state: StateFile, aliasOrId: string): AccountRecord | undefined {
  const needle = aliasOrId.toLowerCase();
  return state.accounts.find((a) => a.alias.toLowerCase() === needle || a.id === needle);
}

/**
 * W0 exact immutable-ID lookup (contract \u00a77): opaque exact match only.
 * MUST be used for every checked account mutation — never an alias-capable
 * resolver — so an alias equal to another account's ID cannot redirect intent.
 */
export function findAccountById(state: StateFile, id: string): AccountRecord | undefined {
  return state.accounts.find((a) => a.id === id);
}

/**
 * W0 alias-only CLI resolution (contract \u00a78.3): case-insensitive alias
 * match only. An argument equal to some account's immutable ID resolves to the
 * alias-owned account (or nothing), never to the ID-owned account.
 */
export function findAccountByAlias(accounts: AccountRecord[], alias: string): AccountRecord | undefined {
  const needle = alias.toLowerCase();
  return accounts.find((a) => a.alias.toLowerCase() === needle);
}

export function accountUsedByRoute(state: StateFile, accountId: string): Lane | null {
  for (const lane of LANES) {
    if (state.routes[lane].accountId === accountId) return lane;
  }
  return null;
}

export function makeAccount(alias: string, secretRef: string): AccountRecord {
  const now = new Date().toISOString();
  return { id: `acct_${randomUUID()}`, alias, secretRef, createdAtUtc: now, updatedAtUtc: now, version: 1 };
}

export const ALIAS_RE = /^[A-Za-z0-9._-]{1,64}$/;

export function validateAlias(alias: string): string | null {
  if (!ALIAS_RE.test(alias)) {
    return "alias must match [A-Za-z0-9._-]{1,64}";
  }
  return null;
}
