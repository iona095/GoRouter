# GoRouter V1.5 Desktop — Security / Attack-Surface Analysis

Governing contract: `gorouter-v1.5-desktop-long-horizon-r3` §17 (security
challenge surface). This document maps each mandated failure class to the
design control that prevents it. Companion documents:
`docs/desktop-architecture.md` and `docs/desktop-packaging.md`.

Threat model in one line: V1.5 adds a per-user control plane (named pipe +
native WinForms) over the unchanged V1 data plane; there is no HTTP control
listener, no browser technology, no network-visible surface, and the GUI
has no path to the router's upstream traffic.

> Runtime-dependent behaviors (pipe authorization, DPAPI interoperability,
> supervision transitions, secret-scan results, candidate-tree hygiene)
> are verified in the pre-commit evidence — see
> `handoffs/v1.5-precommit-handoff.md`.

## §17.1 — Administrative control granted solely by the OMP-facing data-plane credential

Not the case. Control-plane authorization uses a **distinct protected
credential**: a random 32-byte base64url admin token stored only as a
DPAPI blob (`<state>/secrets/sec_desktop_admin.bin`, ref
`sec_desktop_admin`) created by the control service under the mutation
lock. The data-plane local client credential (the only thing OMP ever
holds) is never accepted on the control channel, and the admin token is
never accepted on the proxy channel. A request with a missing or wrong
token receives `error.code:"auth"` and the connection is closed. The admin
token is never in OMP configuration, never displayed, never logged, never
in argv or URLs.

## §17.2 — Control endpoint exposed beyond the intended local user boundary

The control endpoint is a Windows named pipe named per-user
(`\\.\pipe\gorouter-ctrl-<sid>`, SID dashes stripped). There is no TCP
control listener of any kind — the only listening socket in the product is
the V1 loopback router port, which speaks only the V1 HTTP data-plane
protocol and requires the local client credential. Control operations are
unreachable over the network.

Pipe DACL (empirically verified on the build host, 2026-08-08):
`node:net`'s **default** named-pipe security descriptor grants
`FILE_READ_DATA` to Everyone and Anonymous
(`(A;;FR;;;WD)(A;;FR;;;AN)`), while write access is restricted to SYSTEM,
Administrators and the creating user. Write access is therefore already
per-user, and every control message additionally requires the admin token —
but the read grant was broader than the intended boundary. The control
service therefore **hardens the DACL immediately after binding**
(`src/desktop/pipe-acl.ts`, `SetSecurityInfo` via PowerShell 5.1
`-EncodedCommand`): the effective DACL is

```text
O:<user> G:<group> D:(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;<user SID>)
```

i.e. SYSTEM + Administrators + the current user, full access only. Verified
before/after SDDL readback (Everyone/Anonymous ACEs removed) and covered by
a regression test (`test/control.test.ts` "control pipe DACL is hardened").
Hardening failure is non-fatal and logged
(token auth remains the primary authorization boundary).

## §17.3 — Cross-origin/browser invocation of privileged local actions

No browser surface exists: no HTTP control API, no WebView, no embedded
browser. The GUI is native WinForms; there is no origin concept, hence no
CORS/CSRF class. A hostile web page could still send requests to the
loopback router port, but that surface is unchanged from V1: requests
without the local client credential fail local 401 before any upstream
call, the router only forwards pinned OpenCode paths with
`redirect: "manual"`, and the control plane is not reachable over HTTP at
all.

## §17.4 — HTML/script injection from account aliases, journal text, upstream errors or metadata

All dynamic data — account aliases, journal rows, upstream error text,
health text — is rendered by WinForms controls as **plain text labels**.
No HTML parsing, no markup interpretation, no WebView, no script
execution surface. Untrusted fields are data, never markup. Aliases are
additionally subject to the V1 alias validation rules at entry.

## §17.5 — Secret persistence in UI/web storage, argv, URL, logs, diagnostics or crash paths

Secret-entry invariant (contract §7.1), enforced at every layer:

- Provider secrets are entered in a **masked textbox** in the WinForms UI;
  the textbox clears when the dialog closes.
- They transit only in the body of a control-channel message over the
  loopback named pipe (same user, admin-authenticated), transient in
  memory, and are stored via domain → DPAPI.
- They are never echoed after enrollment, never placed in URLs/query
  strings, never in process argv, never in configuration files.
- There is **no read/reveal API**: after enrollment the UI receives only
  non-secret metadata and `secretPresent: boolean` in snapshots.
- The control service MUST NOT log request params; the shell never logs
  request params and never writes secrets to disk.
- Journal rows, crash data and diagnostics contain no credential material;
  UX evidence screenshots are produced from fixture data and must never
  contain real credentials (contract §18).
- `localCred.once` (first-run local credential display) is armed only
  while the first-run flag is armed, is consumed once per service
  lifetime, and never returns provider secrets.
- There is no web storage of any kind (no localStorage/IndexedDB/cache —
  no browser).

## §17.6 — GUI route/account changes bypassing domain validation

Impossible by construction: the shell issues protocol operations; every
mutation is executed by the control service through `src/domain.ts` — the
same functions the CLI calls, with the same validation, the same error
messages and the same cross-process mutation lock. The GUI has no
state-writing path of its own (it never edits `state.json`, DPAPI blobs or
SQLite; the only OS write the shell performs is its own HKCU Run value).

## §17.7 — Direct arbitrary edit of upstream authority through the GUI

The GUI exposes no upstream controls: no host field, no upstream textbox,
no "advanced" override. `config.set` on the control channel refuses
`host` / `upstreamGo` / `upstreamZen` with `error.code:"unsupported"`; the
only GUI-settable settings are `port` (1..65535, default 8787, refused
while a router is running), `journalRetentionDays` and
`journalMaxRecords`. Upstream authority stays pinned to the accepted
OpenCode surface exactly as in V1.

## §17.8 — GUI or desktop crash interrupting the request path

The GUI is not on the request path: the shell only talks to the control
service over the pipe, and the service is not a proxy hop — router
streaming is byte-for-byte independent of GUI refresh/event handling.
Failure isolation:

- Shell crash → service and router keep running; next launch attaches.
- Service crash/kill → a managed router child terminates with it (Windows
  job object, `KILL_ON_JOB_CLOSE`); the next shell start spawns a fresh
  service whose supervisor respawns the router (bounded backoff). Attached
  external routers are unaffected.
- Shell connection loss → reconnect with backoff 1s/2s/4s (max 3), then a
  "control service unavailable" state with Retry; never auto-exit, never a
  routing interruption.

## §17.9 — Duplicate desktop/router instances racing state

- Shell: single-instance mutex `Local\GoRouterDesktop-<userSID>` — a
  second launch yields to the running instance.
- Service: the shell attaches to an already-running service; there is only
  one service process per user state.
- Router: the service probes `/healthz` before spawning; a healthy foreign
  listener on the port yields `port_conflict` (never a second instance on
  the same port), a healthy GoRouter yields attach mode. The desktop never
  starts competing router instances on the same state/port.
- Mutations: the cross-process lock (`src/lock.ts`, `.state.lock` in the
  state dir) serializes every read-modify-write cycle across CLI and
  service writers — no lost updates, deterministic committed results
  (contract §8).

## §17.10 — Stale GUI state after CLI mutation

The service polls `state.json`/journal mtime at 1s and pushes full
`snapshot` events to all connected clients on any change (debounced
≤500ms, at most one per 250ms). CLI-side changes are visible in the GUI
within ~1 second; multiple open GUI surfaces all receive the push. The GUI
does not hold long-lived authoritative state that could silently diverge.

## §17.11 — Destructive removal/reset causing silent reroute

`account.remove` refuses a routed lane without `force` (identical message
to the CLI); with `force`, the lane selection is explicitly cleared and
the secret blob deleted — there is no silent reroute to another account.
The GUI requires explicit confirmation for destructive actions, and there
is **no reset in the GUI at all** — `reset --yes` remains CLI-only and
documented, so the full-state destructive op cannot be triggered from the
GUI.

## §17.12 — Journal query exposing bodies/headers/secrets

The journal schema is unchanged from V1: it stores only safe fields
(router request id, UTC timing, duration, lane, alias-at-time snapshot,
method, endpoint family, terminal outcome/status, allowlisted upstream
request ids, validated correlation id) and never prompts, responses,
Authorization values, keys, cookies or arbitrary headers. The GUI's
`journal.recent` returns exactly those safe fields, newest-first, read
READ-ONLY from SQLite (separate WAL-compatible connection). `model` stays
`unknown` — no body parsing. Journal read failure degrades observably and
never blocks routing or the UI.

## §17.13 — Local runtime/evidence files accidentally entering the candidate commit

Runtime state lives outside the repo (`%LOCALAPPDATA%\GoRouter` or
`GOROUTER_STATE_DIR`), so it cannot be staged. Repo-side generated
artifacts are gitignored: `dist/`, `src/desktop/shell/bin/`,
`src/desktop/shell/obj/`, `docs/evidence/`, `*.db*`, `state.json`,
`secrets/`, `.env*`. The pre-commit gate stages the exact candidate tree
and verifies hygiene (secret scan, untracked-exclusion review) — see the
pre-commit handoff.

## §17.14 — Installer/package accidentally embedding operator state or credentials

There is no installer: distribution is a copy-the-folder model, and the
build (`scripts/build-desktop.ps1`) compiles from repository source only.
`dist/` contains no credentials, no operator state, no journal; runtime
state is resolved at runtime from `%LOCALAPPDATA%`/`GOROUTER_STATE_DIR`
and never written into the app folder. Nothing in the package writes
machine-global configuration; the only registration is the optional
per-user HKCU Run value managed by the in-app toggle.

## Cross-cutting: what the GUI never adds

- **No automatic account rotation** and **no router-initiated lane
  fallback** anywhere in the desktop layer — the GUI cannot select,
  configure or trigger either (contract §4.5/§4.6). Errors never switch
  accounts.
- **No arbitrary upstream authority** (see §17.7), no analytics, no
  telemetry, no cloud dependency, no OMP `:3847` dependency, no
  auto-update, no code-signing infrastructure (contract §3.2/§14).
- **No credential in any ordinary UI surface**: snapshots carry
  `secretPresent` only; the tray and control center render account aliases
  and route state, never secrets.

## Verification status

The controls above are the design. Their effectiveness is exercised by the
V1.5 candidate's adversarial audit and fresh final verification — including
pipe authorization, secret-scan, split-brain CLI/GUI coherence, supervision
transitions and candidate-tree hygiene. Results and the exact pre-commit
candidate are recorded in `handoffs/v1.5-precommit-handoff.md` (written at
the terminal boundary; see the verification markers in the evidence
summary `docs/evidence/v1.5/summary.txt`).
