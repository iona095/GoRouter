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

Stop: send Ctrl+C/SIGTERM, or kill the supervising job. Nothing is written
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
| `reset --yes` | remove all accounts, secrets and the local credential (settings and the journal are retained) |

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
degrade observably in `/healthz` and never block routing.

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

## V2/later (explicitly deferred)

Profiles/sticky/project routing, per-profile virtual tokens, explicit
opt-in fallback, OMP `:3847` telemetry integration, provider dashboard
quota adapters, token-to-credit estimation, multi-provider routing.
