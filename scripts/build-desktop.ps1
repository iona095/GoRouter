# Builds the GoRouter V1.5 desktop distribution into dist/:
#   GoRouterDesktop.exe   - WinForms shell (self-contained single-file; framework-dependent fallback)
#   gorouter-control.exe  - control service (compiled Bun)
#   gorouter-router.exe   - router (compiled Bun CLI, unchanged V1 data plane)
# Prints the dist listing when done.
#
# F-16 atomicity: the release is staged in dist.new/, verified there (final
# manifest assertion), then swapped over dist/ — a failed build never leaves
# a half-written dist behind, and stale files from older builds cannot
# linger (only the release set plus the preserved dev/ scratch dir survive
# the swap).
# GR-009: publish + smoke-test intermediates live in .build-work/ (NOT in
# the stage tree), so evidence and duplicate exes can never be swept into
# the release. .build-work/ is removed on success and on failure.
# dist/dev (desktop-dev.ps1 scratch) is preserved across the swap.
# Symlink rule: cleanup removes reparse points as LINKS (never recursed
# into), so a symlinked dir inside a build tree can never cause deletion
# outside that tree. Never replace Remove-BuildTree with a bare
# Remove-Item -Recurse on these paths.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $root 'dist'
$stage = Join-Path $root 'dist.new'
$backup = Join-Path $root 'dist.bak'
$workDir = Join-Path $root '.build-work'

function Remove-BuildTree {
    param([string]$Path)
    if (-not (Test-Path $Path)) { return }
    # Materialize the listing first: deleting while the provider enumerates
    # breaks the enumeration. The recursive call removes the subdir itself,
    # so the parent must not remove it again (double-delete aborts the build).
    foreach ($child in @(Get-ChildItem -Force -LiteralPath $Path)) {
        if ($child.LinkType) {
            $child.Delete()  # reparse point: remove the link itself, never the target
        } elseif ($child.PSIsContainer) {
            Remove-BuildTree $child.FullName  # removes contents AND the dir
        } else {
            Remove-Item -Force -LiteralPath $child.FullName
        }
    }
    Remove-Item -Force -LiteralPath $Path
}

# Release manifest: exactly these files, non-empty; the only tolerated
# subdirectory is the preserved dev/ scratch dir (moved in at swap time).
function Assert-ReleaseManifest {
    param([string]$Stage)
    $expected = @('GoRouterDesktop.exe', 'gorouter-control.exe', 'gorouter-router.exe')
    $files = @(Get-ChildItem -File -LiteralPath $Stage | Select-Object -ExpandProperty Name | Sort-Object)
    $dirs = @(Get-ChildItem -Directory -LiteralPath $Stage | Select-Object -ExpandProperty Name)
    $missing = @($expected | Where-Object { $_ -notin $files })
    $extraFiles = @($files | Where-Object { $_ -notin $expected })
    $extraDirs = @($dirs | Where-Object { $_ -ne 'dev' })
    if ($missing.Count -gt 0 -or $extraFiles.Count -gt 0 -or $extraDirs.Count -gt 0) {
        throw "dist manifest mismatch: missing=[$($missing -join ',')] extra-files=[$($extraFiles -join ',')] extra-dirs=[$($extraDirs -join ',')]"
    }
    foreach ($f in $expected) {
        if ((Get-Item -LiteralPath (Join-Path $Stage $f)).Length -eq 0) { throw "dist artifact $f is empty" }
    }
}

# Fresh stage and work dirs (leftovers from a killed build pollute nothing).
Remove-BuildTree $stage
New-Item -ItemType Directory -Path $stage | Out-Null
Remove-BuildTree $workDir
New-Item -ItemType Directory -Path $workDir | Out-Null
$publishDir = Join-Path $workDir 'publish'
$evidenceDir = Join-Path $workDir 'selftest-evidence'

try {
    # 1) Shell: prefer a self-contained single-file publish; fall back to
    #    framework-dependent (requires the .NET 9 Desktop Runtime) with a warning.
    $proj = Join-Path $root 'src\desktop\shell\GoRouterDesktop.csproj'

    # Clean the shell's build intermediates: incremental publish state can leave a
    # stale framework-dependent apphost in obj/ that yields a broken single-file
    # exe ("No frameworks were found") on a later self-contained publish.
    dotnet clean $proj -c Release -v q 2>&1 | Out-Null
    Remove-Item -Recurse -Force (Join-Path $root 'src\desktop\shell\bin') -ErrorAction SilentlyContinue
    Remove-Item -Recurse -Force (Join-Path $root 'src\desktop\shell\obj') -ErrorAction SilentlyContinue

    dotnet publish $proj -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -o $publishDir
    if ($LASTEXITCODE -ne 0) {
        Write-Warning 'Self-contained publish failed; falling back to framework-dependent publish (requires the .NET 9 Desktop Runtime).'
        dotnet publish $proj -c Release -r win-x64 --self-contained false -p:PublishSingleFile=true -o $publishDir
        if ($LASTEXITCODE -ne 0) { throw 'dotnet publish failed (both self-contained and framework-dependent).' }
    }
    Copy-Item (Join-Path $publishDir 'GoRouterDesktop.exe') (Join-Path $stage 'GoRouterDesktop.exe') -Force

    # Launch smoke test on the published shell: catches a broken apphost/bundle
    # (e.g. self-contained exe without an embedded runtime) before it ships.
    # Evidence lands OUTSIDE the stage tree so it can never be swept into dist/.
    & (Join-Path $stage 'GoRouterDesktop.exe') --selftest $evidenceDir --state empty 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Published GoRouterDesktop.exe failed its launch smoke test.' }

    # 2) Control service (compiled Bun executable).
    bun build --compile (Join-Path $root 'src\desktop\control-service.ts') --outfile (Join-Path $stage 'gorouter-control.exe') --target=bun-windows-x64
    if ($LASTEXITCODE -ne 0) { throw 'bun build (control service) failed.' }

    # 3) Router (compiled CLI).
    bun build --compile (Join-Path $root 'src\cli.ts') --outfile (Join-Path $stage 'gorouter-router.exe') --target=bun-windows-x64
    if ($LASTEXITCODE -ne 0) { throw 'bun build (router) failed.' }

    # 4) Final manifest assertion BEFORE the swap: exactly the release set,
    #    non-empty, no publish/ or evidence strays.
    Assert-ReleaseManifest $stage

    # 5) Atomic swap: preserve the dev scratch dir, retire the old dist.
    if (Test-Path (Join-Path $dist 'dev')) {
        if (Test-Path (Join-Path $stage 'dev')) { Remove-BuildTree (Join-Path $stage 'dev') }
        Move-Item -LiteralPath (Join-Path $dist 'dev') -Destination (Join-Path $stage 'dev')
    }
    if (Test-Path $dist) {
        if (Test-Path $backup) { Remove-BuildTree $backup }
        Move-Item -LiteralPath $dist -Destination $backup
    }
    Move-Item -LiteralPath $stage -Destination $dist
    if (Test-Path $backup) { Remove-BuildTree $backup }
}
finally {
    Remove-BuildTree $workDir
}

Write-Host ''
Write-Host 'dist/ contents:'
Get-ChildItem $dist | Sort-Object Name | Format-Table Name, Length -AutoSize
