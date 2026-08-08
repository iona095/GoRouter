# GoRouter Desktop shell (WinForms)

Code-first .NET 9 WinForms shell for GoRouter V1.5 Desktop. No designer files,
no external NuGet packages (DPAPI via P/Invoke `CryptUnprotectData`).

## Layout

| File | Purpose |
| --- | --- |
| `GoRouterDesktop.csproj` | net9.0-windows, WinForms, win-x64, app.manifest (PerMonitorV2 DPI) |
| `Program.cs` | STA entry, single instance, DPI, control-service spawn/attach, app wiring |
| `Dpapi.cs` | Read-only DPAPI interop (admin token blob) |
| `StateResolver.cs` | State dir (mirrors `src/paths.ts`), user SID, pipe/mutex names |
| `ControlClient.cs` | Named-pipe JSON-lines client: request/response by id, snapshot events, 1s/2s/4s reconnect |
| `ShellSnapshot.cs` | Immutable snapshot/journal/probe models (protocol-exact) |
| `TrayIcon.cs` | NotifyIcon, runtime-generated state icon, lane submenus, exit |
| `ControlCenterForm.cs` | Status bar, GO/ZEN lanes, Accounts, Journal, System tabs |
| `FirstRunFlow.cs` | 5-step onboarding (local credential once, first account, lanes, OMP note) |
| `StartupManager.cs` | HKCU `...\CurrentVersion\Run` value `GoRouterDesktop` |
| `Selftest.cs` | Test-only `--selftest` evidence driver |
| `AddAccountDialog.cs`, `UpdateCredentialDialog.cs`, `RenameDialog.cs`, `RemoveAccountDialog.cs`, `TestProgressDialog.cs`, `ConfirmDialog.cs` | Dialogs |

## Build

```powershell
dotnet build src/desktop/shell/GoRouterDesktop.csproj -c Release
```

Full distribution (shell + compiled service + compiled router) into `dist/`:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-desktop.ps1
```

## Run (dev)

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/desktop-dev.ps1
```

This builds the shell to `dist/dev` and launches it with
`GOROUTER_DESKTOP_DEV=1`: the shell spawns
`bun src/desktop/control-service.ts` (cwd = repo root). Override the state
dir with `GOROUTER_STATE_DIR` as usual.

## Selftest (UX evidence, test-only)

Renders the control center (or a dialog / onboarding step) offscreen with an
injected snapshot and writes `<state>.png` + `<state>.a11y.txt` (accessibility
names, roles, tab order, control types) to the output directory:

```powershell
GoRouterDesktop.exe --selftest <outDir> --state empty
GoRouterDesktop.exe --selftest <outDir> --state configured
# states: empty|configured|degraded|stopped|error|confirm|firstrun
GoRouterDesktop.exe --selftest <outDir> --snapshot <snapshot.json>   # custom snapshot
```

Exit code 0 on success. Never connects to a real control service.

## Security notes

- The shell only reads the admin token blob (`<state>/secrets/sec_desktop_admin.bin`).
- Provider secrets are entered in masked textboxes and cleared on dialog close.
- No logging; no request parameters are ever written.
- Diagnostics copy is built from snapshot fields only — never secrets.
