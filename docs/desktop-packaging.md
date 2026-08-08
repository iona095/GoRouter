# GoRouter V1.5 Desktop — Packaging

Governing contract: `gorouter-v1.5-desktop-long-horizon-r3` (§14 Windows
distribution outcome). Companion documents: `docs/desktop-architecture.md`
(process topology, supervision, settings) and `docs/desktop-security.md`
(attack-surface analysis).

## Toolchain (pinned)

| Tool | Version | Used for |
| --- | --- | --- |
| Bun | 1.3.14 | `bun build --compile` executables (control service, router) |
| .NET SDK | 9.0.312 | WinForms shell publish (`net9.0-windows`) |
| PowerShell | 5.1 (Windows PowerShell, ships with Windows) | `scripts/build-desktop.ps1`, `scripts/desktop-dev.ps1` |
| Windows | 10/11 x64 | supported host |

The Bun version matters for reproducibility: `bun build --compile` embeds
the Bun runtime in the output executable, so the same source built with a
different Bun version produces a different binary. The .NET SDK version is
pinned for the same reason. The build is offline apart from the .NET
package restore; no runtime state or credentials ever enter the build.

> Build and launch results are verified in the pre-commit evidence — see
> `handoffs/v1.5-precommit-handoff.md`.

## Build procedure

From the repository root:

```powershell
bun install
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-desktop.ps1
```

`scripts/build-desktop.ps1` produces `dist/` with three artifacts:

1. **Shell** — self-contained single-file publish of the WinForms shell:

   ```powershell
   dotnet publish src/desktop/shell -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -o dist/
   ```

   (If single-file/self-contained publish is unavailable on a given host,
   the framework-dependent fallback is documented in the script: publish
   with `--self-contained false` and require the .NET 9 Desktop Runtime on
   the target machine.)

2. **Control service** — compiled Bun executable:

   ```powershell
   bun build --compile src/desktop/control-service.ts --target=bun-windows-x64 --outfile dist/gorouter-control.exe
   ```

3. **Router** — compiled V1 router (compiled `src/cli.ts`, unchanged data
   plane):

   ```powershell
   bun build --compile src/cli.ts --target=bun-windows-x64 --outfile dist/gorouter-router.exe
   ```

The dev flow (`scripts/desktop-dev.ps1`) does not compile: it builds the
shell in Debug, starts the service as `bun src/desktop/control-service.ts`
and launches the tray app against the repo sources.

## dist/ layout

| File | Produced by | Role |
| --- | --- | --- |
| `GoRouterDesktop.exe` | `dotnet publish` (self-contained, single-file) | WinForms shell: tray + control center |
| `gorouter-control.exe` | `bun build --compile` | Control service (pipe server, supervision) |
| `gorouter-router.exe` | `bun build --compile src/cli.ts` | Compiled V1 router (data plane) |

Binary resolution at runtime:

- Shell → service: dev mode spawns `bun src/desktop/control-service.ts`
  (cwd = repo root); packaged mode spawns `<exeDir>/gorouter-control.exe`.
- Service → router: if the service's own executable basename is
  `gorouter-control.exe`, it spawns `[<exeDir>/gorouter-router.exe,
  "serve"]`; otherwise `["bun", "src/cli.ts", "serve"]` with cwd = repo
  root. `GOROUTER_DESKTOP_ROUTER_CMD_JSON` (JSON array of argv) overrides
  either; `GOROUTER_DESKTOP_PIPE` overrides the pipe path; the router child
  inherits `GOROUTER_STATE_DIR` and `GOROUTER_LOG_LEVEL`.
- No other files are required; the three executables are the whole product.

## Install

1. Build (above) or take a built `dist/` folder.
2. Copy the `dist/` folder anywhere per-user — for example
   `%LOCALAPPDATA%\Programs\GoRouter` or a plain user folder. No installer,
   no machine-wide changes.
3. Run `GoRouterDesktop.exe`. First launch creates (or adopts existing V1)
   runtime state on demand; onboarding leads through adding the first
   account and selecting lanes.
4. Optional: enable **start at login** inside the app (per-user HKCU Run
   value `GoRouterDesktop`; reversible from the same toggle; no
   Administrator rights).

No Administrator rights are required to build, install or run the desktop
app. Runtime state is never written into the app folder.

## Uninstall / rollback

1. Exit the app (tray → Exit). This stops the router only if the desktop
   manages it; an externally started router is left running by design.
2. Turn off start-at-login in the app (removes the `GoRouterDesktop` HKCU
   Run value).
3. Delete the dist folder.
4. Optionally remove runtime state: `bun src/cli.ts reset --yes`, then
   delete `%LOCALAPPDATA%\GoRouter` (or the `GOROUTER_STATE_DIR` directory).

Rollback to V1 CLI-only operation is complete after step 3: the CLI is
untouched by the desktop install, the state directory remains valid for
the CLI, and nothing in the repository or HKCU (beyond the toggled Run
value) was modified.

## Runtime state boundary

All runtime state lives under `%LOCALAPPDATA%\GoRouter` (or
`GOROUTER_STATE_DIR`):

```text
<state>/
  state.json        # accounts, routes, settings (no secrets)
  secrets/          # DPAPI blobs: account keys, local credential, admin token (sec_desktop_admin.bin)
  journal.db        # SQLite request journal (+ -wal/-shm)
  desktop.json      # desktop settings (schemaVersion 1)
  .state.lock       # cross-process mutation lock (transient)
```

- Nothing in the repository is written at runtime.
- `dist/` contains no credentials, no operator state, no journal.
- Local evidence artifacts (`docs/evidence/`) are gitignored and excluded
  from the candidate tree.
- `state.json` contains only opaque secret references; real credentials
  exist only as per-user DPAPI blobs in the state directory.

## What is deliberately not included

- **No auto-update.** V1.5 has no update service, no update check, no
  telemetry/analytics and no cloud dependency (contract §3.2/§11).
- **No code signing.** Explicitly not required by contract §14; the
  executables are unsigned. Users installing with SmartScreen may need to
  choose "More info → Run anyway"; the build procedure is fully documented
  for anyone who wants to rebuild from source.
- **No installer.** Distribution is a copy-the-folder model; the only
  per-user registration is the optional start-at-login HKCU Run value,
  managed by the app itself.

## Third-party notices

The product bundles no third-party binaries beyond the compiled runtimes:

- **Bun** (MIT license) — the Bun runtime is embedded in
  `gorouter-control.exe` and `gorouter-router.exe` by
  `bun build --compile` (Bun 1.3.14).
- **.NET 9** (MIT license) — the self-contained publish embeds the .NET
  runtime, including **WinForms** (a framework component), in
  `GoRouterDesktop.exe`.
- **No external NuGet packages.** DPAPI is used via P/Invoke against the
  OS (`CryptProtectData`/`CryptUnprotectData`); everything else is
  framework. The TypeScript side uses only Bun's built-in modules
  (`node:net`, `node:fs`, `bun:sqlite`, …).
- License texts for the embedded runtimes are available from the Bun and
  .NET distributions; no additional attribution file is required for this
  distribution model.
