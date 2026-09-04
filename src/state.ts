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
import type { SecretStore } from "./secret-store.ts";
import type { Paths } from "./paths.ts";

export const STATE_SCHEMA_VERSION = 1;

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
}

export interface RouteSelection {
  /** Account id, or null when no account is selected for the lane. */
  accountId: string | null;
}

export interface StateFile {
  schemaVersion: number;
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

export function defaultState(): StateFile {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    accounts: [],
    routes: { go: { accountId: null }, zen: { accountId: null } },
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
  /** Whether the most recent state load failed (corruption/read errors). */
  health(): { corrupt: boolean };
}

export function createStateStore(paths: Paths, secrets: SecretStore, opts: { quarantine?: typeof quarantineCorruptFile } = {}): StateStore {
  // Test seam (precedent: setInboundBodyIdleTimeoutForTests): inject a
  // failing quarantine to pin the refuse-while-unpreserved path, which real
  // filesystems trigger only on rare rename failures.
  const quarantineFile = opts.quarantine ?? quarantineCorruptFile;
  let cache: { mtimeMs: number; size: number; state: StateFile } | null = null;
  let corrupt = false;

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

  function load(): StateFile {
    const p = paths.stateJson;
    if (!existsSync(p)) {
      // Missing file heals the corrupt flag in-process: no good copy remains
      // on disk (we quarantined it away, or the operator deleted it per the
      // refusal message), so serving defaults and allowing re-setup is the
      // documented repair — the same-process delete+setup path must not wedge.
      if (corrupt) {
        log.warn(`state.json absent; clearing corrupt flag (evidence${lastQuarantine ? ` preserved at ${lastQuarantine}` : " was never quarantined — operator reset"}); repair via setup allowed`);
        corrupt = false;
        cache = null;
      }
      return defaultState();
    }
    const st = statSync(p);
    if (cache && cache.mtimeMs === st.mtimeMs && cache.size === st.size) return cache.state;
    let raw: string;
    try {
      raw = readFileSync(p, "utf8");
    } catch {
      corrupt = true;
      quarantine(p);
      cache = null;
      log.warn(`state read failed; using defaults (path=${p})`);
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
    const state = normalizeState(parsed);
    corrupt = false;
    lastQuarantine = null; // healed: prior evidence is superseded, never name it again
    cache = { mtimeMs: st.mtimeMs, size: st.size, state };
    return state;
  }

  function write(state: StateFile): void {
    refuseIfCorrupt();
    atomicWriteJson(paths.stateJson, state);
    cache = null; // force a fresh read next time
  }

  return {
    read: load,
    write,
    mutate(fn) {
      const state = load();
      refuseIfCorrupt();
      fn(state);
      write(state);
      return state;
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
    health() {
      return { corrupt };
    },
  };
}

function normalizeState(parsed: unknown): StateFile {
  const base = defaultState();
  if (typeof parsed !== "object" || parsed === null) return base;
  const raw = parsed as Record<string, unknown>;
  const out: StateFile = base;
  if (typeof raw.schemaVersion === "number") out.schemaVersion = raw.schemaVersion;
  if (Array.isArray(raw.accounts)) {
    out.accounts = raw.accounts.filter(isAccountRecord).map((a) => ({ ...a }));
  }
  if (typeof raw.routes === "object" && raw.routes !== null) {
    const r = raw.routes as Record<string, unknown>;
    for (const lane of LANES) {
      const sel = r[lane];
      if (sel && typeof sel === "object" && "accountId" in sel) {
        const v = (sel as { accountId?: unknown }).accountId;
        out.routes[lane] = { accountId: typeof v === "string" ? v : null };
      }
    }
  }
  if (typeof raw.settings === "object" && raw.settings !== null) {
    const s = raw.settings as Record<string, unknown>;
    if (typeof s.port === "number") out.settings.port = s.port;
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
    if (typeof s.journalRetentionDays === "number") out.settings.journalRetentionDays = s.journalRetentionDays;
    if (typeof s.journalMaxRecords === "number") out.settings.journalMaxRecords = s.journalMaxRecords;
  }
  if (typeof raw.localCredentialRef === "string") out.localCredentialRef = raw.localCredentialRef;
  return out;
}

function isAccountRecord(v: unknown): v is AccountRecord {
  if (typeof v !== "object" || v === null) return false;
  const a = v as Record<string, unknown>;
  return (
    typeof a.id === "string" &&
    typeof a.alias === "string" &&
    typeof a.secretRef === "string"
  );
}

// ---------------------------------------------------------------------------
// Account lifecycle helpers (used by the CLI)
// ---------------------------------------------------------------------------

export function findAccount(state: StateFile, aliasOrId: string): AccountRecord | undefined {
  const needle = aliasOrId.toLowerCase();
  return state.accounts.find((a) => a.alias.toLowerCase() === needle || a.id === needle);
}

export function accountUsedByRoute(state: StateFile, accountId: string): Lane | null {
  for (const lane of LANES) {
    if (state.routes[lane].accountId === accountId) return lane;
  }
  return null;
}

export function makeAccount(alias: string, secretRef: string): AccountRecord {
  const now = new Date().toISOString();
  return { id: `acct_${randomUUID()}`, alias, secretRef, createdAtUtc: now, updatedAtUtc: now };
}

export const ALIAS_RE = /^[A-Za-z0-9._-]{1,64}$/;

export function validateAlias(alias: string): string | null {
  if (!ALIAS_RE.test(alias)) {
    return "alias must match [A-Za-z0-9._-]{1,64}";
  }
  return null;
}
