# GoRouter V1.5 — desktop evidence capture orchestrator (slice E).
#
# Captures UX + integration evidence into docs/evidence/v1.5/ (gitignored):
#   1. shell selftest: renders every UX state offscreen and writes a PNG +
#      accessible-name/keyboard-order dump per state (GoRouterDesktop.exe
#      --selftest <outDir> --state <name>, one invocation per state:
#      empty, configured, degraded, stopped, error, confirm, firstrun)
#   2. mini coherence scenario: REAL control service (dev mode) + REAL CLI
#      against a temp state dir, capturing CLI outputs, GUI snapshots before/
#      after a CLI route switch, and journal.recent rows
#   3. summary.txt: SHA-256 of every artifact
#
# Idempotent (the v1.5 out dir is rebuilt each run) and leaves no processes
# behind: the scenario service tree is killed in the finally block.
#
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/desktop-evidence.ps1
#        [-ShellExe <path>]   explicit shell binary override (default dist\GoRouterDesktop.exe)
param(
    [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
    [string]$OutDir = (Join-Path $RepoRoot "docs\evidence\v1.5"),
    [string]$ShellExe = ""
)

$ErrorActionPreference = "Stop"
$servicePid = $null
$scenario = $null
$states = @("empty", "configured", "degraded", "stopped", "error", "confirm", "firstrun")

function Write-Step([string]$msg) {
    Write-Host "[evidence] $msg" -ForegroundColor Cyan
}

# Start a process and wait up to $TimeoutSec; kill on timeout (a broken
# apphost may show a GUI error dialog that would block an unbounded wait).
function Start-And-Wait {
    param([string]$FilePath, [string[]]$ArgumentList, [int]$TimeoutSec = 90)
    $p = Start-Process -FilePath $FilePath -ArgumentList $ArgumentList -PassThru
    if (-not $p.WaitForExit($TimeoutSec * 1000)) {
        try { $p.Kill() } catch { }
        throw "process timed out after ${TimeoutSec}s: $FilePath $($ArgumentList -join ' ')"
    }
    return $p
}

# SHA-256 of a file via .NET (the Get-FileHash cmdlet is absent on some
# minimal PowerShell 5.1 installs; this recipe is always available).
function Get-Sha256 {
    param([string]$Path)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $fs = [System.IO.File]::OpenRead($Path)
        try {
            return ([System.BitConverter]::ToString($sha.ComputeHash($fs))).Replace("-", "")
        } finally {
            $fs.Dispose()
        }
    } finally {
        $sha.Dispose()
    }
}

function Resolve-ShellExe {
    param([string]$Wanted)
    $dist = Join-Path $RepoRoot "dist\GoRouterDesktop.exe"
    if (-not $Wanted) {
        if (-not (Test-Path $dist)) {
            $build = Join-Path $RepoRoot "scripts\build-desktop.ps1"
            if (Test-Path $build) {
                Write-Step "GoRouterDesktop.exe missing - building via $build"
                & $build
                if ($LASTEXITCODE -ne 0) { throw "build-desktop.ps1 failed with exit $LASTEXITCODE" }
            }
        }
        if (Test-Path $dist) { $Wanted = $dist }
    }
    if ($Wanted -and (Test-Path $Wanted)) {
        # Probe: the artifact must actually launch (a broken publish exits
        # nonzero or hangs on a GUI error dialog before the selftest logic).
        $probeDir = Join-Path $env:TEMP "gorouter-selftest-probe"
        if (Test-Path $probeDir) { Remove-Item -Recurse -Force $probeDir }
        New-Item -ItemType Directory -Force -Path $probeDir | Out-Null
        $probeOk = $false
        try {
            $probe = Start-And-Wait -FilePath $Wanted -ArgumentList @("--selftest", "`"$probeDir`"", "--state", "empty") -TimeoutSec 60
            $probeOk = ($probe.ExitCode -eq 0)
        } catch {
            $probeOk = $false
        }
        if ($probeOk) { return $Wanted }
        Write-Step "shell exe failed the launch probe - falling back to dotnet publish"
    }
    # Fallback: publish the shell self-contained directly (works without a
    # preinstalled desktop runtime and when the dist artifact is broken).
    $fallbackDir = Join-Path $env:TEMP "gorouter-shell-fallback"
    if (Test-Path $fallbackDir) { Remove-Item -Recurse -Force $fallbackDir }
    New-Item -ItemType Directory -Force -Path $fallbackDir | Out-Null
    Write-Step "dotnet publish (self-contained) -> $fallbackDir"
    $proj = Join-Path $RepoRoot "src\desktop\shell\GoRouterDesktop.csproj"
    dotnet publish $proj -c Release -r win-x64 --self-contained true -o $fallbackDir | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "dotnet publish fallback failed with exit $LASTEXITCODE" }
    $fallbackExe = Join-Path $fallbackDir "GoRouterDesktop.exe"
    if (-not (Test-Path $fallbackExe)) { throw "fallback publish produced no GoRouterDesktop.exe" }
    $probe2 = Start-And-Wait -FilePath $fallbackExe -ArgumentList @("--selftest", "`"$probeDir`"", "--state", "empty") -TimeoutSec 60
    if ($probe2.ExitCode -ne 0) { throw "fallback shell exe failed the launch probe (exit $($probe2.ExitCode))" }
    return $fallbackExe
}

try {
    # --- out dir: fresh capture each run (idempotent) -----------------------
    if (Test-Path $OutDir) { Remove-Item -Recurse -Force $OutDir }
    New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
    $selftestDir = Join-Path $OutDir "selftest"
    New-Item -ItemType Directory -Force -Path $selftestDir | Out-Null

    # --- 1. shell selftest: one invocation per UX state ---------------------
    $shellExe = Resolve-ShellExe $ShellExe
    Write-Step "shell selftest ($($states.Count) states) -> $selftestDir"
    foreach ($state in $states) {
        $p = Start-And-Wait -FilePath $shellExe -ArgumentList @("--selftest", "`"$selftestDir`"", "--state", $state) -TimeoutSec 90
        if ($p.ExitCode -ne 0) {
            throw "shell selftest state '$state' exited with $($p.ExitCode)"
        }
    }
    $selftestFiles = @(Get-ChildItem -Recurse -File $selftestDir)
    $pngCount = @($selftestFiles | Where-Object { $_.Extension -eq ".png" }).Count
    $txtCount = @($selftestFiles | Where-Object { $_.Extension -eq ".txt" }).Count
    if ($pngCount -lt $states.Count -or $txtCount -lt $states.Count) {
        throw "shell selftest produced incomplete evidence (png=$pngCount txt=$txtCount, expected $($states.Count) each) in $selftestDir"
    }
    # Each UX state must render distinct pixels: identical PNGs across states
    # indicate a capture race (stale evidence), not a genuine render.
    $pngHashes = @{}
    foreach ($png in @($selftestFiles | Where-Object { $_.Extension -eq ".png" })) {
        $h = Get-Sha256 $png.FullName
        if ($pngHashes.ContainsKey($h)) {
            throw "selftest PNG collision: '$($png.Name)' is byte-identical to '$($pngHashes[$h])' - stale capture; refusing to record evidence"
        }
        $pngHashes[$h] = $png.Name
    }
    Write-Step "selftest artifacts: $($selftestFiles.Count) files (png=$pngCount txt=$txtCount), all PNGs pairwise distinct"

    # --- 2. mini coherence scenario (REAL service + CLI, temp state) ---------
    $scenarioOut = Join-Path $OutDir "scenario.json"
    $scenarioLog = Join-Path $OutDir "scenario.log"
    $bun = (Get-Command bun).Source
    Write-Step "running coherence scenario (service only)"
    & $bun (Join-Path $RepoRoot "scripts\desktop-evidence-scenario.ts") --out $scenarioOut *> $scenarioLog
    if ($LASTEXITCODE -ne 0) {
        throw "coherence scenario failed with exit $LASTEXITCODE (see $scenarioLog)"
    }
    try {
        $scenario = Get-Content -Raw $scenarioOut | ConvertFrom-Json
        if ($scenario.PSObject.Properties.Name -contains "servicePid" -and $scenario.servicePid) {
            $servicePid = [int]$scenario.servicePid
        }
    } catch {
        throw "scenario.json unreadable: $($_.Exception.Message)"
    }
    Write-Step "scenario ok: routes go=$($scenario.snapshotAfter.routes.go.alias) zen=$($scenario.snapshotAfter.routes.zen.alias)"

    # --- 3. summary.txt with SHA-256 of every artifact -----------------------
    $summary = Join-Path $OutDir "summary.txt"
    $lines = New-Object System.Collections.Generic.List[string]
    $lines.Add("GoRouter V1.5 desktop evidence")
    $lines.Add("generated: $(Get-Date -Format o)")
    if ($scenario) { $lines.Add("scenario: $($scenario.scenario)") }
    $lines.Add("")
    # Evidence must bind to the exact binaries that produced it: record the
    # SHA-256 of every dist executable (shell, control service, router).
    $exeArtifacts = @(
        (Join-Path $RepoRoot "dist\GoRouterDesktop.exe"),
        (Join-Path $RepoRoot "dist\gorouter-control.exe"),
        (Join-Path $RepoRoot "dist\gorouter-router.exe")
    )
    foreach ($exe in $exeArtifacts) {
        if (Test-Path $exe) {
            $lines.Add("EXE-SHA256 $(Get-Sha256 -Path $exe) $([System.IO.Path]::GetFileName($exe))")
        }
    }
    $lines.Add("")
    $artifacts = @()
    $artifacts += @($selftestFiles | ForEach-Object { $_.FullName })
    $artifacts += @($scenarioOut, $scenarioLog)
    foreach ($f in ($artifacts | Sort-Object)) {
        $hash = Get-Sha256 -Path $f
        $rel = $f.Substring($OutDir.Length + 1).Replace("\", "/")
        $lines.Add("SHA256 $hash  $rel")
    }
    $lines | Set-Content -Path $summary -Encoding ASCII
    Write-Step "done -> $OutDir (summary.txt, $($lines.Count - 2) artifact hashes)"
}
finally {
    # --- leave no processes behind: kill the scenario service tree ----------
    if ($servicePid) {
        Write-Step "cleanup: terminating scenario service tree (pid $servicePid)"
        try { & taskkill /PID $servicePid /T /F 2>$null | Out-Null } catch { }
    }
}
