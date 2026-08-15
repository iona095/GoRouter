# GoRouter V1 — Architecture

Governing contract: `gorouter-v1-long-horizon-r4`.

## Domain model

```text
Account = OpenCode identity + one securely stored real credential (DPAPI)
Lane    = OpenCode service surface: go | zen
Route   = lane -> account  (independent per lane)
```

Valid state includes `GO -> Account 2, ZEN -> Account 1`. More than two
accounts are supported; the immediate scenario uses two.

## Components

| Module | Responsibility |
| --- | --- |
| `src/cli.ts` | operator surface: accounts, routes, probe, serve, journal stats, config, reset |
| `src/server.ts` | loopback HTTP proxy: local auth, path routing, snapshot dispatch, streaming, response metadata |
| `src/inbound-http.ts` | node:http transport adapter: raw request-target validation before WHATWG normalization, Transfer-Encoding (chunked) request-body rejection, held-body client-abort detection |
| `src/state.ts` | non-secret persisted state (accounts metadata, route selections, settings); atomic tmp+fsync+rename writes; per-request snapshot reads |
| `src/secret-store.ts` | Windows DPAPI (CryptProtectData) blob store with mtime-keyed decrypt cache and spawn retry |
| `src/journal.ts` | SQLite request journal, schema v1, bounded retention, degradable |
| `src/probe.ts` | smallest-safe live account/lane probe with quota-aware classification |
| `src/util.ts` | redaction, logging, atomic writes, header sanitization, endpoint-family classification |
| `src/paths.ts` | state directory resolution (`%LOCALAPPDATA%\GoRouter` or `GOROUTER_STATE_DIR`) |

## Request lifecycle (server)

0. **Transport boundary** (`src/inbound-http.ts`): the raw request-target PATH
   (the query is split off at the first `?` and preserved semantically) is
   validated BEFORE WHATWG URL normalization — absolute-form and asterisk-form
   targets, backslashes, encoded double-slashes, encoded dot-dot traversal
   (including mixed literal+encoded and semicolon-parameter forms), malformed
   percent-escapes in the path, and percent-encoding nested beyond the 3-pass
   decode bound are rejected 400. Transfer-Encoding (chunked) request bodies
   are rejected 400 before consumption (REJECT_UNSAFE_CHUNKED_REQUEST_BODIES:
   the client-abort invariant is preserved by never admitting unsafe framing)
   and the connection is terminated. GET/HEAD with a declared request body is
   rejected 400. Client-abort detection uses the request's `aborted` signal
   only and is disabled for `Connection: close` requests.
1. Path must match `/go/v1/*` or `/zen/v1/*`; anything else → local 404/400.
2. Local client auth: `Authorization: Bearer <local credential>` validated
   against the DPAPI-protected local credential (constant-time compare).
   Missing/invalid → local 401; **no upstream call**.
3. Route snapshot: lane → account id + alias + decrypted secret, read once
   per request from `state.json` (atomic rename makes concurrent updates
   unobservable half-written). Missing route/dangling account/missing secret
   → local 503/500; **no upstream call**.
4. `router_request_id` assigned and journal row inserted **before** upstream
   dispatch.
5. Upstream: fixed per-lane authority from settings — origin-validated at
   `config set` and on every load (foreign origins fail closed to the
   OpenCode default; loopback HTTP is the only non-OpenCode escape, for
   deterministic tests). Path suffix + query + method + body passed
   verbatim; local/hop-by-hop headers stripped; the selected account key is
   injected into the **endpoint-family-appropriate header** (validated
   against the current OpenCode gateway surface: `authorization: Bearer`
   for chat/completions and responses, `x-api-key` for /messages,
   `x-goog-api-key` for Gemini per-model endpoints); `Host` set to the
   upstream authority; `redirect: "manual"`; TLS validation on; client
   abort propagates to the upstream stream.
6. Response: status/headers/body pass through (content-encoding/length are
   transport-managed); `X-Gorouter-Request-Id` added locally; body streamed
   without buffering. Journal finalizes on stream completion, client
   disconnect (`client_abort`) or upstream stream error; **bodyless
   responses (204/304/empty) finalize immediately** — no record stays
   `in_flight` for a terminal proxied response. Locally generated terminal
   responses that carry a `router_request_id` (502 upstream-fetch failure,
   origin-mismatch 500) expose it via `X-Gorouter-Request-Id`.

## Invariant map (contract §10/§12/§14)

- Route change → next request, no restart; in-flight requests keep their
  snapshot (journal proves the dispatched snapshot).
- Route state updates are atomic (tmp + fsync + rename).
- Failures: no implicit rotation; upstream 401/429/5xx proxied faithfully,
  exactly once.
- Loopback default (`127.0.0.1`); `--host` at serve time is required for any
  other binding; non-loopback persistence is refused by `config set host`.
- Redirects never followed → credentials cannot be forwarded to an
  unintended host.

## Journal schema (v1)

`request_journal` columns: schema_version, router_request_id (unique),
started_at_utc / completed_at_utc (ISO-8601 UTC, ms), duration_ms
(monotonic), lane, selected_account_id (stable), selected_account_alias_
snapshot (at request time), method, endpoint_family (path class), terminal_
outcome (`ok | upstream_error | local_error | client_abort | in_flight`),
http_status, upstream_request_ids (allowlist: `x-request-id`,
`x-amzn-requestid`), model (always NULL in V1), client_correlation_id
(`X-Gorouter-Correlation-Id` when it passes bounded validation).

Retention: `journalRetentionDays` (default 30) and `journalMaxRecords`
(default 100k), pruned on startup and every 64 inserts. Journal storage
faults set `degraded` (visible in `/healthz` and `journal stats`) and never
block routing.

## Live upstream evidence (current, captured 2026-08-08)

- Go lane: `https://opencode.ai/zen/go/v1` — 25-model catalog.
- Zen lane: `https://opencode.ai/zen/v1` — 61-model catalog including the
  non-billing `*-free` family.
- Documented API surface (opencode.ai/docs/go, /docs/zen; gateway route
  source anomalyco/opencode): chat/completions + responses use
  `authorization: Bearer`; /messages uses `x-api-key`; Gemini per-model
  endpoints (/v1/models/{id}:generateContent) use `x-goog-api-key`; models
  discovery at /v1/models.
- Live acceptance: chat/completions 200 (A2 Go, A1/A2 Zen *-free);
  responses 200 (A2 Go, gpt-5.6-luna); messages 200 (A2 Go, qwen3.7-max via
  x-api-key); Gemini per-model auth-validated but billing-gated
  (CreditsError ≠ AuthError) — no paid Zen traffic issued; invalid keys →
  401 AuthError on every family (negative controls).
- OMP catalog (installed): per-model api families — go: 20
  openai-completions / 2 openai-responses / 3 anthropic-messages; zen: 22
  openai-completions / 21 openai-responses / 13 anthropic-messages / 5
  google-generative-ai.
- Account 1 (Go): monthly usage limit exhausted → `429 GoUsageLimitError`
  (auth passed; credential-dependent quota state).
- Account 2 (Go): live completions (minimax-m3, mimo-v2.5, gpt-5.6-luna,
  qwen3.7-max, …).
- `north-mini-code-free` currently returns provider-401 upstream for both
  accounts (upstream issue; outside GoRouter's scope).

## Security decisions

- Keys: DPAPI per-user blobs; plaintext transits only short-lived stdin/stdout
  pipes of a spawned PowerShell process; never argv, logs, state.json, repo
  files, tests or handoffs.
- Local credential: random 32 bytes base64url, DPAPI-protected, validated by
  the router only; rotation path exists and is documented.
- Redaction helper applied to all log/CLI surfaces; journal stores no bodies,
  no Authorization values, no arbitrary headers.
- Test harness uses an in-memory secret store for speed; the real DPAPI store
  is exercised by CLI-lifecycle and round-trip tests.

## Windows/Bun operational notes

- Bun 1.3.14 segfaulted once under concurrent OMP streaming load
  (Bun-internal; not GoRouter code). Mitigations: secret cache pre-warm at
  serve start (no runtime DPAPI spawns), DPAPI spawn retry, unhandled
  rejection/exception guards that keep serving, and documented supervisor
  restart policy for persistent operation.
- `powershell.exe` is invoked by absolute System32 path — spawns from
  restricted-PATH supervisors (e.g. OMP's process launcher) otherwise fail.
