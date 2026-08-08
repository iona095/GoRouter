# Builds the WinForms shell and launches it in dev mode:
#   - GOROUTER_DESKTOP_DEV=1 makes the shell spawn the control service as
#     `bun src/desktop/control-service.ts` with cwd = repository root
#     (found by walking up from the exe directory for package.json).
#   - GOROUTER_STATE_DIR is passed through unchanged (defaults inside the app).
# Build output goes to dist/dev (shallow, so the repo-root walk stays ≤ 6 levels).
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$proj = Join-Path $root 'src\desktop\shell\GoRouterDesktop.csproj'
$outDir = Join-Path $root 'dist\dev'

dotnet build $proj -c Release -o $outDir
if ($LASTEXITCODE -ne 0) { throw 'dotnet build failed.' }

$exe = Join-Path $outDir 'GoRouterDesktop.exe'
if (-not (Test-Path $exe)) { throw "Shell executable not found at $exe" }

$env:GOROUTER_DESKTOP_DEV = '1'
& $exe @args
exit $LASTEXITCODE
