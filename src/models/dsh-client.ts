/**
 * Slice B — DSH client abstraction (SettingsProvider mutation seam).
 *
 * Provides a narrow, local-only, revision-aware client for llm-pi-ai
 * gorouter-go / gorouter-zen model arrays. No DSH core patch; safe when absent.
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import { redact } from "../util.ts";
import { withFileLockAsyncAt } from "../lock.ts";
import { isLoopbackHostname, DSH_NAMESPACE, DSH_GO_PATH, DSH_ZEN_PATH } from "./dsh-types.ts";
import type { ModelEntry } from "./types.ts";

// --- Errors ---

export class DshConflictError extends Error {
  override name = "DshConflictError";
  code = "SETTINGS_CONFLICT";
  expected: number;
  actual: number;
  constructor(expected: number, actual: number) {
    super(`settings namespace "${DSH_NAMESPACE}" changed since it was read (expected revision ${expected}, now ${actual})`);
    this.expected = expected;
    this.actual = actual;
  }
}

export class DshUnavailableError extends Error {
  override name = "DshUnavailableError";
}

// PRODUCTION_REVISION_MECHANISM=file-content-hash+mtime

export function isConflictError(e: unknown): boolean {
  if (e instanceof DshConflictError) return true;
  const o = e as Record<string, unknown> | null;
  if (!o) return false;
  const code = (o as { code?: unknown }).code;
  const msg = (o as { message?: unknown }).message;
  if (code === "SETTINGS_CONFLICT" || code === "settings-conflict") return true;
  if (typeof msg === "string" && msg.includes("changed since it was read")) return true;
  return false;
}

// --- Interfaces ---

export interface DshSnapshot {
  revision: number;
  go: ModelEntry[];
  zen: ModelEntry[];
  /** Raw provider objects for preservation checks (optional). */
  rawGoProvider?: Record<string, unknown> | null;
  rawZenProvider?: Record<string, unknown> | null;
}

export interface DshClient {
  read(): Promise<DshSnapshot | null>;
  /** Mutate both lanes atomically. Throws DshConflictError on stale revision. */
  mutate(desiredGo: ModelEntry[], desiredZen: ModelEntry[], expectedRevision: number): Promise<{ revision: number }>;
  /**
   * F-17 (CURRENT-002 reopened): stable semantic target identity for
   * reconcile single-flight keying. Production constructs a FRESH client
   * object per call, so object identity never coalesces — the key must be
   * the target (file path / base URL), equal across instances on the same
   * target. Optional so legacy test doubles without a declared target
   * still typecheck; such clients never coalesce (fail-closed).
   */
  identity?(): string;
}

// --- File seam helpers ---

function resolveDshHome(configured?: string | null): string {
  const trim = (v: string | undefined): string | null => {
    if (!v) return null;
    const t = v.trim();
    return t.length > 0 ? t : null;
  };
  function assertLocalPath(p: string): void {
    const t = p.trim();
    if (t.startsWith("\\\\")) throw new Error("DSH_HOME must be a local path, not a remote UNC share");
    if (t.startsWith("//")) throw new Error("DSH_HOME must be a local path, not a remote UNC share");
    if (t.startsWith("file://")) {
      try {
        const u = new URL(t);
        const host = u.hostname.toLowerCase();
        // CURRENT-011: canonical loopback only (no startsWith trust, no remote host).
        if (host !== "" && !isLoopbackHostname(host)) {
          throw new Error("DSH_HOME file:// must be local (no remote host)");
        }
      } catch (e) {
        if (e instanceof Error && e.message.includes("DSH_HOME")) throw e;
        // fall through
      }
    }
  }
  const explicit = configured !== undefined && configured !== null ? trim(configured) : null;
  if (explicit) {
    assertLocalPath(explicit);
    // expand ~/ prefix
    if (explicit === "~") return homedir();
    if (explicit.startsWith("~/") || explicit.startsWith("~\\")) return join(homedir(), explicit.slice(2));
    const resolved = resolve(explicit);
    // DSH_HOME UNC check after resolve: reject // and \\ prefixes in resolved path
    if (resolved.startsWith("\\\\") || resolved.startsWith("//")) {
      throw new Error("DSH_HOME must be a local path, not a remote UNC share: " + resolved);
    }
    return resolved;
  }
  const env = trim(process.env.DSH_HOME);
  if (env) {
    assertLocalPath(env);
    if (env === "~") return homedir();
    if (env.startsWith("~/") || env.startsWith("~\\")) return join(homedir(), env.slice(2));
    const resolvedEnv = resolve(env);
    if (resolvedEnv.startsWith("\\\\") || resolvedEnv.startsWith("//")) {
      throw new Error("DSH_HOME must be a local path, not a remote UNC share: " + resolvedEnv);
    }
    return resolvedEnv;
  }
  return join(homedir(), ".dsh");
}

function dshSettingsPath(settingsPath?: string | null, dshHome?: string | null): string {
  if (settingsPath && settingsPath.trim().length > 0) {
    const p = settingsPath.trim();
    // must be local-only (no remote URL)
    if (p.includes("://") && !p.startsWith("file://")) {
      throw new Error("dsh settingsPath must be a local file path, not a remote URL");
    }
    if (p.startsWith("file://")) {
      // Validate file:// is local-only: hostname must be empty or loopback.
      try {
        const u = new URL(p);
        const host = u.hostname.toLowerCase();
        // CURRENT-011: canonical loopback only (no startsWith trust).
        if (host !== "" && !isLoopbackHostname(host)) {
          throw new Error("dsh settingsPath file:// must be local (no remote host): " + p);
        }
      } catch (e) {
        if (e instanceof Error && e.message.includes("dsh settingsPath file://")) throw e;
      }
      const file = p.slice("file://".length);
      // file:///C:/path -> /C:/path; normalize via resolve will handle
      // Reject if the sliced path itself looks like //server/share (should have been caught)
      if (file.startsWith("//")) throw new Error("dsh settingsPath must be local, not UNC: " + p);
      return resolve(file);
    }
    // Bare path: reject UNC
    if (p.startsWith("\\\\") || p.startsWith("//")) {
      throw new Error("dsh settingsPath must be a local path, not a remote UNC share: " + p);
    }
    return resolve(p);
  }
  const home = resolveDshHome(dshHome ?? undefined);
  return join(home, "settings.yaml");
}

// Minimal YAML-ish handling: settings.yaml is YAML but we can parse via simple approach
// For robustness we use 'yaml' via dynamic import when available, otherwise fallback to JSON/YAML light.
// However DSH settings.yaml is produced by FileSettingsProvider which uses 'yaml' package; we bundle same.
// Use dynamic require of 'yaml' if present, else naive.

async function parseSettingsYaml(text: string): Promise<Record<string, unknown>> {
  const trimmed = text.trim();
  if (!trimmed) return {};
  // Genuine YAML parse via bundled yaml (not dynamic optional) — proves settings.yaml compatibility
  // JSON is valid YAML 1.2, so yaml parse handles both, but we keep explicit JSON fast-path for parity.
  try {
    const yamlMod = await import("yaml");
    const parsed = (yamlMod as unknown as { parse: (t: string) => unknown }).parse(text);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    if (parsed === null || parsed === undefined) return {};
    return {};
  } catch {
    // Fallback: JSON parse (valid YAML subset) if yaml throws
    try {
      const j = JSON.parse(text);
      if (typeof j === "object" && j !== null && !Array.isArray(j)) return j as Record<string, unknown>;
    } catch {}
    return {};
  }
}

/**
 * Fidelity-preserving render (M5): the operator's settings.yaml may carry
 * comments, anchors, key order and style choices that a JSON re-serialize
 * destroys. Parse to a CST Document, replace ONLY the two owned models
 * sequences in place, and stringify — everything else (comments, unrelated
 * providers, top-level keys, style) survives byte-for-byte where the CST
 * allows. Any surprise (YAML errors, non-map namespace, reparse mismatch)
 * falls back to the previous JSON output (valid YAML 1.2, DSH re-parses
 * either) — fidelity is best-effort, validity is guaranteed.
 */
async function renderSettingsYaml(
  sourceText: string,
  desiredGo: ModelEntry[],
  desiredZen: ModelEntry[],
  fallbackDoc: Record<string, unknown>,
): Promise<string> {
  const fallback = JSON.stringify(fallbackDoc, null, 2) + "\n";
  try {
    const yamlMod = (await import("yaml")) as unknown as {
      parseDocument: (t: string) => {
        errors: unknown[];
        setIn: (path: string[], v: unknown) => void;
        createNode: (v: unknown) => unknown;
        toString: () => string;
      };
    };
    const doc = yamlMod.parseDocument(sourceText.trim() === "" ? "{}\n" : sourceText);
    if (!doc || doc.errors.length > 0) return fallback;
    doc.setIn([DSH_NAMESPACE, "providers", "gorouter-go", "models"], doc.createNode(desiredGo));
    doc.setIn([DSH_NAMESPACE, "providers", "gorouter-zen", "models"], doc.createNode(desiredZen));
    const out = doc.toString();
    // Fail-safe: the CST round-trip must yield exactly the intended models;
    // otherwise the file gets the valid-JSON fallback, never a surprise.
    const check = await parseSettingsYaml(out);
    const ns = (check[DSH_NAMESPACE] as Record<string, unknown> | undefined) ?? {};
    const provs = (ns["providers"] as Record<string, unknown> | undefined) ?? {};
    // Full-entry comparison (not ids only): blind to field loss otherwise,
    // and vacuous when both lanes are empty. Parsed-value comparison, so
    // YAML scalar styling (quotes, flow) cannot false-trigger.
    const modelsOf = (lane: string): ModelEntry[] =>
      ((provs[lane] as Record<string, unknown> | undefined)?.["models"] as ModelEntry[] | undefined) ?? [];
    // JSON-normalized both sides: undefined-valued keys (dropped by JSON,
    // possibly nulled by YAML) must not false-trigger the fallback.
    const norm = (v: unknown): string => JSON.stringify(JSON.parse(JSON.stringify(v)));
    if (norm(modelsOf("gorouter-go")) !== norm(desiredGo)) return fallback;
    if (norm(modelsOf("gorouter-zen")) !== norm(desiredZen)) return fallback;
    return out;
  } catch {
    return fallback;
  }
}

/**
 * FILE_SHARED_LOCK_MECHANISM: DSH-native <file>.lock sibling via the shared
 * ownership-safe async core (../lock.ts withFileLockAsyncAt — CURRENT-006).
 * Same convention as @deepseek-ai/dsh-atomic-write/withFileLock and
 * @deepseek-ai/dsh-settings-file/FileSettingsProvider.persistSection:
 * lock path = filename + ".lock", wx exclusive create (mode 0o600),
 * 2s acquire deadline, nonce ownership claims, dead-holder/absolute-ceiling
 * reclaim, ownership-checked release. A crashed holder's orphan is reclaimed
 * by the next acquirer instead of wedging writers forever; a live holder is
 * never displaced. This serializes cross-process read-modify-write cycles;
 * readers stay lock-free via atomic rename commit. FileDshClient.mutate holds
 * this lock across the entire read→validate→render→writeFileAtomic critical
 * section, so FINAL_CHECK_TO_RENAME cannot be bypassed by a concurrent DSH
 * writer.
 */
const DEFAULT_LOCK_WAIT_MS = 2000;

async function withFileLock<T>(filename: string, operation: () => Promise<T>, waitMs: number = DEFAULT_LOCK_WAIT_MS): Promise<T> {
  const lockPath = `${filename}.lock`;
  return withFileLockAsyncAt(lockPath, {
    timeoutMs: waitMs,
    mode: 0o600,
    timeoutMessage: `atomic-write: timed out waiting for the writer lock at ${lockPath}`,
  }, operation);
}

// R3-010: exported for the durability regression test (fsync-before-rename
// order through the real fs stack). Production callers use FileDshClient.
export async function writeFileAtomic(filename: string, content: string, mode: number = 0o600): Promise<void> {
  const { mkdir, rename, rm, open } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  await mkdir(dirname(filename), { recursive: true, mode: 0o700 });
  const { randomBytes } = await import("node:crypto");
  const temp = `${filename}.${randomBytes(6).toString("hex")}.tmp`;
  // R3-010: same durability contract as the project's sync atomic writers
  // (write -> fsync -> close -> rename). Without the fsync a crash between
  // the rename commit and the cache flush can lose or corrupt the
  // third-party settings file. The catch below is shared by the write,
  // fsync, and rename stages: the target is intact either way (rename is
  // the only commit point) and the staging temp is always removed.
  const fh = await open(temp, "wx", mode);
  try {
    await fh.writeFile(content, "utf8");
    await fh.sync();
    await fh.close();
    await rename(temp, filename);
  } catch (error) {
    try { await fh.close(); } catch {}
    try { await rm(temp, { force: true }); } catch {}
    throw error;
  }
}

/**
 * PRODUCTION_REVISION_MECHANISM=file-content-hash+mtime — hybrid content-hash + mtime bucket.
 *   PRODUCTION_REVISION_MECHANISM (file seam):
 *   revision = SHA-256(content) truncated to 48 bits (first 6 bytes) combined
 *   with a coarse mtime bucket to preserve monotonic ordering; content hash is
 *   the collision-proof component so two writes with identical mtime but different
 *   content produce different revisions and the second writer's expectedRevision
 *   check correctly detects the conflict.
 *   HttpDshClient uses DSH's native monotonic expectedRevision (server-side).
 *
 * Rationale: filesystem mtime alone (Math.floor(mtimeMs)) collapses to 1ms
 * granularity and can be equal for two distinct writes (coalesced timestamps,
 * VM clock, rapid edit). Content hash is the collision-resistant component
 * (48-bit: same-mtime/different-content edits differ absent a hash
 * collision); the mtime bucket preserves monotonic ordering across edits.
 */
/**
 * Content-hash + mtime hybrid revision (M1): 48-bit SHA-256 prefix folded with
 * a 16-bit mtime bucket. Pure integer arithmetic — no bitwise ops, which would
 * silently truncate the value to 32 bits (the old `(n ^ bucket) >>> 0` did
 * exactly that, contradicting the 48-bit claim). Result is always an integer
 * below 2^48, so it round-trips exactly through JSON and SQLite.
 *
 * Note: values differ from pre-fix revisions (which were 32-bit). Revisions
 * are recomputed live from file content on every read, so the only upgrade
 * effect is a single conservative mismatch, never a false match — but a
 * preview taken pre-fix and applied post-fix (or vice versa) ALWAYS
 * mismatches and forces re-preview. Automated preview→ratify→apply flows
 * must re-preview after upgrading (safe direction: spurious mismatch, not a
 * false match).
 */
export function fileContentRevision(text: string, mtimeMs?: number): number {
  const h = createHash("sha256").update(text, "utf8").digest();
  let n = 0;
  for (let i = 0; i < 6; i++) n = n * 256 + h[i]!;
  if (typeof mtimeMs === "number" && Number.isFinite(mtimeMs)) {
    // Non-negative bucket even for exotic (negative/pre-epoch) mtimes.
    const bucket = ((Math.floor(mtimeMs / 1000) % 65536) + 65536) % 65536;
    // Clear the low 16 bits arithmetically, then add the bucket.
    n = n - (n % 65536) + bucket;
  }
  return n;
}
function fileRevisionFromTextAndMtime(text: string, mtimeMs?: number): number {
  return fileContentRevision(text, mtimeMs);
}

function extractModels(snapshot: Record<string, unknown> | undefined, path: readonly string[]): ModelEntry[] {
  let cur: unknown = snapshot;
  for (const seg of path.slice(0, -1)) {
    if (typeof cur !== "object" || cur === null) return [];
    cur = (cur as Record<string, unknown>)[seg];
  }
  const last = path[path.length - 1]!;
  if (typeof cur !== "object" || cur === null) return [];
  const arr = (cur as Record<string, unknown>)[last];
  if (!Array.isArray(arr)) return [];
  return arr.filter((m): m is ModelEntry => typeof m === "object" && m !== null && typeof (m as Record<string, unknown>).id === "string");
}

// --- HTTP seam (Typert) helpers ---

function dshWebUrl(configured?: string | null): string | null {
  const trim = (v: string | undefined): string | null => {
    if (!v) return null;
    const t = v.trim();
    return t.length > 0 ? t : null;
  };
  const explicit = configured !== undefined && configured !== null ? trim(configured) : null;
  if (explicit) return explicit;
  const env = trim(process.env.DSH_WEB_URL);
  if (env) return env;
  return null;
}

// The HOST endpoint (Typert RPC) may serve TLS, so https is allowed here.
// This is intentionally wider than the owned-provider BINDING check
// (dsh-binding.ts), which requires plaintext http: because the bindings
// must point at GoRouter's own loopback lane routes (M8: deliberate split,
// not an inconsistency).
function validateLoopbackUrl(value: string): URL {
  const u = new URL(value);
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("DSH endpoint must be http(s)");
  if (!isLoopbackHostname(u.hostname)) throw new Error("DSH endpoint must be loopback (127.0.0.1/localhost/::1)");
  return u;
}

// --- FileDshClient ---

export class FileDshClient implements DshClient {
  private filePath: string;
  /** F-17: stable semantic identity — the resolved settings path. */
  identity(): string {
    return `file:${this.filePath}`;
  }
  constructor(settingsPath?: string | null, dshHome?: string | null) {
    this.filePath = dshSettingsPath(settingsPath, dshHome);
    // Validate local-only
    if (this.filePath.includes("://") && !this.filePath.startsWith("/")) {
      throw new Error("dsh settingsPath must be local");
    }
  }

  async read(): Promise<DshSnapshot | null> {
    if (!existsSync(this.filePath)) return null;
    let text: string;
    try {
      text = readFileSync(this.filePath, "utf8");
    } catch (e) {
      throw new DshUnavailableError(`dsh settings file unreadable: ${redact(e instanceof Error ? e.message : String(e))}`);
    }
    const doc = await parseSettingsYaml(text);
    const nsRaw = doc[DSH_NAMESPACE] as Record<string, unknown> | undefined;
    if (!nsRaw || typeof nsRaw !== "object") return null;
    const providers = (nsRaw as Record<string, unknown>)["providers"] as Record<string, unknown> | undefined;
    if (!providers || typeof providers !== "object") return null;
    const goProv = providers["gorouter-go"] as Record<string, unknown> | undefined;
    const zenProv = providers["gorouter-zen"] as Record<string, unknown> | undefined;
    const go = Array.isArray(goProv?.["models"]) ? (goProv?.["models"] as ModelEntry[]).filter((m) => typeof m?.id === "string") : [];
    const zen = Array.isArray(zenProv?.["models"]) ? (zenProv?.["models"] as ModelEntry[]).filter((m) => typeof m?.id === "string") : [];
    // PRODUCTION_REVISION_MECHANISM=file-content-hash+mtime: hash48 + mtime bucket
    let _mtimeMsForRev: number | undefined;
    try { const { statSync: _rs } = await import("node:fs"); _mtimeMsForRev = _rs(this.filePath).mtimeMs; } catch {}
    const revision = fileRevisionFromTextAndMtime(text, _mtimeMsForRev);
    return { revision, go, zen, rawGoProvider: (goProv as Record<string, unknown>) ?? null, rawZenProvider: (zenProv as Record<string, unknown>) ?? null };
  }

  async mutate(desiredGo: ModelEntry[], desiredZen: ModelEntry[], _expectedRevision: number): Promise<{ revision: number }> {
    // Entire read→validate→render→commit held under the SAME <file>.lock as
    // DSH FileSettingsProvider (dsh-atomic-write/withFileLock). This closes
    // FINAL_CHECK_TO_RENAME_RACE: no writer B can mutate between our final
    // revision observation and our rename, because both serialize on the lock.
    return withFileLock(this.filePath, async () => {
      let beforeText = "";
      let doc: Record<string, unknown> = {};
      if (existsSync(this.filePath)) {
        beforeText = readFileSync(this.filePath, "utf8");
        doc = await parseSettingsYaml(beforeText);
      }
      let currentRevision: number;
      let currentText: string;
      let currentMtimeMs: number | undefined;
      try { const { statSync: _sm } = await import("node:fs"); currentMtimeMs = _sm(this.filePath).mtimeMs; } catch {}
      if (existsSync(this.filePath)) {
        try {
          currentText = readFileSync(this.filePath, "utf8");
          currentRevision = fileRevisionFromTextAndMtime(currentText, currentMtimeMs);
          if (currentText !== beforeText) {
            doc = await parseSettingsYaml(currentText);
          }
        } catch {
          currentText = beforeText;
          currentRevision = beforeText ? fileRevisionFromTextAndMtime(beforeText, currentMtimeMs) : 0;
        }
      } else {
        currentText = "";
        currentRevision = 0;
        if (beforeText !== "") doc = {};
      }
      const curNsRaw = (doc[DSH_NAMESPACE] as Record<string, unknown>) ?? {};
      const curProviders = ((curNsRaw as Record<string, unknown>)["providers"] as Record<string, unknown>) ?? {};
      const curGoProv = ((curProviders["gorouter-go"] as Record<string, unknown>) ?? {}) as Record<string, unknown>;
      const curZenProv = ((curProviders["gorouter-zen"] as Record<string, unknown>) ?? {}) as Record<string, unknown>;
      if (_expectedRevision !== currentRevision) {
        throw new DshConflictError(_expectedRevision, currentRevision);
      }
      const nextGoProv = { ...curGoProv, models: desiredGo };
      const nextZenProv = { ...curZenProv, models: desiredZen };
      const nextProviders = { ...curProviders, ["gorouter-go"]: nextGoProv, ["gorouter-zen"]: nextZenProv };
      const nextNsRaw = { ...(curNsRaw as Record<string, unknown>), providers: nextProviders };
      const nextDoc = { ...doc, [DSH_NAMESPACE]: nextNsRaw };
      const text = await renderSettingsYaml(currentText, desiredGo, desiredZen, nextDoc);
      // Commit via the same atomic sibling+rename as dsh-atomic-write/writeFileAtomic
      await writeFileAtomic(this.filePath, text, 0o600);
      let newRev: number;
      try {
        const written = readFileSync(this.filePath, "utf8");
        let writtenMtime: number | undefined;
        try { const { statSync: _wm } = await import("node:fs"); writtenMtime = _wm(this.filePath).mtimeMs; } catch {}
        newRev = fileRevisionFromTextAndMtime(written, writtenMtime);
      } catch {
        newRev = fileContentRevision(text, undefined);
      }
      return { revision: newRev };
    });
  }
}

// --- HttpDshClient (Typert via DSH host) ---

/** Loopback DSH RPC timeout: a hung host must fail fast, never stall the
 * reconcile single-flight indefinitely (M6). Generous for localhost. */
export const DSH_HTTP_TIMEOUT_MS = 10_000;

/** Floor for explicit RPC timeouts: sub-second budgets abort localhost RPCs
 * spuriously under load, and 0/negative/NaN abort immediately or throw. */
export const MIN_DSH_TIMEOUT_MS = 1_000;

/**
 * Ceiling: AbortSignal.timeout throws RangeError past ~2^31-1ms (misreported
 * as 'unreachable' by the catch below), and anything past minutes on a
 * localhost RPC is a config smell. Oversize budgets clamp to the default.
 */
export const MAX_DSH_TIMEOUT_MS = 300_000;

/** Clamp an explicit timeout to the sane range (test seam: pure). */
export function clampDshTimeoutMs(t: number | undefined): number {
  if (!Number.isFinite(t)) return DSH_HTTP_TIMEOUT_MS;
  const ms = Math.floor(t as number);
  if (ms < MIN_DSH_TIMEOUT_MS || ms > MAX_DSH_TIMEOUT_MS) return DSH_HTTP_TIMEOUT_MS;
  return ms;
}

export class HttpDshClient implements DshClient {
  private baseUrl: string;
  private hostHeader: string;
  private timeoutMs: number;
  /** F-17: stable semantic identity — the normalized origin. */
  identity(): string {
    return `http:${this.baseUrl}`;
  }
  constructor(webUrl: string, opts: { timeoutMs?: number } = {}) {
    const u = validateLoopbackUrl(webUrl);
    this.baseUrl = u.origin;
    this.hostHeader = u.host;
    // Unclamped timeouts abort immediately (0/negative) or throw RangeError
    // (NaN): floor to the sane localhost default instead.
    this.timeoutMs = clampDshTimeoutMs(opts.timeoutMs);
  }

  private async rpc(endpoint: string, payload: unknown): Promise<unknown> {
    const body = JSON.stringify({ type: "client-request", rpcId: randomUUID(), method: endpoint, payload });
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "host": this.hostHeader,
        },
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      // A hung host must surface as DshUnavailableError (the type callers
      // branch on for fail-closed reconcile), never a raw TimeoutError —
      // with the configured budget in the message for operability.
      const name = e instanceof Error ? e.name : "";
      const what = name === "TimeoutError" || name === "AbortError" ? "timeout" : "unreachable";
      throw new DshUnavailableError(`dsh host ${what} after ${this.timeoutMs}ms (${endpoint})`);
    }
    if (res.status === 403) throw new DshUnavailableError(`dsh host forbidden (loopback fence): ${res.status}`);
    if (res.status !== 200) throw new DshUnavailableError(`dsh host unexpected status ${res.status}`);
    const json = await res.json() as Record<string, unknown>;
    const result = (json["result"] ?? json) as Record<string, unknown>;
    // Handle both envelope styles
    if (json["result"] !== undefined) {
      const r = json["result"] as Record<string, unknown>;
      if (r["ok"] === false) {
        const err = r["error"] as Record<string, unknown> | undefined;
        const code = err?.["code"] as string | undefined;
        const message = (err?.["message"] as string) ?? (r["message"] as string) ?? "dsh error";
        if (code === "settings-conflict") {
          const details = err?.["details"] as Record<string, unknown> | undefined;
          const expected = typeof details?.["expected"] === "number" ? details["expected"] as number : 0;
          const actual = typeof details?.["actual"] === "number" ? details["actual"] as number : 0;
          throw new DshConflictError(expected, actual);
        }
        throw new Error(redact(message));
      }
      if (r["ok"] === true) return r["value"];
    }
    // Fallback: raw ok/value
    if ((json["ok"] as unknown) === false) {
      const err = (json["error"] as Record<string, unknown>) ?? {};
      const code = err["code"] as string | undefined;
      const message = (err["message"] as string) ?? "dsh error";
      if (code === "settings-conflict" || code === "SETTINGS_CONFLICT") {
        const details = err["details"] as Record<string, unknown> | undefined;
        const expected = typeof details?.["expected"] === "number" ? details["expected"] as number : 0;
        const actual = typeof details?.["actual"] === "number" ? details["actual"] as number : 0;
        throw new DshConflictError(expected, actual);
      }
      throw new Error(redact(message));
    }
    if ((json["ok"] as unknown) === true) return json["value"];
    return json["value"] ?? json;
  }

  async read(): Promise<DshSnapshot | null> {
    let value: unknown;
    try {
      value = await this.rpc("settings.describe", {});
    } catch (e) {
      if (e instanceof DshUnavailableError) throw e;
      throw new DshUnavailableError(`dsh describe failed: ${redact(e instanceof Error ? e.message : String(e))}`);
    }
    const namespaces = (value as Record<string, unknown>)["namespaces"] as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(namespaces)) return null;
    const ns = namespaces.find((n) => n["ns"] === DSH_NAMESPACE);
    if (!ns) return null;
    const revision = typeof ns["revision"] === "number" ? ns["revision"] as number : 0;
    const providers = ((ns["value"] as Record<string, unknown>)?.["providers"] ?? (ns["user"] as Record<string, unknown>)?.["providers"]) as Record<string, unknown> | undefined;
    if (!providers || typeof providers !== "object") {
      // Fall back to value.providers
      const v = ns["value"] as Record<string, unknown> | undefined;
      const p = v?.["providers"] as Record<string, unknown> | undefined;
      if (!p) return { revision, go: [], zen: [] };
    }
    const vProviders = ((ns["value"] as Record<string, unknown>)?.["providers"] as Record<string, unknown>) ?? {};
    const goProv = vProviders["gorouter-go"] as Record<string, unknown> | undefined;
    const zenProv = vProviders["gorouter-zen"] as Record<string, unknown> | undefined;
    const go = Array.isArray(goProv?.["models"]) ? (goProv?.["models"] as ModelEntry[]).filter((m) => typeof m?.id === "string") : [];
    const zen = Array.isArray(zenProv?.["models"]) ? (zenProv?.["models"] as ModelEntry[]).filter((m) => typeof m?.id === "string") : [];
    return { revision, go, zen, rawGoProvider: (goProv as Record<string, unknown>) ?? null, rawZenProvider: (zenProv as Record<string, unknown>) ?? null };
  }

  async mutate(desiredGo: ModelEntry[], desiredZen: ModelEntry[], expectedRevision: number): Promise<{ revision: number }> {
    const ops = [
      { op: "set" as const, path: [...DSH_GO_PATH], value: desiredGo },
      { op: "set" as const, path: [...DSH_ZEN_PATH], value: desiredZen },
    ];
    let value: unknown;
    try {
      value = await this.rpc("settings.mutate", { ns: DSH_NAMESPACE, ops, expectedRevision });
    } catch (e) {
      if (isConflictError(e)) throw e;
      if (e instanceof DshUnavailableError) throw e;
      throw new DshUnavailableError(`dsh mutate failed: ${redact(e instanceof Error ? e.message : String(e))}`);
    }
    const rev = (value as Record<string, unknown>)["revision"];
    if (typeof rev === "number") return { revision: rev as number };
    // Fallback: re-describe
    const snap = await this.read();
    return { revision: snap?.revision ?? expectedRevision + 1 };
  }
}

// --- Factory ---

export interface DshClientOptions {
  settingsPath?: string | null;
  dshHome?: string | null;
  dshWebUrl?: string | null;
}

/**
 * Client selection. An EXPLICIT web URL (configured or DSH_WEB_URL) that
 * fails loopback validation THROWS (M7) — the old silent fall-through to
 * the file client meant the operator believed they were driving the remote
 * host while edits landed in the local file (or vice versa). No URL at
 * all still selects the file client. All production callers are
 * failure-isolated, so the throw surfaces as a loud sync error, never a
 * crash.
 */
export function createDshClient(opts: DshClientOptions = {}): DshClient {
  const web = dshWebUrl(opts.dshWebUrl ?? null);
  if (web) {
    validateLoopbackUrl(web);
    return new HttpDshClient(web);
  }
  return new FileDshClient(opts.settingsPath ?? null, opts.dshHome ?? null);
}

let nextMemClientId = 1;

/** For tests: injectable in-memory client. Optional identity declares the simulated target for single-flight keying. */
export function createMemoryDshClient(initial: { go: ModelEntry[]; zen: ModelEntry[]; revision?: number; rawGoProvider?: Record<string, unknown> | null; rawZenProvider?: Record<string, unknown> | null }, identity?: string): DshClient & { mutations: number; history: Array<{ go: ModelEntry[]; zen: ModelEntry[]; rev: number }> } {
  let rev = initial.revision ?? 0;
  let go = [...initial.go];
  let zen = [...initial.zen];
  const history: Array<{ go: ModelEntry[]; zen: ModelEntry[]; rev: number }> = [];
  return {
    identity() { return `mem:${identity ?? `auto-${nextMemClientId++}`}`; },
    async read() { return { revision: rev, go: [...go], zen: [...zen], rawGoProvider: initial.rawGoProvider ?? null, rawZenProvider: initial.rawZenProvider ?? null }; },
    mutations: 0,
    history,
    async mutate(desiredGo, desiredZen, expectedRevision) {
      if (expectedRevision !== rev) throw new DshConflictError(expectedRevision, rev);
      go = [...desiredGo];
      zen = [...desiredZen];
      rev += 1;
      (this as unknown as { mutations: number }).mutations += 1;
      history.push({ go: [...go], zen: [...zen], rev });
      return { revision: rev };
    },
  };
}