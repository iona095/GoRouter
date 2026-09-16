# Builds the Wire Inspector companion diagnostic executable:
#   gorouter-wire-inspector.exe  (synthetic diagnostics only; Bun-compiled)
#
# Boundary: this script never touches src/ (production runtime), never
# rebuilds dist/gorouter.exe, and never publishes anything. The candidate is
# staged in a controlled scratch directory; promotion into dist/ (if any) is
# a separate explicitly authorized step, never part of this build.
# Historical Wire Inspector output/ directories are never build inputs: the
# stage tree receives exactly one file (the compiled exe).
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$stage = Join-Path $root '.build-work-wire-inspector'
$entry = Join-Path $root 'tools\wire-inspector\src\cli.ts'
$exeName = 'gorouter-wire-inspector.exe'

function Remove-BuildTree {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return }
    foreach ($child in @(Get-ChildItem -Force -LiteralPath $Path)) {
        if ($child.LinkType) {
            $child.Delete()
        } elseif ($child.PSIsContainer) {
            Remove-BuildTree $child.FullName
        } else {
            Remove-Item -Force -LiteralPath $child.FullName
        }
    }
    Remove-Item -Force -LiteralPath $Path
}

function Get-PeInfo {
    param([string]$Path)
    $fs = [System.IO.File]::OpenRead($Path)
    try {
        $br = New-Object System.IO.BinaryReader($fs)
        $mz = [System.Text.Encoding]::ASCII.GetString($br.ReadBytes(2))
        if ($mz -ne 'MZ') { throw "not a PE image: $Path" }
        $fs.Seek(0x3C, [System.IO.SeekOrigin]::Begin) | Out-Null
        $peOff = $br.ReadInt32()
        $fs.Seek($peOff, [System.IO.SeekOrigin]::Begin) | Out-Null
        $sig = [System.Text.Encoding]::ASCII.GetString($br.ReadBytes(4))
        if ($sig -ne ("P" + "E" + [char]0 + [char]0)) { throw "bad PE signature: $Path" }
        $machine = $br.ReadUInt16()
        $nSections = $br.ReadUInt16()
        # Remainder of COFF header after Machine+Sections: 16 bytes, then
        # optional-header magic (2 bytes) and Subsystem at optional offset 68.
        $fs.Seek(16, [System.IO.SeekOrigin]::Current) | Out-Null
        $optMagic = $br.ReadUInt16()
        $fs.Seek(66, [System.IO.SeekOrigin]::Current) | Out-Null
        $subsystem = [int]$br.ReadUInt16()
        $subName = @{ 2 = 'GUI'; 3 = 'console' }[$subsystem]
        if (-not $subName) { $subName = "other($subsystem)" }
        return @{ Machine = ('0x{0:X4}' -f $machine); Sections = $nSections; OptMagic = ('0x{0:X4}' -f $optMagic); Subsystem = $subName }
    } finally {
        $fs.Close()
    }
}

if (-not (Test-Path -LiteralPath $entry)) { throw "entrypoint missing: $entry" }
$bunVersion = (bun --version) 2>&1
if ($LASTEXITCODE -ne 0) { throw 'bun is required to build the companion executable.' }

Remove-BuildTree $stage
New-Item -ItemType Directory -Path $stage | Out-Null

$outExe = Join-Path $stage $exeName
$buildCmd = "bun build --compile tools/wire-inspector/src/cli.ts --outfile $exeName --target=bun-windows-x64"
Write-Host "build: $buildCmd"
Push-Location $root
try {
    bun build --compile tools/wire-inspector/src/cli.ts --outfile (Join-Path $stage $exeName) --target=bun-windows-x64
    if ($LASTEXITCODE -ne 0) { throw 'bun build (wire-inspector) failed.' }
} finally {
    Pop-Location
}

$files = @(Get-ChildItem -File -LiteralPath $stage | Select-Object -ExpandProperty Name | Sort-Object)
if ($files.Count -ne 1 -or $files[0] -ne $exeName) { throw "stage manifest mismatch: [$($files -join ',')]" }
$item = Get-Item -LiteralPath $outExe
if ($item.Length -eq 0) { throw 'candidate executable is empty.' }
$sha = [System.Security.Cryptography.SHA256]::Create()
$fs2 = [System.IO.File]::OpenRead($outExe)
try {
    $hashBytes = $sha.ComputeHash($fs2)
} finally {
    $fs2.Close()
    $sha.Dispose()
}
$hash = ([System.BitConverter]::ToString($hashBytes) -replace '-', '').ToLowerInvariant()
$pe = Get-PeInfo -Path $outExe
$toolInputs = @(Get-ChildItem -Recurse -File (Join-Path $root 'tools\wire-inspector\src'), (Join-Path $root 'tools\wire-inspector\tests') | Select-Object -ExpandProperty FullName | Sort-Object)
$mainInputs = @(Select-String -Path (Join-Path $root 'tools\wire-inspector\src\*.ts') -Pattern '\.\./\.\./\.\./src/([A-Za-z0-9_./-]+)' | Select-Object -ExpandProperty Matches | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique)

Write-Host ''
Write-Host 'wire-inspector build record:'
Write-Host "  bun version:      $bunVersion"
Write-Host "  build command:    $buildCmd"
Write-Host "  entrypoint:       tools/wire-inspector/src/cli.ts"
Write-Host "  tool src inputs:  $($toolInputs.Count) files under tools/wire-inspector/src|tests"
Write-Host "  Main src inputs followed by imports: $($mainInputs -join ', ')"
Write-Host '  third-party dependency inputs: none (bun builtins + repository source only)'
Write-Host "  candidate:        $outExe"
Write-Host "  output SHA256:    $hash"
Write-Host "  output size:      $($item.Length)"
Write-Host "  PE machine:       $($pe.Machine) (0x8664 = x64)"
Write-Host "  PE opt magic:     $($pe.OptMagic) (0x020B = PE32+)"
Write-Host "  PE subsystem:     $($pe.Subsystem) (console expected)"
Write-Host '  historical output in closure: none (stage holds exactly the exe)'
