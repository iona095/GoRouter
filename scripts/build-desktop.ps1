# Builds the GoRouter V1.5 desktop distribution into dist/:
#   GoRouterDesktop.exe   - WinForms shell (self-contained single-file; framework-dependent fallback)
#   gorouter-control.exe  - control service (compiled Bun)
#   gorouter-router.exe   - router (compiled Bun CLI, unchanged V1 data plane)
# Prints the dist listing when done.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $root 'dist'
$publishDir = Join-Path $dist 'publish'
New-Item -ItemType Directory -Force -Path $dist | Out-Null
if (Test-Path $publishDir) { Remove-Item -Recurse -Force $publishDir }

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
Copy-Item (Join-Path $publishDir 'GoRouterDesktop.exe') (Join-Path $dist 'GoRouterDesktop.exe') -Force

# Launch smoke test on the published shell: catches a broken apphost/bundle
# (e.g. self-contained exe without an embedded runtime) before it ships.
& (Join-Path $dist 'GoRouterDesktop.exe') --selftest (Join-Path $dist 'selftest-evidence') --state empty 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Published GoRouterDesktop.exe failed its launch smoke test.' }

# 2) Control service (compiled Bun executable).
bun build --compile (Join-Path $root 'src\desktop\control-service.ts') --outfile (Join-Path $dist 'gorouter-control.exe') --target=bun-windows-x64
if ($LASTEXITCODE -ne 0) { throw 'bun build (control service) failed.' }

# 3) Router (compiled CLI).
bun build --compile (Join-Path $root 'src\cli.ts') --outfile (Join-Path $dist 'gorouter-router.exe') --target=bun-windows-x64
if ($LASTEXITCODE -ne 0) { throw 'bun build (router) failed.' }

Write-Host ''
Write-Host 'dist/ contents:'
Get-ChildItem $dist | Sort-Object Name | Format-Table Name, Length -AutoSize
