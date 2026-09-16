# GoRouter Wire Inspector — Synthetic Wire Diagnostic Manual

A local, synthetic-only diagnostic tool that shows exactly what GoRouter v1.0.0
sends upstream and exactly what it returns to the client — without contacting
any real provider.

It observes both directions:

```text
CLIENT → GOROUTER → SYNTHETIC UPSTREAM        (request direction)
SYNTHETIC UPSTREAM → GOROUTER → CLIENT        (response direction)
```

Wire Inspector is intentionally separate from GoRouter itself. It does not
modify GoRouter v1.0.0, is not part of the released artifact, and does not
ship with it. The released binary remains
`M:\AIFUN\GoRouter\Main\dist\gorouter.exe`.

---

## 1. What Wire Inspector can answer

Concrete questions it settles from retained sanitized evidence:

- Does GoRouter preserve `x-opencode-session`?
- Does it preserve `User-Agent`?
- Which session/correlation headers are forwarded, and which are consumed locally?
- Does GoRouter rewrite request bodies (model, messages/input, stream)?
- Does it change `tools`, `tool_choice`, or sampling parameters?
- Does it replace inbound Authorization with a provider credential?
- How do GO and ZEN differ on the wire?
- Are provider response bodies altered (JSON byte-for-byte, SSE event-for-event)?
- Are 400/401/422/429/500 responses preserved?
- Are `retry-after` and `x-ratelimit-*` headers preserved?

---

## 2. Safety model

- **Synthetic credentials only.** Requests use hardcoded test keys
  (`WI01-SYNTHETIC-*-TEST-ONLY-*`, `WI02-SYNTHETIC-*-TEST-ONLY-*`). No real
  OpenCode or provider credential is ever loaded or sent.
- **Synthetic GoRouter state only.** Each run builds an isolated state dir
  under `tools/wire-inspector/output/.wi-state-<run-id>` (removed afterwards). If
  `GOROUTER_STATE_DIR` points outside the tool directory, the run refuses to start.
- **Loopback-only upstream.** Every upstream destination must be plain HTTP on
  `127.0.0.1`, `localhost`, or `::1` with no userinfo. Anything else —
  public IPs, provider DNS, `opencode.ai`, HTTPS — is refused fail-closed.
- **No real provider contact.** Destinations are loopback, redirects are never
  followed (`redirect: "manual"`), and nothing relays traffic onward.
- **No TLS MITM, no root certificate.** Only plain-HTTP loopback is used, so
  there is nothing to intercept.
- **Endpoint-only fixture, not a proxy.** The capture server binds
  `127.0.0.1` on an ephemeral port, answers scripted responses directly, and
  refuses `CONNECT` (HTTP 405). It performs no onward fetch and emits no
  redirects.
- **Redaction before disk write.** Credential-shaped headers and body keys are
  stored as `Bearer <REDACTED>` / `<REDACTED>` plus safe metadata (scheme,
  length, presence). Raw credential values never reach retained output; runs
  abort before writing if a synthetic literal would leak.
- **Released GoRouter files unchanged.** The inspector only reads the released
  product; test evidence confirms Main HEAD/tree and `gorouter.exe` SHA256
  are untouched.

Why this instead of Fiddler/mitmproxy against a real account? A real-account
capture handles live credentials, real traffic, and a TLS break-and-inspect
setup — each a leak and cost risk. Wire Inspector replaces all three with
deterministic synthetic traffic on loopback that is redacted by construction,
so the resulting evidence can be kept and compared safely.

No absolute guarantee is claimed beyond what the implementation enforces and
the tests prove (see Testing).

## 3. Installation / prerequisites

- **Bun** (GoRouter's runtime; tested with Bun 1.3.x). Bun runs the
  TypeScript sources directly — there is no build step and no required
  install command. (`package.json` declares only dev tooling and the
  `bun test` script; no Node/npm workflow is documented or needed.)
- Windows 11 with PowerShell for the examples below.

Launcher (in the project root):

Ways to run it (all equivalent for source mode):

```powershell
cd M:\AIFUN\GoRouter\Main

# via repository scripts
bun run test:wire-inspector            # full Wire Inspector test suite
bun run build:wire-inspector           # build gorouter-wire-inspector.exe to scratch

# direct source invocation
bun tools/wire-inspector/src/cli.ts <command> [args]

# via the Windows launcher inside the tool directory
.\tools\wire-inspector\wire-inspector.cmd <args>

# via the compiled companion (no Bun required, see below)
.\dist\gorouter-wire-inspector.exe <command> [args]
```

`wire-inspector.cmd` runs `bun "<script-dir>\src\cli.ts"` with your arguments
(requires `bun` on PATH).

> Output paths: `--out` is resolved relative to the tool directory
> (`tools/wire-inspector/`), not your shell's working directory.
> The default is `output\`.

---

## 4. Quick start

```powershell
cd M:\AIFUN\GoRouter\Main

# What request scenarios exist?
.\tools\wire-inspector\wire-inspector.cmd scenarios

# Run one request-direction scenario (GO chat, streaming)
.\tools\wire-inspector\wire-inspector.cmd run --scenario chat-completions-stream
# → output\run-<id>\run-summary.md, inbound/outbound/diff files

# Run the whole request matrix (all 6 scenarios + aggregates)
.\tools\wire-inspector\wire-inspector.cmd matrix
# → output\matrix-<id>\

# Run the whole response matrix (all 10 scenarios + aggregates)
.\tools\wire-inspector\wire-inspector.cmd response-matrix
# → output\response-matrix-<id>\
```

---

## 5. CLI reference

| Command | Direction | Purpose | Output |
|---|---|---|---|
| `capture [--port N]` | fixture | Start the loopback capture endpoint (default ephemeral port) and print its fixture definition as JSON. Stays up until Ctrl-C. | stdout JSON (`syntheticUpstreamBase`, `loopbackOnly`, `endpointOnly`, `proxy: false`, …) |
| `scenarios` | — | List the six registered request scenarios with lane, client path, and support/evidence lines. | stdout |
| `run [--scenario ID] [--out DIR]` | request | Run one request scenario (default `chat-completions-stream`). Unknown IDs fail closed. | `output\run-<id>\` |
| `matrix [--out DIR]` | request | Run all six request scenarios, each with fresh isolated state, plus aggregate reports. | `output\matrix-<id>\` |
| `diff <inbound.json> <outbound.json>` | request | Recompute the semantic diff of two retained request records; prints human-readable text then JSON. Exits 2 when args are missing. | stdout |
| `response-scenarios` | — | List the ten registered response scenarios with lane, kind, status, and path. | stdout |
| `response-run --scenario ID [--out DIR]` | response (+request evidence) | Run one response scenario (default `chat-json-200`). Unknown IDs fail closed. | `output\response-<id>\` |
| `response-matrix [--out DIR]` | response (+request evidence) | Run all ten response scenarios plus aggregate reports. | `output\response-matrix-<id>\` |

In PowerShell, prefix every command below with `.\tools\wire-inspector\wire-inspector.cmd` (or call `bun tools/wire-inspector/src/cli.ts` directly with the same arguments).

Unknown commands print `unknown command '<cmd>'` plus usage (exit 2). Any
failure prints `wire-inspector <cmd> failed: <reason>` (exit 1).
Unknown scenario IDs fail with `unknown scenario '<name>'` /
`unknown response scenario '<id>'` and never silently substitute another
scenario.

---

## Companion executable (`gorouter-wire-inspector.exe`)

The tool compiles to a standalone Windows x64 executable with the same
registries and safety enforcement as source mode — no reduced implementation:

```powershell
cd M:\AIFUN\GoRouter\Main
bun run build:wire-inspector
# → stages gorouter-wire-inspector.exe in .build-work-wire-inspector/
#   (never overwrites dist/gorouter.exe; promotion into dist/ is a
#   separately authorized step, never part of the build)
```

The compiled companion needs no Bun on the operator PATH:

```powershell
.\dist\gorouter-wire-inspector.exe scenarios
.\dist\gorouter-wire-inspector.exe matrix --out C:\temp\wi-out
```

Use an absolute, isolated `--out` directory so synthetic state and evidence
stay out of the repository. `gorouter.exe` itself gains no diagnostic
commands — production and diagnostic binaries stay separate:

```text
gorouter.exe                  production/runtime
gorouter-wire-inspector.exe   synthetic diagnostics only
```

## 6. Request inspection (`CLIENT → GOROUTER → SYNTHETIC UPSTREAM`)

Each `run` records the synthetic client request it sent and the exact
request the loopback fixture received from GoRouter, then diffs them:

- method, path, query, headers (original casing preserved, diffed
  case-insensitively), body, body SHA256, client/GoRouter/upstream endpoints,
  route/lane, synthetic account alias and model (`scenario.json`).

Header/body classifications used by the implementation:

- `UNCHANGED` — byte-identical (or absent both sides)
- `ADDED BY GOROUTER` — outbound only
- `REMOVED BY GOROUTER` — inbound only
- `CHANGED BY GOROUTER` — value differs
- `ROUTING-ONLY / NOT FORWARDED` — consumed locally (e.g.
  `x-gorouter-correlation-id`)
- `TRANSPORT-DERIVED` — framing/authority rewrite (`host`,
  `content-length`, `accept-encoding`, `connection`, …)
- `REDACTED` — credential-bearing header; values never compared on disk
  (equality is not asserted on redacted values)

Focused verdicts:

- `x-opencode-session`: `PRESERVED_UNCHANGED` / `REMOVED` / `CHANGED` /
  `ABSENT_INBOUND` / `ABSENT_OUTBOUND`
- `User-Agent`: `PRESERVED_UNCHANGED` / `CHANGED` / `REMOVED`
- Authorization: `REPLACED_BY_GOROUTER` / `PRESERVED_UNCHANGED` /
  `REMOVED` / `ADDED` / `ABSENT_BOTH` (presence/scheme/length only;
  on already-sanitized inputs the run-mode in-memory proof governs)
- Body: added/removed/changed JSON paths plus per-field verdicts for model,
  messages/input, stream, tools, tool_choice, reasoning, sampling.

---

## 7. Request scenarios (`src/scenarios.ts`)

`--scenario` selects real request bytes, not a report label.

| Scenario | Lane | Client route → upstream shape | Notable fields | Reveals |
|---|---|---|---|---|
| `chat-completions-stream` | go | `POST /go/v1/chat/completions` → `/chat/completions` | `stream:true`, `WI01-SESSION-001`, `WI01-Synthetic-Client/1.0` | WI01 baseline behavior |
| `responses-basic` | go | `POST /go/v1/responses` → `/responses` | `model` + string `input`, `stream:false` | responses-family handling vs chat |
| `messages-basic` | go | `POST /go/v1/messages` → `/messages` | `x-api-key` auth, `anthropic-version: 2023-06-01`, `max_tokens: 8` | Anthropic auth family (no `authorization` header) |
| `chat-completions-rich` | go | `POST /go/v1/chat/completions` → `/chat/completions` | `tools` (`wi02_weather`), `tool_choice:auto`, `temperature:0.2`, `top_p:0.9`, `max_tokens:16` | rich-body passthrough |
| `header-matrix` | go | `POST /go/v1/chat/completions` → `/chat/completions` | nine deterministic correlation/client headers (next section) | per-header forward/consume behavior |
| `zen-chat-baseline` | zen | `POST /zen/v1/chat/completions` → `/chat/completions` | ZEN account/model/session markers | GO-vs-ZEN comparison |

Route shapes follow the released product's endpoint families
(`/chat/completions`, `/responses`, `/messages`) and lane prefixes
(`/go/v1`, `/zen/v1`); each registry entry records its source evidence.
All six currently report `SUPPORTED_CAPTURED`.

---

## 8. Header matrix

These headers are evaluated independently — they are not interchangeable:

```text
x-opencode-session
x-client-request-id
x-session-id
x-session-affinity
x-gorouter-correlation-id
x-wi02-test
User-Agent
Accept
Content-Type
Authorization
```

Observed in the current synthetic matrix (not universal guarantees):

```text
x-opencode-session        preserved unchanged
x-client-request-id       preserved unchanged
x-session-id              preserved unchanged
x-session-affinity        preserved unchanged
x-gorouter-correlation-id consumed locally / not forwarded
x-wi02-test               preserved unchanged
User-Agent                preserved unchanged
Accept / Content-Type     preserved unchanged
Authorization/x-api-key   replaced by GoRouter (values redacted)
```

Note: `messages-basic` shows `authorization: absent-both` because that
family authenticates via `x-api-key` (redacted/replaced there) — see its
per-scenario diff, not just the matrix column.

## 9. Rich request inspection

`chat-completions-rich` sends `model`, `messages`, `stream:false`,
one synthetic function tool (`wi02_weather` with a tiny `{city}` schema),
`tool_choice: "auto"`, `temperature: 0.2`, `top_p: 0.9`, and
`max_tokens: 16`. Retained evidence shows each arriving upstream unchanged
(`added/removed/changed: none`).

```text
Reasoning control was not represented in the released request contract used by WI02.
```

No reasoning field is sent, because none was found in the released request
contract (catalog `reasoningEfforts` entries are model metadata, not request
fields). This says nothing about GoRouter behavior outside the tested request
contract.

---

## 10. GO vs ZEN

Both lanes are exercised against the same loopback base with distinct
synthetic accounts; client paths differ only by lane prefix (`/go/v1/…` vs
`/zen/v1/…`), which GoRouter strips when rebasing onto the upstream base.
The GO-vs-ZEN reports (`go-zen-compare.md`,
`go-zen-response-compare.md`) compare session handling, User-Agent handling,
auth semantics, body/event preservation, and prefix stripping from actual
captures. In the tested scenarios the only differences are account and
lane-prefix routing — no request-body/header or response transformation
difference was observed.

---

## 11. Response inspection (`SYNTHETIC UPSTREAM → GOROUTER → CLIENT`)

Each `response-run` scripts a deterministic upstream response, sends the
scenario's real request through GoRouter, and captures what the client
actually receives:

- upstream status / client status (`STATUS_PRESERVED` vs `STATUS_CHANGED`)
- headers both sides (tracked: `content-type`, `content-length`,
  `transfer-encoding`, `connection`, `cache-control`, `x-request-id`,
  `x-wi03-upstream`, `retry-after`, three `x-ratelimit-*`, `server`,
  `date` — plus anything else observed)
- body bytes both sides with SHA256 (logical + canonical-JSON hashes)
- JSON semantic diff (added/removed/changed paths)
- SSE parsed events, fixture write sizes, client stream read sizes

Response header verdicts: `PRESERVED_UNCHANGED` / `CHANGED_BY_GOROUTER` /
`REMOVED_BY_GOROUTER` / `ADDED_BY_GOROUTER` (`x-gorouter-request-id`) /
`TRANSPORT_DERIVED` (`date`, `server`, `content-length`,
`transfer-encoding`, `connection`, … — runtime framing, never an
application rewrite without evidence) / `REDACTED` / `ABSENT_BOTH`.

JSON body verdicts: `BYTE_IDENTICAL` (exact bytes equal) /
`SEMANTICALLY_IDENTICAL` (canonical JSON equal, byte order/whitespace
differ) / `CHANGED` (with JSON paths). Byte identity is only claimed from
measured byte equality, never inferred from canonical equality.

---

## 12. Response scenarios (`src/response-scenarios.ts`)

| Scenario | Request (lane) | Scripted upstream response | Purpose |
|---|---|---|---|
| `chat-json-200` | chat, `stream:false` (go) | 200 JSON `{id, object, model, choices, usage}`; `x-request-id: WI03-UPSTREAM-REQ-CHAT-200`, `x-wi03-upstream: chat-json-200`, `cache-control: no-store` | JSON success propagation |
| `chat-sse-200` | chat, `stream:true` (go) | 200 SSE, 3 writes (two chat-chunk JSON payloads + `data: [DONE]`); `no-cache` | SSE preservation baseline |
| `responses-sse-200` | `/responses` (go) | 200 SSE (`response.created` → `output_text.delta` → `completed`) | responses-family transparency |
| `messages-sse-200` | `/messages`, Anthropic auth (go) | 200 SSE (`message_start` … `message_stop` named events) | messages-family transparency, no OpenAI conversion |
| `zen-chat-sse-200` | chat, `stream:true` (zen) | same logical SSE bytes as `chat-sse-200` (own request-id) | GO-vs-ZEN response comparison |
| `error-400` | chat (go) | 400 `{error:{type: synthetic_bad_request, …}}`, `x-request-id: WI03-ERR-400` | error-status propagation |
| `error-401` | chat (go) | 401 synthetic auth error, `WI03-ERR-401` | error-status propagation (synthetic provider fiction) |
| `error-422` | chat (go) | 422 synthetic validation error, `WI03-ERR-422` | error-status propagation |
| `error-429` | chat (go) | 429 synthetic rate-limit error + `retry-after: 7`, `x-ratelimit-limit-requests: 100`, `x-ratelimit-remaining-requests: 0`, `x-ratelimit-reset-requests: 7s` | retry/rate-limit preservation |
| `error-500` | chat (go) | 500 synthetic internal error, `WI03-ERR-500` | error-status propagation |

Each scenario owns the exact bytes the fixture emits — the fixture never
sniffs request bodies to pick a response.

## 13. SSE inspection: bytes vs events vs chunks

Three independent comparisons, because they mean different things:

- **Logical response bytes** — the concatenated stream bytes, hashed
  (`LOGICAL_BYTES_IDENTICAL` / `LOGICAL_BYTES_CHANGED`). This is the
  content verdict.
- **SSE event sequence** — parsed `event:`/`data:` ordering and payloads
  (`SSE_EVENT_SEQUENCE_IDENTICAL` / `SSE_EVENT_SEQUENCE_CHANGED`). This
  is the protocol verdict.
- **Transport chunking** — fixture write sizes vs client read sizes
  (`TRANSPORT_CHUNKING_IDENTICAL` / `TRANSPORT_CHUNKING_DIFFERENT`). This
  is runtime timing detail. A runtime may split or coalesce stream reads
  without changing content; chunking differences alone never fail a scenario.

The built-in parser (`src/sse.ts`) supports `event:`, `data:`,
`id:`, `retry:`, `:` comments, multiple `data:` lines per event
(joined with newline), blank-line event termination, and preserves
`data: [DONE]` as ordinary content. Payloads are never normalized.

---

## 14. Error propagation

The 400/401/422/429/500 scenarios observe ordinary client-facing proxy
behavior: the scripted status, headers, and JSON body are expected at the
client unchanged. These observations must not be confused with any historical
probe-auth classification rules — WI03 classifies wire propagation only
(`STATUS_PRESERVED`, `HEADER_PRESERVED/REMOVED/CHANGED`,
`BODY_PRESERVED/CHANGED`).

429 specifics (all preserved in retained evidence): `retry-after: 7`,
`x-ratelimit-limit-requests: 100`,
`x-ratelimit-remaining-requests: 0`,
`x-ratelimit-reset-requests: 7s`, plus `x-request-id: WI03-ERR-429` and a
byte-identical JSON body.

---

## 15. Reading the output

Request runs — `output\run-<id>\`:

| File | Contents |
|---|---|
| `run-summary.md` | scenario, lane, outcome, session/User-Agent/Authorization verdicts, upstream host, external NONE |
| `inbound.sanitized.json` | synthetic client request (redacted): method/path/query/headers/body/hash/endpoints |
| `outbound.sanitized.json` | exact loopback-captured GoRouter emission (redacted) |
| `diff.sanitized.json` | full semantic diff (headers, session/UA/auth proofs, body paths) |
| `diff.txt` | human-readable diff |
| `runtime-record.md` | loopback proof, timings, cleanup, no-external-traffic evidence |
| `scenario.json` | lane, paths, account alias, model, route evidence, outcome |

Request matrix — `output\matrix-<id>\`: one subdirectory per scenario
(same seven files) plus `matrix-summary.md` (compact comparison, header
matrix, body matrix, outcome table), `matrix.sanitized.json` (rebuilt by
re-reading the retained per-scenario diffs), and `go-zen-compare.md`.

Response runs — `output\response-<id>\` and
`output\response-matrix-<id>\<scenario>\`:

| File | Contents |
|---|---|
| `request-inbound/outbound/diff.sanitized.json` | request-direction causality proof (fixture was reached) |
| `upstream-response.sanitized.json` | scripted response: status/headers/kind/body-or-events/SHA/fixture write sizes |
| `client-response.sanitized.json` | received response: status/statusText/headers/body/SHA/parsed events/client read sizes |
| `response-diff.sanitized.json` | status/header/body verdicts |
| `response-diff.txt` | human-readable response diff |
| `response-summary.md` | scenario/lane/outcome/statuses/body verdict |
| `runtime-response-record.md` | loopback proof, write/read sizes, cleanup |
| `response-scenario.json` | lane, paths, account, statuses, outcome, observation profile |

Response matrix root adds `response-matrix-summary.md` (aggregate,
status, header, SSE, and outcome tables), `response-matrix.sanitized.json`,
`go-zen-response-compare.md`, and `family-response-compare.md`.

## 16. How to answer common questions

### Does GoRouter send my session header?

Run the scenario family you care about, open its `diff.txt`, and read the
`x-opencode-session:` verdict plus the inbound/outbound values. The matrix
header row shows it across all families at once.

### Does GoRouter send my client/User-Agent?

Same place: the `User-Agent:` verdict in `diff.txt` (observed, never
assumed).

### Is GoRouter rewriting my prompt/body?

Compare `bodySha256` in `inbound/outbound.sanitized.json` and read the
added/removed/changed JSON paths plus the per-field verdicts
(model, messages/input, stream, tools, …) in `diff.sanitized.json`.

### Does GoRouter alter tools or sampling?

Run `.\tools\wire-inspector\wire-inspector.cmd run --scenario chat-completions-rich` and inspect its
body diff: `tools`, `tool_choice`, and `sampling`
(`temperature`/`top_p`/`max_tokens`) each carry their own verdict.

### What does GoRouter do with Authorization?

Read the `Authorization:` section of `diff.txt`: presence/scheme/length
both sides plus the classification (e.g. `REPLACED_BY_GOROUTER`). Values
are always `Bearer <REDACTED>` — replacement is proven in memory during the
run, never by comparing stored secrets.

### Are rate-limit headers preserved?

Run `.\tools\wire-inspector\wire-inspector.cmd response-run --scenario error-429` and read
`response-diff.txt`: `retry-after` and the three `x-ratelimit-*`
headers each show `PRESERVED_UNCHANGED` with upstream/client values.

### Is SSE modified?

Open the scenario's `response-diff.txt`: trust `sse logical bytes` and
`sse event sequence`; treat `transport chunking` as timing detail. The
upstream/client event-name lists let you confirm order directly.

### Is GO different from ZEN?

Read `go-zen-compare.md` (request) and `go-zen-response-compare.md`
(response): they answer session, User-Agent, auth, body/event, and
prefix-stripping sameness from the paired captures.

---

## 17. Observed GoRouter v1.0.0 behavior (synthetic evidence, not guarantees)

Observed behavior from the current synthetic WI02/WI03 matrices:

Request direction:

- lane prefix removed and rebased onto the upstream base
  (`/go/v1/…` or `/zen/v1/…` → `/…`);
- inbound local Authorization replaced with the provider credential
  (messages family: `x-api-key` instead of `authorization`);
- `x-gorouter-correlation-id` consumed locally, never forwarded;
- tested session/client/correlation headers otherwise preserved unchanged;
- tested request bodies semantically unchanged (rich fields included);
- GO/ZEN transformation semantics equivalent in the tested cases.

Response direction:

- tested statuses preserved (200/400/401/422/429/500);
- tested provider headers preserved (`content-type`, `cache-control`,
  `x-request-id`, `x-wi03-upstream`, `retry-after`, `x-ratelimit-*`);
- `x-gorouter-request-id` added by GoRouter;
- framing differences (`content-length`, `transfer-encoding`,
  `connection`, `date`) are transport-derived, not rewrites;
- tested JSON bodies byte-identical; tested SSE logical bytes and event order
  identical across chat/responses/messages and GO/ZEN;
- no family-specific response rewrite observed in the tested scenarios.

Each claim above is scoped to the synthetic scenarios listed in this manual.
They are observations from retained evidence, not universal protocol
guarantees.

---

## 18. Testing

```powershell
cd M:\AIFUN\GoRouter\Main
bun run test:wire-inspector     # Wire Inspector suite (fast + contract matrices)
bun test                        # full repository suite (production + Wire Inspector)
```

Current: **77 pass, 0 fail, 778 expect() calls, 10 test files** (verified at
time of writing). Groups covered: redaction, loopback-only enforcement,
request/response scenario registries, unknown-ID fail-closed, header
normalization, session/User-Agent/auth semantics, JSON semantic diff, SSE
parsing (multi-line data, comments, `[DONE]`, ordering), logical-vs-chunking
separation, capture endpoint non-proxy behavior, full request and response
matrices derived from retained evidence, secret-literal scans, and released
product preservation (Main HEAD/tree, `gorouter.exe` hash).

---

## 19. Troubleshooting

Only the messages below (exact text) are documented; anything else needs
source inspection.

| Symptom | Meaning / action |
|---|---|
| `unknown scenario '<name>'` / `unknown response scenario '<id>'` | ID is not in the registry — check spelling against `scenarios` / `response-scenarios` output. Nothing ran. |
| `unknown command '<cmd>'` | Not a CLI command — see CLI reference. |
| `usage: wire-inspector diff <inbound.json> <outbound.json>` | `diff` needs two file arguments. |
| `WI01 refuses non-loopback upstream host '…'` / `… non-http upstream …` / `… provider host 'opencode.ai' …` / `… upstream URL with embedded userinfo` | Destination violates loopback-only policy; use `http://127.0.0.1:<port>`. |
| `WI01 refuses to run with GOROUTER_STATE_DIR='…'` | Unset the variable or point it inside the tool directory. |
| `WI capture server is an endpoint, not a proxy (CONNECT refused)` (405) | Something sent `CONNECT`; the fixture never tunnels. Check the client. |
| Outcome `SUPPORTED_REJECTED_BY_TEST_INPUT` | GoRouter rejected the request locally (e.g. 4xx) with zero upstream bytes — recorded, not a capture PASS. Inspect client status/body in the scenario dir. |
| Outcome `HARNESS_FAILURE` | No fixture hit and no local rejection — inspect `runtime-record.md` / `runtime-response-record.md` stop errors. |
| `TRANSPORT_CHUNKING_DIFFERENT` | Normal: fixture writes and client reads split differently. Content verdicts (logical bytes, event order) govern. |
| Pre-write abort mentioning a synthetic literal reaching disk | Redaction caught a leak before any write — no output was produced; report the scenario and message. |
| Port already occupied | Both servers bind ephemeral ports; a collision fails fast at startup — just rerun. |
| `output\<name>` already exists | Re-runs use fresh timestamped ids; if you passed an explicit existing id/dir, pick another. |

---

## 20. Limitations

- Fixture behavior is synthetic; nothing here verifies real provider behavior
  or constitutes live OpenCode acceptance testing.
- No production HTTPS is decrypted, intercepted, or inspected.
- Traffic from arbitrary external processes is not captured automatically —
  only the inspector's own synthetic client flows.
- Coverage is exactly the listed scenarios: untested headers, bodies, and
  provider responses are unproven.
- Findings describe the tested GoRouter v1.0.0 paths/scenarios and must not
  be treated as a universal protocol conformance suite.

---

## 21. Project boundaries

```text
WireInspector is not part of the released GoRouter v1.0.0 artifact.
```

It is a separate local diagnostics project under
`M:\AIFUN\GoRouter\Main\tools\wire-inspector\`. It does not ship with GoRouter, does
not modify GoRouter, and starts no release cycle.

---

## 22. Architecture / source map

```text
src/scenarios.ts           six executable request scenarios + route evidence
src/response-scenarios.ts  ten scripted response scenarios (status/headers/JSON-or-SSE-writes)
src/run.ts                 request-direction run: isolated state → GoRouter → loopback capture → sanitized diff
src/response-run.ts        response-direction run: scripted fixture → GoRouter → streamed client capture → diff
src/matrix.ts              WI02 matrix runner + aggregates derived from retained diffs
src/response-matrix.ts     WI03 matrix runner + status/header/SSE/GO-ZEN/family aggregates
src/capture-server.ts      loopback endpoint-only fixture (record requests; scripted or legacy replies)
src/diff.ts                request semantic diff (headers/session/UA/auth/body paths)
src/response-diff.ts       response diff (status/headers/JSON-byte-vs-semantic/SSE/chunking)
src/redaction.ts           pre-write redaction for credential-shaped headers/body keys
src/normalize.ts           header normalization, canonical JSON, body-path flattening, SHA256
src/sse.ts                 deterministic SSE parser (event/data/id/retry/comments/[DONE])
src/loopback.ts            loopback-only URL enforcement (fail-closed)
src/cli.ts                 all CLI commands above
wire-inspector.cmd         Windows launcher (bun src\cli.ts, tool-relative)
```

Tests live in `tests\` (one file per area above); fixtures in
`fixtures\`; evidence accumulates under `output\` and is never rewritten
in place.
