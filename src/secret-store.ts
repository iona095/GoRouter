/**
 * GoRouter V1 — Windows DPAPI secret store.
 *
 * Real OpenCode account credentials and the local router access credential
 * are stored as DPAPI-encrypted blobs (per-user, machine-local) via
 * CryptProtectData / CryptUnprotectData through PowerShell 5.1. Plaintext
 * secrets never touch the repository, normal config files, logs, argv or
 * shell history: the plaintext transits only the stdin/stdout pipes of a
 * short-lived local process we spawn.
 *
 * The secret reference (opaque id) is the only thing persisted in the
 * non-secret state file.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync, statSync, mkdirSync } from "node:fs";
import { join, resolve, relative, sep, isAbsolute } from "node:path";
import { randomBytes } from "node:crypto";
import { atomicWriteBytes, tryUnlink, log } from "./util.ts";

/**
 * Absolute PowerShell 5.1 path. Spawned processes (supervisors, restricted
 * shells) may lack System32 on PATH; the Windows absolute location is stable.
 */
function powershellPath(): string {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
  const candidate = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return existsSync(candidate) ? candidate : "powershell.exe";
}

const PS_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class GoRouterDPAPI {
  [DllImport("crypt32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CryptProtectData(ref DATA_BLOB pDataIn, string szDataDescr, IntPtr pOptionalEntropy, IntPtr pvReserved, IntPtr pPromptStruct, uint dwFlags, out DATA_BLOB pDataOut);
  [DllImport("crypt32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CryptUnprotectData(ref DATA_BLOB pDataIn, IntPtr ppszDataDescr, IntPtr pOptionalEntropy, IntPtr pvReserved, IntPtr pPromptStruct, uint dwFlags, out DATA_BLOB pDataOut);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern IntPtr LocalFree(IntPtr hMem);
  [StructLayout(LayoutKind.Sequential)]
  public struct DATA_BLOB { public int cbData; public IntPtr pbData; }
}
"@
$mode = [Console]::In.ReadToEnd().Trim()
$parts = $mode.Split('|', 2)
$inputB64 = $parts[1]
$bytes = [Convert]::FromBase64String($inputB64)
$in = New-Object GoRouterDPAPI+DATA_BLOB
$in.cbData = $bytes.Length
$in.pbData = [Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
[Runtime.InteropServices.Marshal]::Copy($bytes, 0, $in.pbData, $bytes.Length)
$out = New-Object GoRouterDPAPI+DATA_BLOB
$ok = $false
if ($parts[0] -eq 'P') {
  $ok = [GoRouterDPAPI]::CryptProtectData([ref]$in, 'gorouter', [IntPtr]::Zero, [IntPtr]::Zero, [IntPtr]::Zero, 1, [ref]$out)
} else {
  $ok = [GoRouterDPAPI]::CryptUnprotectData([ref]$in, [IntPtr]::Zero, [IntPtr]::Zero, [IntPtr]::Zero, [IntPtr]::Zero, 1, [ref]$out)
}
if (-not $ok) { throw "DPAPI operation failed: Win32 error $([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
$result = New-Object byte[] $out.cbData
[Runtime.InteropServices.Marshal]::Copy($out.pbData, $result, 0, $out.cbData)
[GoRouterDPAPI]::LocalFree($out.pbData) | Out-Null
[Runtime.InteropServices.Marshal]::FreeHGlobal($in.pbData) | Out-Null
[Console]::Out.Write([Convert]::ToBase64String($result))
`;

function powershellWithInput(input: string): { ok: boolean; stdout: string; stderr: string; status: number } {
  // Transient spawn failures (exit -1) have been observed under concurrent
  // load on Windows; retry briefly before giving up.
  let last: ReturnType<typeof spawnOnce> | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) Bun.sleepSync(250 * attempt);
    last = spawnOnce(input);
    if (last.status !== -1) break;
  }
  return last!;
}

function spawnOnce(input: string): { ok: boolean; stdout: string; stderr: string; status: number } {
  const result = spawnSync(
    powershellPath(),
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", PS_SCRIPT],
    { input, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, windowsHide: true, timeout: 30_000 },
  );
  return {
    ok: result.status === 0 && result.error === undefined,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
    status: result.status ?? -1,
  };
}

/** Encrypt plaintext into a DPAPI blob (base64). */
export function dpapiProtect(plaintext: string): string {
  const inputB64 = Buffer.from(plaintext, "utf8").toString("base64");
  const r = powershellWithInput(`P|${inputB64}`);
  if (!r.ok) {
    log.error(`dpapiProtect failed (exit ${r.status}): ${redactShort(r.stderr)}`);
    throw new Error("DPAPI protect failed");
  }
  return r.stdout;
}

/** Decrypt a DPAPI blob (base64) into plaintext. */
export function dpapiUnprotect(blobB64: string): string {
  const r = powershellWithInput(`U|${blobB64}`);
  if (!r.ok) {
    log.error(`dpapiUnprotect failed (exit ${r.status}): ${redactShort(r.stderr)}`);
    throw new Error("DPAPI unprotect failed");
  }
  return Buffer.from(r.stdout, "base64").toString("utf8");
}

function redactShort(s: string): string {
  return s.length > 300 ? `${s.slice(0, 300)}…` : s;
}

// ---------------------------------------------------------------------------
// Secret registry: ref -> DPAPI blob file, with an in-memory decrypt cache.
// ---------------------------------------------------------------------------

export interface SecretStore {
  /** Write/overwrite a secret under a ref. Returns the ref. */
  put(ref: string, plaintext: string): void;
  /** Read a secret; uses cache unless the blob changed. Throws when missing. */
  get(ref: string): string;
  /** Delete a secret blob. */
  /** Remove the blob. Returns true only if a blob was actually removed. */
  delete(ref: string): boolean;
  exists(ref: string): boolean;
}

export function newRef(): string {
  return `sec_${randomBytes(16).toString("hex")}`;
}

/**
 * CURRENT-001 — canonical secret-ref allowlist (single validator).
 *
 * The only refs the product ever mints are `newRef()` values
 * (`sec_` + 32 lowercase hex chars) plus the one fixed admin-token ref
 * `sec_desktop_admin`. Anything else is malformed and must never reach the
 * filesystem. To mint a new fixed ref in the future, extend this validator
 * explicitly — unknown shapes fail closed.
 */
const SECRET_REF_RE = /^sec_(?:[0-9a-f]{32}|desktop_admin)$/;
export function isValidSecretRef(ref: unknown): ref is string {
  return typeof ref === "string" && SECRET_REF_RE.test(ref);
}

export function createSecretStore(secretsDir: string): SecretStore {
  try {
    mkdirSync(secretsDir, { recursive: true });
  } catch { /* caller may re-create; put() will fail loudly otherwise */ }
  // CURRENT-010: identity includes ino — atomic blob replaces mint a new
  // file identity, so same-size/same-tick replacements never false-hit.
  const cache = new Map<string, { mtimeMs: number; size: number; ino: number; value: string }>();

  function blobPath(ref: string): string {
    // CURRENT-001 layer 1: malformed refs never become paths.
    if (!isValidSecretRef(ref)) {
      throw new Error("invalid secret ref (must be sec_<32 lowercase hex> or sec_desktop_admin)");
    }
    const base = resolve(secretsDir);
    const p = resolve(base, `${ref}.bin`);
    // CURRENT-001 layer 3: provable containment. With the allowlist above,
    // rel is always `<ref>.bin`, but verify anyway so a future validator
    // relaxation cannot silently escape the secrets directory.
    const rel = relative(base, p);
    if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error("secret ref escapes secrets directory");
    }
    return p;
  }

  function statOf(ref: string): { mtimeMs: number; size: number; ino: number } | null {
    try {
      const st = statSync(blobPath(ref));
      return { mtimeMs: st.mtimeMs, size: st.size, ino: st.ino };
    } catch {
      return null;
    }
  }

  return {
    put(ref, plaintext) {
      // Validate the path BEFORE any crypto/disk I/O so a hostile ref
      // cannot trigger side effects before it is rejected.
      const target = blobPath(ref);
      const blob = dpapiProtect(plaintext);
      atomicWriteBytes(target, Buffer.from(blob, "utf8"));
      const st = statOf(ref);
      cache.set(ref, { mtimeMs: st?.mtimeMs ?? 0, size: st?.size ?? 0, ino: st?.ino ?? 0, value: plaintext });
    },
    get(ref) {
      if (!isValidSecretRef(ref)) throw new Error("invalid secret ref");
      const st = statOf(ref);
      if (!st) throw new Error(`secret missing: ${ref}`);
      const cached = cache.get(ref);
      if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size && cached.ino === st.ino) return cached.value;
      if (!existsSync(blobPath(ref))) throw new Error(`secret missing: ${ref}`);
      const blob = readFileSync(blobPath(ref), "utf8").trim();
      const value = dpapiUnprotect(blob);
      cache.set(ref, { mtimeMs: st.mtimeMs, size: st.size, ino: st.ino, value });
      return value;
    },
    // F-26: report whether a blob was actually removed — callers must
    // not claim "secret blob deleted" when nothing was there.
    delete(ref) {
      if (!isValidSecretRef(ref)) throw new Error("invalid secret ref");
      cache.delete(ref);
      const p = blobPath(ref);
      if (!existsSync(p)) return false;
      tryUnlink(p);
      return !existsSync(p);
    },
    exists(ref) {
      if (!isValidSecretRef(ref)) throw new Error("invalid secret ref");
      return statOf(ref) !== null;
    },
  };
}

/** Generate a fresh local client credential (32 random bytes, URL-safe). */
export function generateLocalCredential(): string {
  return Buffer.from(randomBytes(32)).toString("base64url");
}
