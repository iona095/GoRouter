/**
 * GoRouter V1.5 — control-pipe DACL hardening.
 *
 * Empirically verified on this host (2026-08-08): the DEFAULT named-pipe
 * security descriptor libuv/node:net applies grants FILE_READ_DATA to
 * Everyone and Anonymous:
 *
 *   D:(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;<user>)(A;;FR;;;WD)(A;;FR;;;AN)
 *
 * Writes are already restricted to SYSTEM/Administrators/the owner, and every
 * control message requires the admin token, so control cannot be seized
 * cross-user — but the read grants are broader than the per-user boundary the
 * contract demands (§5.1 "OS-user-scoped IPC/ACLs"). After binding, the
 * control service replaces the DACL with SYSTEM + Administrators + current
 * user only.
 *
 * The PS 5.1 implementation is embedded (single source of truth) and invoked
 * via -EncodedCommand so no temp script files are needed in the packaged
 * artifact and nothing secret appears on argv (the pipe name is not secret).
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const PIPE_ACL_PS = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class GorouterPipeAcl {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern IntPtr CreateFile(string name, uint access, uint share, IntPtr sa, uint disp, uint flags, IntPtr tmpl);
  [DllImport("advapi32.dll", SetLastError=true)]
  public static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string sddl, int rev, out IntPtr sd, out uint size);
  [DllImport("advapi32.dll", SetLastError=true)]
  public static extern bool GetSecurityDescriptorDacl(IntPtr sd, out bool present, out IntPtr dacl, out bool defaulted);
  [DllImport("advapi32.dll", SetLastError=true)]
  public static extern int SetSecurityInfo(IntPtr handle, int objectType, uint info, IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);
  [DllImport("advapi32.dll", SetLastError=true)]
  public static extern int GetSecurityInfo(IntPtr handle, int objectType, uint info, out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr sd);
  [DllImport("advapi32.dll", SetLastError=true)]
  public static extern bool ConvertSecurityDescriptorToStringSecurityDescriptorW(IntPtr sd, int rev, uint info, out IntPtr sddl, out uint len);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] public static extern bool LocalFree(IntPtr h);
}
"@
$mode = '__MODE__'
$pipe = '__PIPE__'
$userSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$h = [GorouterPipeAcl]::CreateFile($pipe, 0x00060000, 0x3, [IntPtr]::Zero, 3, 0, [IntPtr]::Zero)
if ($h -eq [IntPtr](-1)) { throw "pipe open failed: Win32 error $([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
try {
  if ($mode -eq 'harden') {
    $sddl = "D:(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;$userSid)"
    $sd = [IntPtr]::Zero; $size = 0
    if (-not [GorouterPipeAcl]::ConvertStringSecurityDescriptorToSecurityDescriptor($sddl, 1, [ref]$sd, [ref]$size)) { throw 'SDDL convert failed' }
    try {
      $present = $false; $dacl = [IntPtr]::Zero; $defaulted = $false
      if (-not [GorouterPipeAcl]::GetSecurityDescriptorDacl($sd, [ref]$present, [ref]$dacl, [ref]$defaulted)) { throw 'DACL extract failed' }
      $rc = [GorouterPipeAcl]::SetSecurityInfo($h, 6, 0x4, [IntPtr]::Zero, [IntPtr]::Zero, $dacl, [IntPtr]::Zero)
      if ($rc -ne 0) { throw "SetSecurityInfo failed rc=$rc" }
    } finally {
      if ($sd -ne [IntPtr]::Zero) { [GorouterPipeAcl]::LocalFree($sd) | Out-Null }
    }
  }
  $owner = [IntPtr]::Zero; $group = [IntPtr]::Zero; $dacl = [IntPtr]::Zero; $sacl = [IntPtr]::Zero; $psd = [IntPtr]::Zero
  $rc2 = [GorouterPipeAcl]::GetSecurityInfo($h, 6, 0x7, [ref]$owner, [ref]$group, [ref]$dacl, [ref]$sacl, [ref]$psd)
  if ($rc2 -ne 0) { throw "GetSecurityInfo failed rc=$rc2" }
  try {
    $sddlOut = [IntPtr]::Zero; $len = 0
    if (-not [GorouterPipeAcl]::ConvertSecurityDescriptorToStringSecurityDescriptorW($psd, 1, 0x7, [ref]$sddlOut, [ref]$len)) { throw 'SDDL readback failed' }
    try { [Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringUni($sddlOut)) }
    finally { [GorouterPipeAcl]::LocalFree($sddlOut) | Out-Null }
  } finally {
    if ($psd -ne [IntPtr]::Zero) { [GorouterPipeAcl]::LocalFree($psd) | Out-Null }
  }
} finally {
  [GorouterPipeAcl]::CloseHandle($h) | Out-Null
}
`

/** Windows PowerShell 5.1 absolute path (restricted-PATH supervisors). */
function powershellPath(): string {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows'
  const candidate = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return existsSync(candidate) ? candidate : 'powershell.exe'
}

function runPipeAcl(mode: 'harden' | 'inspect', pipeName: string): { ok: boolean; sddl: string | null; error: string | null } {
  const script = PIPE_ACL_PS.replace('__MODE__', mode).replace('__PIPE__', pipeName.replace(/'/g, "''"))
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  const r = spawnSync(
    powershellPath(),
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, windowsHide: true, timeout: 30_000 },
  )
  const stdout = (r.stdout ?? '').trim()
  const stderr = (r.stderr ?? '').trim()
  if (r.status !== 0 || r.error !== undefined) {
    return { ok: false, sddl: null, error: stderr || (r.error ? r.error.message : `exit ${String(r.status)}`) }
  }
  return { ok: true, sddl: stdout.length > 0 ? stdout : null, error: null }
}

/**
 * Replace the pipe DACL with SYSTEM + Administrators + current user.
 * Non-fatal: token auth remains the primary boundary; the stricter DACL is
 * defense in depth. Returns the resulting SDDL for verification.
 */
export function hardenPipeDacl(pipeName: string): { ok: boolean; sddl: string | null; error: string | null } {
  return runPipeAcl('harden', pipeName)
}

/** Read back the current pipe DACL (verification/evidence). */
export function inspectPipeDacl(pipeName: string): { ok: boolean; sddl: string | null; error: string | null } {
  return runPipeAcl('inspect', pipeName)
}
