# OMP integration — GoRouter V1

This document describes the only OMP-side configuration change GoRouter V1
requires, its semantics, and the rollback path. The change is minimal,
non-secret, and reversible.

## What was changed

`~/.omp/agent/models.yml` gained a clearly marked block (the file's prior
content was preserved verbatim; a backup exists at
`~/.omp/agent/models.yml.gorouter-backup`):

```yaml
# === GoRouter V1 integration (begin) ===
providers:
  opencode-go:
    baseUrl: http://127.0.0.1:8787/go/v1
    apiKey: GOROUTER_LOCAL_KEY
    authHeader: true
  opencode-zen:
    baseUrl: http://127.0.0.1:8787/zen/v1
    apiKey: GOROUTER_LOCAL_KEY
    authHeader: true
# === GoRouter V1 integration (end) ===
```

Effect (OMP `models.yml` merge semantics, verified against the installed
OMP 17.2.11):

- Built-in `opencode-go` / `opencode-zen` providers keep their model
  catalogs and wire metadata, but requests are sent to the GoRouter local
  lanes instead of the upstream hosts.
- `apiKey: GOROUTER_LOCAL_KEY` is an env-var name: OMP resolves
  `GOROUTER_LOCAL_KEY` from the process environment and (with
  `authHeader: true`) sends `Authorization: Bearer <local credential>`.
  This beats OMP's stored opencode credentials (config override precedence),
  so **no real OpenCode key is stored in or resolved from OMP configuration
  for routing**.
- Model discovery (`GET /models`) flows through the router and returns the
  live upstream catalogs (verified: go=25, zen=61).

## Operator steps

```powershell
# 1. export the router's local credential for OMP processes
$env:GOROUTER_LOCAL_KEY = bun src/cli.ts local-cred

# 2. use Go/Zen models as usual
omp run --model opencode-go/mimo-v2.5 -p "Reply with exactly: OK"
omp run --model opencode-zen/mimo-v2.5-free -p "Reply with exactly: OK"
```

The router must be running (`bun src/cli.ts serve` or supervised) whenever
OMP uses opencode-go / opencode-zen models; otherwise those models fail
closed (connection refused). This is the documented persistent-operation
model of V1.

## Security properties (verified)

- The value of `GOROUTER_LOCAL_KEY` is a random router-generated access
  credential — not an OpenCode account key — validated only by GoRouter on
  127.0.0.1:8787.
- The router strips the local Authorization and injects the selected
  account's key at the upstream boundary; the local credential never leaves
  localhost.
- `state.json` and OMP configuration contain no real keys; DPAPI blobs
  contain no plaintext.

## Rollback

```powershell
Copy-Item "$env:USERPROFILE\.omp\agent\models.yml.gorouter-backup" "$env:USERPROFILE\.omp\agent\models.yml"
```

or delete the `# === GoRouter V1 integration (begin/end) ===` block. No other
OMP configuration was touched; validation ran with `--no-session` runs and
did not modify OMP auth storage, sessions or settings.

## Verified integration evidence

`docs/evidence/omp-e2e.json` (local artifact, no secrets):

1. `omp run --model opencode-go/mimo-v2.5` with GO→acct2 → completion "OK".
2. `omp run --model opencode-zen/mimo-v2.5-free` with ZEN→acct1 → completion "OK".
3. `route go acct1` (CLI, no restart) → same OMP command surfaces
   `429 GoUsageLimitError` with acct1's workspace id — the selected account's
   credential was used upstream; no router fallback, no account switch.
4. `route go acct2` → completion again.
