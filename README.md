# OpenCode GoRouter V1

A Windows-first localhost credential/lane router for **OpenCode Go** and
**OpenCode Zen**: one stable OMP/OpenCode client configuration can use
multiple named OpenCode accounts while independently selecting which account
serves the **Go** lane and which account serves the **Zen** lane.

```text
OMP / OpenCode client  -->  127.0.0.1:8787/go/v1/*   -->  https://opencode.ai/zen/go/v1
                         -->  127.0.0.1:8787/zen/v1/*  -->  https://opencode.ai/zen/v1
```

- Account identity + service lane is the governing model: **one credential per
  account**, routing state independent by lane (`GO -> account`, `ZEN -> account`).
- The router is a **transparent proxy**: no model/prompt/tool rewriting, no
  protocol translation, streaming preserved.
- **No automatic account rotation, no router-initiated lane fallback.**
- Free/paid model classification, billing policy, quota prediction and the
  OpenCode balance-fallback switch are deliberately **outside** GoRouter.

Contract: `gorouter-v1-long-horizon-r4` (see `Notes/OpenCode_GoRouter_V1_Long_Horizon_R4_2026-08-08`).

---

## Status

- **V1 router (complete)** — loopback proxy, DPAPI secret store, SQLite
  request journal, full CLI. Single-user loopback threat model:
  credential-in-memory, pipe-auth, availability-only residual risks.
- **V1.5 desktop (complete)** — system tray, control center, router
  supervision, per-user start-at-login. The CLI remains authoritative;
  every GUI action runs the same shared domain operations.
- **Models catalog + DSH sync (complete)** — upstream catalog refresh
  with cross-process single-flight, approval-gated sync of owned-provider
  model lists into the DSH settings file (one-time init, legacy-migration
  ratification, per-tuple approve/revoke), probe-based account testing
  with quota-aware classification.
- **Performance pass (complete)** — hot-path memos (upstream parse,
  registry, state), hoisted SQLite prepares, persistent control-plane
  journal handle with TTL'd aggregates, single-pass header sanitize +
  credential strip, deferred WAL checkpoint, UI dirty-checks and
  activity-render throttling. No behavior change; gains are per-request
  µs-to-ms and per-tick connection/scan elimination.
- **Quality gates (all passing)** — `bun test`: 535 tests across 30
  files, 0 failures; `bun run typecheck` clean; desktop shell Release
  build with 0 errors.
- **Adversarial review (closed)** — hostile read-only review loops over
  the control plane, data plane, models sync and C# shell all verified
  to CONFIRMED with behavior-seam regression tests, including the perf
  slices (two genuine review catches fixed and re-verified). Three
  findings were deliberately declined (shutdown-path-only teardown
  block; verbatim lane-id matching that fails closed; per-account
  status stats batching, small at current scale) — see git history.

---

## Requirements

- Windows 10/11, PowerShell 5.1 (Windows PowerShell — ships with Windows).
- Bun 1.x (`bun` on PATH; the router also runs with `bun run` from this repo).

## Install / setup

```powershell
# from this repository
bun install
bun src/cli.ts setup
```

`setup` creates the state directory (default `%LOCALAPPDATA%\GoRouter`,
override with `GOROUTER_STATE_DIR`), generates the **local client credential**
and prints it **once**. Treat that credential like a password: it is the only
thing OMP ever sends to the router; real OpenCode keys never enter OMP config.

> The local client credential is validated only by GoRouter on
> `127.0.0.1:8787` and never leaves localhost. Rotate it any time with
> `gorouter rotate-local-cred` (update OMP afterwards).

## Enroll accounts

Real OpenCode keys are imported via **stdin** — never as command-line
arguments, never in shell history, never in plaintext files in this
repository (and never via `Get-Content key.txt | ...` — do not leave key
files on disk):

```powershell
# interactive: run the command, then paste the key and press Enter
bun src/cli.ts account add acct1
bun src/cli.ts account add acct2
```

The key is read from stdin only; it is not echoed, not written to shell
history, and not persisted anywhere in plaintext. Keys are stored as
per-user **DPAPI-encrypted blobs** (`CryptProtectData`) under
`%LOCALAPPDATA%\GoRouter\secrets`. `state.json` contains only opaque secret
references.

## Select lanes (independent)

```powershell
bun src/cli.ts route go acct2     # Go  -> Account 2
bun src/cli.ts route zen acct1    # Zen -> Account 1
bun src/cli.ts status
```

```text
GoRouter V1 status
  GO  -> acct2
  ZEN -> acct1
  Automatic account rotation: DISABLED by design
  Router-initiated lane fallback: DISABLED by design
```

A route change takes effect for the **next request** — no router restart.
Requests already in flight keep their original route snapshot.

## Start / stop

```powershell
bun src/cli.ts serve              # foreground, 127.0.0.1:8787
```

For a persistent router, run it under a supervisor that restarts on failure
(e.g. Task Scheduler, `sc.exe` with a service wrapper, or the harness's
`restart: on-failure` policy). Health check:

```powershell
curl http://127.0.0.1:8787/healthz
```

Stop: press Ctrl+C in the console (or terminate the supervising job). Nothing is written
into the repository at runtime.

## OMP integration

OMP's built-in `opencode-go` / `opencode-zen` providers are pointed at the
router through `~/.omp/agent/models.yml` (see `docs/omp-integration.md` for
the exact block, semantics and rollback):

```yaml
providers:
  opencode-go:
    baseUrl: http://127.0.0.1:8787/go/v1
    apiKey: GOROUTER_LOCAL_KEY     # env var = the local client credential
    authHeader: true
  opencode-zen:
    baseUrl: http://127.0.0.1:8787/zen/v1
    apiKey: GOROUTER_LOCAL_KEY
    authHeader: true
```

Export `GOROUTER_LOCAL_KEY` (value printed by `gorouter local-cred`) for OMP
processes, then select Go/Zen models as usual:

```powershell
$env:GOROUTER_LOCAL_KEY = bun src/cli.ts local-cred
omp run --model opencode-go/mimo-v2.5 -p "Reply with exactly: OK"
omp run --model opencode-zen/mimo-v2.5-free -p "Reply with exactly: OK"
```

Real account keys are **not** stored in any OMP provider configuration; OMP
sends only the local credential to the router, and the router injects the
selected account's key at the upstream boundary.

## CLI reference

| Command | Purpose |
| --- | --- |
| `setup` | init state + local credential (prints once) |
| `local-cred` | print the local client credential |
| `rotate-local-cred` | rotate the local client credential |
| `account add <alias>` | enroll account (key via stdin) |
| `account update <alias>` | replace account key (via stdin) |
| `account list` | aliases + DPAPI refs, no secrets |
| `account rename <old> <new>` | rename (stable account id preserved) |
| `account remove <alias> [--force]` | remove (refused while routed) |
| `account test <alias> [--lane go\|zen]` | live non-billing probe of the account |
| `route [go\|zen <alias>]` | show/set lane selection |
| `route clear <go\|zen>` | clear a lane selection |
| `status` | routes + journal health |
| `journal stats` | journal schema/records/retention/degraded |
| `config show` / `config set <key> <value>` | settings (port, host, upstreams, retention) |
| `serve [--port N] [--host H]` | run the router |
| `models refresh [--json]` | refresh upstream model catalog (single-flight, cross-process claim) |
| `models diff [--json]` | model changes since last publish |
| `models approvals status [--json]` | approval store + eligibility state |
| `models approvals approve <id> --lane go\|zen` | approve a model (first approval initializes the store) |
| `models approvals revoke <id> --lane go\|zen` | revoke a model approval |
| `models approvals migrate --apply` | ratify legacy DSH entries into approvals |
| `reset --yes` | remove all accounts, secrets and the local credential (settings and the journal are retained) |

> V1.5 CLI behavior notes: `account rename` now prints the truthful
> `account renamed 'OLD' -> 'NEW'` message (V1 printed the new alias on both
> sides — a pre-existing message bug, corrected deliberately; the stable
> account id is preserved either way). All other V1 command messages, exit
> codes and semantics are byte-identical to V1. Secret redaction was
> additionally hardened to mask bare 40+ character base64url runs (local
> credential / admin-token shaped values) in logs and output.

## Request journal (routing provenance)

Every accepted request gets a stable opaque `router_request_id` before
upstream dispatch, exposed to the local client via the
`X-Gorouter-Request-Id` response header (never sent upstream). The SQLite
journal (`%LOCALAPPDATA%\GoRouter\journal.db`, schema v1) records lane,
stable account id + alias-at-time snapshot, method, endpoint family, UTC
timing, monotonic duration, terminal outcome/status and allowlisted upstream
request ids. It **never** stores prompts, responses, Authorization values,
keys, cookies or arbitrary headers. `model` is always `unknown` in V1 — no
body parsing for telemetry. Retention is bounded (default 30 days / 100k
records; `config set journalRetentionDays|journalMaxRecords`). Journal faults
never block routing. Journal health is observable via `gorouter journal stats`
(and `status`); `/healthz` stays a minimal static liveness probe by design
(CURRENT-007: status + version only, so unauthenticated callers can never
observe routes, aliases, journal content or secrets).

## Safety model

- Loopback-only binding, enforced: `config set host` refuses non-loopback
  values, hand-edited state fails closed to `127.0.0.1`, and `serve --host`
  refuses non-loopback hosts. Upstream authority is fixed per lane from
  settings (only `https://opencode.ai` or loopback test hosts), never derived
  from request input; redirects are never followed.
- Upstream TLS validation is always on.
- Local credential never forwarded upstream; account keys never returned
  client-side, never logged, never committed.
- Errors never switch accounts; upstream 401/429/5xx are passed through
  faithfully.
- Missing route / missing secret / dangling reference fail closed locally
  before any upstream dispatch.

## Uninstall / reset

```powershell
bun src/cli.ts reset --yes        # removes accounts, secrets and the local credential
                                  # (settings and the append-only journal are retained)
# for a full wipe, also delete the state directory:
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\GoRouter"
# optionally remove the OMP models.yml block (rollback:
# restore ~/.omp/agent/models.yml.gorouter-backup)
```

## Tests

```powershell
bun test          # full deterministic suite (mock upstream; DPAPI round-trip included)
bun run scripts/validate-live.ts   # live account/lane matrix (requires env keys)
bun run scripts/omp-e2e.ts         # OMP end-to-end (requires router + OMP override)
```

## V1.5 Desktop (tray + control center)

GoRouter V1.5 is a native Windows desktop operator layer over the unchanged
V1 router: a system-tray presence, a compact control center, router
supervision and an optional per-user start-at-login mode. **The V1 CLI
remains fully supported and authoritative** — every GUI action executes the
same shared domain operations the CLI uses, so both surfaces always agree
on state, validation and destructive-operation rules.

V1.5 adds:

- **System tray** — router state (running / degraded / stopped), current Go
  and Zen accounts, direct lane switching, open control center, router
  lifecycle actions, exit. No per-request notification spam.
- **Control center** — account lifecycle, independent Go/Zen route
  selection, request-journal browsing (safe fields only), health and
  settings.
- **One control domain** — `src/domain.ts` is the single authoritative
  implementation of every state/secret/journal mutation, used by both the
  CLI and the desktop control service, with a cross-process mutation lock
  (`src/lock.ts`) so concurrent CLI and GUI writers serialize.
- **Supervision** — the control service attaches to an already-running
  healthy router, otherwise spawns and supervises one with bounded restart
  backoff; it never kills a router it did not start.
- **Coherence** — CLI-side changes appear in the GUI within ~1 second
  (state mtime watch + event push); GUI changes are authoritative for the
  next request with no restart, and in-flight requests keep their original
  route snapshot (unchanged V1 invariant).

The proxy data plane (server, journal, safety model, upstream pinning) is
not modified by V1.5.

### Quick start (development)

```powershell
bun install
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/desktop-dev.ps1
```

This builds the shell, starts the control service
(`bun src/desktop/control-service.ts`) and launches the tray app. In dev
mode the service spawns the router as `bun src/cli.ts serve`.

### Quick start (packaged)

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-desktop.ps1
# dist/ now contains GoRouterDesktop.exe (shell),
# gorouter-control.exe (control service) and gorouter-router.exe (router).
# Copy the dist/ folder anywhere (per-user) and run:
.\dist\GoRouterDesktop.exe
```

No Administrator rights are required to build, install or run the desktop
app. Runtime state always stays under `%LOCALAPPDATA%\GoRouter` (or
`GOROUTER_STATE_DIR`) — never in the repository or the app folder.

### First run

Fresh state: welcome → local client credential shown once (copy button) →
add the first account (Go or Zen) → choose which account serves the GO and
Zen lanes → note on OMP configuration → done.
Existing V1 state is adopted as-is: accounts, routes, local credential,
journal and settings are used directly — nothing is re-entered or migrated
into a parallel store.

### Start at login

Opt-in per-user toggle in the control center (HKCU `Run` value
`GoRouterDesktop` pointing at the shell executable). Reversible from the
same toggle, applies only to the current Windows user, no Administrator
rights.

### Uninstall / rollback

1. Exit the app (tray → Exit).
2. Turn off start-at-login (removes the `GoRouterDesktop` HKCU Run value).
3. Delete the dist folder.
4. Optionally remove runtime state: `bun src/cli.ts reset --yes`, then
   delete `%LOCALAPPDATA%\GoRouter`.

The CLI is untouched by the desktop install; deleting the desktop folder
fully rolls back to V1 CLI-only operation.

### Documentation

- `docs/desktop-architecture.md` — process topology, control-plane
  authorization, supervision, coherence, failure isolation.
- `docs/desktop-packaging.md` — reproducible build, dist layout, install,
  uninstall, third-party notices.
- `docs/desktop-security.md` — attack-surface analysis mapped to the
  contract security classes.

## V2/later (explicitly deferred)

Profiles/sticky/project routing, per-profile virtual tokens, explicit
opt-in fallback, OMP `:3847` telemetry integration, provider dashboard
quota adapters, token-to-credit estimation, multi-provider routing.
