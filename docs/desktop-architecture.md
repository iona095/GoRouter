# GoRouter V1.5 Desktop — Architecture

Governing contract: `gorouter-v1.5-desktop-long-horizon-r3`. Companion
documents: `docs/desktop-packaging.md` (build, install, uninstall,
third-party notices) and `docs/desktop-security.md` (attack-surface
analysis against contract §17).

V1.5 is a desktop operator layer over the unchanged V1 data plane. It adds a
tray application, a control center, router supervision and per-user
start-at-login, without touching the proxy, journaling, upstream pinning or
safety model of V1. The V1 CLI remains fully supported and authoritative;
the GUI never reimplements domain rules.

> Behavior described here that depends on runtime verification (pipe
> authorization, DPAPI interoperability, supervision transitions, build and
> launch) is verified in the pre-commit evidence — see
> `handoffs/v1.5-precommit-handoff.md`.

## Process topology

```text
GoRouterDesktop.exe  (WinForms shell: tray + control center)
        │  named pipe  \\.\pipe\gorouter-ctrl-<userSID>
        ▼
control-service  (Bun, src/desktop/control-service.ts)
        │  spawn / supervise / attach
        ▼
router  (unchanged V1 data plane, 127.0.0.1:<port>)
        ▲
        │  OMP / OpenCode client -> http://127.0.0.1:<port>/go/v1|/zen/v1
```

| Component | Responsibility |
| --- | --- |
| `GoRouterDesktop.exe` | WinForms shell: system tray (NotifyIcon), control-center window, single-instance mutex (`Local\GoRouterDesktop-<userSID>`), close-to-tray semantics, HKCU Run start-at-login management, DPI awareness (PerMonitorV2), accessibility names, and the control client (named pipe). |
| `control-service` (`src/desktop/control-service.ts`) | Named-pipe control API server, shared domain operations (`src/domain.ts`), router supervision, state-mtime watching for CLI coherence, event push to clients, desktop settings (`<state>/desktop.json`), admin token lifecycle. |
| `router` (`src/cli.ts` / `gorouter-router.exe`) | The unchanged V1 data plane. Never imports desktop code; spawned by the service only when no healthy router answers `/healthz` on the configured port (attach mode otherwise). |

### Spawn and environment contract

- Pipe override: `GOROUTER_DESKTOP_PIPE` (full pipe path). Unset → computed
  from the current user SID with dashes stripped:
  `\\.\pipe\gorouter-ctrl-<sid>`.
- Router command override: `GOROUTER_DESKTOP_ROUTER_CMD_JSON` = JSON array
  of argv (used by tests with a fake router).
- Dev mode: the shell spawns the service as `bun src/desktop/control-service.ts`
  with cwd = repo root; packaged mode: `<exeDir>/gorouter-control.exe`.
- The service resolves the router command: if `process.execPath` basename is
  `gorouter-control.exe` → `[<exeDir>/gorouter-router.exe, "serve"]`;
  otherwise → `["bun", "src/cli.ts", "serve"]` with cwd = repo root
  (`import.meta.dir/../..`). The env override wins.
- `GOROUTER_STATE_DIR` and `GOROUTER_LOG_LEVEL` pass through to the router
  child.
- Service startup order: ensure admin token (DPAPI blob
  `sec_desktop_admin` in `<state>/secrets`, created through the existing
  `createSecretStore` under `withFileLock` to avoid races), load
  `desktop.json`, then serve the pipe. Graceful shutdown (stop the managed
  router child only, exit 0) is performed through the `app.exit` control op.
- Managed-router lifecycle on Windows: the managed child is spawned by the
  control service and Bun 1.3.14 on Windows places children in a job object
  with `KILL_ON_JOB_CLOSE`, so the managed router **cannot outlive the
  control-service process** (verified empirically: a hard-killed service
  takes the managed child with it). The product therefore guarantees
  recovery, not survival: whenever the control service (re)starts, the
  supervisor probes the port and respawns the router if absent, with bounded
  backoff. `app.exit {stopRouter:false}` (credential reset) therefore causes
  a brief routing interruption that resolves automatically; the shell's
  reset dialog states this. **Attached external routers** (started by the
  operator, e.g. `bun src/cli.ts serve`) are never killed by the desktop —
  they are separate processes outside the service's job object and the
  supervisor adopts them read-only.
- SIGINT/SIGTERM handlers are best-effort — on Windows, Bun hard-terminates
  the process without delivering SIGTERM to JS handlers, so a killed
  service takes the managed child with it (job object) and the next shell
  start respawns it.
- Auto-start policy: on service start, if no router is running and
  `snapshot.firstRun` is false → spawn the managed router. If `firstRun` is
  true → stay stopped until onboarding completes (`desktop.set
  firstRunDone`).

## Control-plane authorization

- Transport is a Windows named pipe `\\.\pipe\gorouter-ctrl-<userSID>`
  (Bun `node:net` server). The OS user ACL is the first boundary: the pipe
  is per-user by name and inherits per-user access.
- Every request must carry the **admin token**: a random 32-byte base64url
  value stored ONLY as a DPAPI blob at
  `<state>/secrets/sec_desktop_admin.bin` via the existing
  `createSecretStore` (fixed ref `sec_desktop_admin`), created by the
  control service at first start. It is never the OMP local credential,
  never in OMP configuration, never displayed, never logged, never in argv.
- The C# shell reads the blob with P/Invoke `CryptUnprotectData` (same
  user → interoperable with the PowerShell DPAPI writer) and sends it in
  every request.
- The data-plane credential (the OMP-facing local client credential) is
  NEVER accepted on the control channel; the admin token is NEVER accepted
  on the proxy channel.
- Missing or wrong token → `{"ok":false,"error":{"code":"auth",...}}` and
  the server closes the connection. No token appears in any response.
- There is no HTTP listener and no WebView anywhere in V1.5; all GUI
  rendering is native WinForms and dynamic data renders as plain text
  labels. There is no browser-origin, CSRF or CORS class (see
  `docs/desktop-security.md`).

## One authoritative control domain

`src/domain.ts` (NEW in V1.5) is the single authoritative implementation of
every state/secret/journal mutation the product performs. The V1 CLI
command bodies were extracted from `src/cli.ts` into the shared domain API;
`src/cli.ts` keeps only argument parsing, stdin secret reading, output
formatting and the `serve` entrypoint, and delegates command bodies to the
domain. The control service calls exactly the same functions, so:

- domain validation and destructive-operation rules are not duplicated into
  inconsistent CLI-vs-GUI implementations (contract §5);
- aliases, duplicate checks, not-found errors, `config set` numeric/upstream
  rules and `account remove` routed-lane refusal produce identical messages
  on both surfaces;
- the GUI never edits `state.json`, DPAPI blobs or SQLite directly. The
  shell only (a) reads the admin token blob to authenticate and (b) writes
  HKCU Run for start-at-login (its own OS feature).

Domain mutation operations (setup, account add/update/rename/remove, route
set/clear, config set, reset, rotate-local-cred, local credential
creation) run `read + validate + mutate + write` INSIDE the cross-process
lock; read-only operations never lock.

### Cross-process mutation lock

`src/lock.ts` provides `withFileLock<T>(lockPath, timeoutMs, fn)`. The
lock file is `.state.lock` in the runtime state directory — never in the
repo. Acquisition is exclusive-create (`open(lockPath, "wx")`, atomic on
Windows) writing `{pid, ts}`; on EEXIST a stale lock (mtime older than 10s,
e.g. a writer that crashed mid-cycle) is reclaimed, otherwise retry every
10ms until the 5s timeout, then throw `Error("state lock timeout")`,
surfaced as `error.code: "conflict"` on the control channel. Release is
close + unlink in `finally`.

Concurrent writers (two CLI processes, or a CLI process and the control
service) therefore serialize: both operations commit, no lost update, and a
deterministic committed result is observable after races (contract §8).

## CLI↔GUI coherence

- The control service polls `state.json` and journal mtime at 1s.
- After any mutation — GUI-driven, CLI-driven, or detected external change
  (state mtime, journal mtime, router health transition) — the server
  pushes a full `snapshot` event to ALL connected clients, debounced
  ≤500ms and at most one per 250ms.
- Result: a CLI route/account change is visible in the GUI within ~1
  second; a GUI change is authoritative immediately for the next accepted
  request (V1 per-request snapshot semantics — in-flight requests keep
  their original route snapshot) and shows up in `cli status` immediately.
- Multiple open GUI surfaces all receive the same event push; no surface
  needs a manual restart to see another surface's change.

## Control-center navigation (V1.5.2)

The control center is a single shell instance; the dashboard (Routing tab
with the GO/ZEN account-selection cards) and the full journal view (Journal
tab) are two views of the same form. "View all" on the Recent activity card
enters the journal; `← Back` in the journal header — and Escape while the
journal is active — returns to the dashboard. All transitions funnel through
one navigation method (`ControlCenterForm.NavigateTo`) that only selects the
target tab. Navigation is selection-only: TabPages are never added, removed
or reparented, so the visible view is a pure function of the current
navigation state and repeated Dashboard → View All → Back cycles are
idempotent with no duplicate or orphan controls. Back never issues a
control-channel call (the journal refresh gate skips the Back re-entry),
never restarts anything, never closes the window (close-to-tray semantics
unchanged) and rewrites no state — GO/ZEN selections, router state and the
journal are left untouched, so live status keeps reflecting the
authoritative snapshot.

## Router supervision

The service probes `GET http://127.0.0.1:<port>/healthz` every 2s. The
router is "ours" iff the response is JSON with `status: "ok"` and the
router version field present; any other healthy-ish listener on the port is
foreign.

| Router state | Meaning |
| --- | --- |
| `stopped` | no router running; none started |
| `starting` | managed child spawned, not yet healthy |
| `running` | healthz ok (`mode`: `attached` or `managed`) |
| `degraded` | managed child restarting / in backoff |
| `port_conflict` | port busy, healthz not ours |
| `failed` | backoff exhausted; manual restart action required |

- **Attach mode**: if a healthy router already answers `/healthz` on the
  configured port, the service attaches and never starts a second instance
  on the same state/port.
- **Managed mode**: otherwise the service spawns the router child (dev or
  packaged command per the env contract) and supervises it.
- Restart backoff: 1s, 2s, 4s, 8s, 16s, then stop retrying and surface
  `failed` (manual restart action). No uncontrolled crash loop (contract
  §13).
- Shutdown (explicit shell Exit, `app.exit` with `stopRouter:true`): stop
  the MANAGED child only. Attached external routers are never stopped. If
  the service is killed, the managed child is terminated with it (Windows
  job object, `KILL_ON_JOB_CLOSE` — see the managed-router lifecycle note)
  and the next shell start respawns it; attached external routers are
  unaffected.
- `router.stop` when the router is `attached` → `error.code: "external"`,
  message explains the desktop never stops a router it did not start.
- No per-request notification spam: the tray shows aggregate router state
  only; per-request completion notifications are prohibited as default UX.
- A corrupt `state.json` fails closed to V1 defaults (port 8787, loopback,
  OpenCode upstreams); `snapshot.stateCorrupt` surfaces the condition and
  the supervisor re-binds the default port after a state reset/repair. An
  adopted state whose local credential blob is missing is never silently
  rotated — `snapshot.localCredentialConfigured=false` is shown with a
  banner and the CLI `setup` is the documented repair path.

## Control-channel protocol (summary)

Transport: newline-delimited UTF-8 JSON (one object per line, `\n` only,
max line 1 MiB — larger is closed by the server). `hello` must be the first
message (`{"app":"GoRouterDesktop","version":"1.5.0"}`); the server replies
with `{"serviceVersion":"1.5.0","protocol":1}` and pushes an initial
`snapshot` event.

Client ops: `snapshot`, `route.set` / `route.clear`, `account.add` /
`account.update` / `account.rename` / `account.remove` / `account.test`
(up to ~45s; client shows progress and ignores stale responses by id),
`journal.recent` (limit ≤ 1000), `journal.stats`, `config.set`
(`port|journalRetentionDays|journalMaxRecords` only — `host`,
`upstreamGo`, `upstreamZen` are refused with `error.code:"unsupported"`),
`desktop.set` (partial params; `startAtLogin`, `minimizeToTray`,
`firstRunDone`), `router.start` / `router.stop` / `router.restart`,
`localCred.once`, `app.exit` (`stopRouter`), `ping`.

Error codes: `validation | not_found | conflict | auth | unsupported |
external | unavailable | internal`. Messages never contain secrets.

The single `snapshot` shape carries: `serviceVersion`, `initialized`,
`firstRun`, `stateCorrupt`, `secretStore` (`"ok"|"unavailable"` — probed by
DPAPI-unprotecting the admin token blob, never logging the value),
`settings`, `routes` (per lane: `accountId` + `alias`), `accounts`
(`secretPresent` boolean only — never a secret), `router` (state, mode,
pid, port, restartCount), `journal` (records, oldest/newest, degraded,
retention), `desktop` (startAtLogin, minimizeToTray, firstRunDoneAtUtc),
`stateDir` (informational) and `localCredentialConfigured`.

`journal.recent` rows contain ONLY the safe V1 fields (router request id,
UTC timings, duration, lane, alias-at-time snapshot, method, endpoint
family, terminal outcome, HTTP status, allowlisted upstream request ids,
correlation id); the server reads the SQLite journal READ-ONLY on a
separate WAL-compatible connection. Journal read failure →
`{"ok":true,"data":{"rows":[],"degraded":true,"error":...}}` — never
blocks.

## Failure isolation and lifecycle

The GUI/control layer is never inserted into the upstream streaming byte
path (contract §13): router streaming behavior is independent of GUI
refresh/event handling, and the request path does not depend on the
graphical process being healthy.

- Shell crash → the service keeps running and the router keeps serving;
  the next launch attaches.
- Service crash/kill → a managed router child terminates with it (Windows
  job object, `KILL_ON_JOB_CLOSE`); the next shell start spawns a fresh
  service whose supervisor respawns the router (bounded backoff). Attached
  external routers are unaffected.
- Shell reconnect: on unexpected pipe close, retry with backoff 1s, 2s,
  4s (max 3), then show a "control service unavailable" state with a Retry
  button. Never auto-exit.
- `auth` failure → stop, show an actionable error (state-dir mismatch /
  corrupted admin token) and offer "Reset desktop control credential" only
  via explicit user confirmation (deletes the `sec_desktop_admin` blob;
  the service recreates it under the mutation lock).
- Launched twice → the second shell instance detects the single-instance
  mutex `Local\GoRouterDesktop-<userSID>` and yields to the running one.
  The service is a single process; a second shell attaches to the running
  service rather than starting a competing service/router.
- Login-triggered startup follows the auto-start policy above; startup
  registration is per-user and reversible (see Start-at-login).
- Windows user login while the desktop is configured → shell starts, the
  service attaches or spawns the managed router per policy; no competing
  router instances on the same state/port (healthz probe first,
  `port_conflict` state when the port is busy with a foreign listener).

## First run and existing-state adoption

- `ensureInitialized()`: if `state.json` is absent → run domain setup
  (creates the local client credential, arms `firstRun`). Existing V1
  state → adopted as-is: no re-entry of provider keys, no migration into a
  parallel store, no overwrite of an existing configuration (contract §12).
- Shell onboarding flow (only while `snapshot.firstRun` is true): welcome →
  local client credential shown once (copy button) → add the first account
  (Go or Zen) → choose which account serves each lane (GO / ZEN) → OMP
  configuration note (documentation reference, no config mutation) → done
  (`desktop.set firstRunDone`).
- `localCred.once` returns the local credential only while the first-run
  flag is armed, and is consumed once per service lifetime; after
  `firstRunDone` it is permanently `unavailable` for this state. It never
  returns provider secrets.

## Desktop settings

`<state>/desktop.json` (runtime, outside the repo), `schemaVersion: 1`:

| Key | Type | Notes |
| --- | --- | --- |
| `startAtLogin` | bool | desired state; the actual OS entry is managed by the shell (HKCU Run) |
| `minimizeToTray` | bool | close-to-tray behavior |
| `firstRunDoneAtUtc` | string | onboarding completion time |
| `freshStateCreatedAtUtc` | string | set when the service created the runtime state (fresh-state marker; adopted V1 state never has it) — drives persistent first-run arming |

GUI-exposed settings: start-at-login, minimize-to-tray, router port
(existing V1 safety rules: 1..65535, default 8787; changing the port while
a router is running is refused with a clear message),
`journalRetentionDays`, `journalMaxRecords`. NEVER exposed: `host`,
upstreams — there is no arbitrary upstream-authority control in the GUI
(contract §4.7/§11). There is no reset in the GUI; `reset --yes` remains
CLI-only and is documented.

## Start-at-login mechanics

- The SHELL owns the OS registration: HKCU
  `Software\Microsoft\Windows\CurrentVersion\Run` value `GoRouterDesktop`
  = path to the shell executable. The SERVICE records the desired state in
  `desktop.json` and reports it in `snapshot.desktop`; the GUI toggle
  reflects the recorded state.
- Per-user (HKCU, no machine-level changes), opt-in, reversible from the
  same in-app toggle, and operable without Administrator rights (contract
  §11).
- Turning the toggle off removes the Run value (full rollback); the app
  folder and state directory are untouched.
- Execution-time tests of startup registration are required to be
  reversible (contract §11): any test that registers or unregisters the
  Run value must leave the machine in its prior state.

## Runtime state boundary

All runtime state lives under `%LOCALAPPDATA%\GoRouter` (or
`GOROUTER_STATE_DIR`): `state.json`, `secrets/` (DPAPI blobs, incl.
`sec_desktop_admin.bin`), `journal.db` (+ WAL), `desktop.json`,
`.state.lock`. Nothing is written into the repository at runtime; the
shell, service and router never persist credentials into the app folder
(see `docs/desktop-packaging.md`).
