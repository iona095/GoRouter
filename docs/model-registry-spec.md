# Slice A — Dynamic Model Registry Core — Subsystem Spec

Owner: registry-engineer (t2). Audience: registry-engineer (t3), routing-engineer (t4), cli-engineer (t5), test-engineer (t6).
Date: 2026-08-26. Workspace: M:/AIFUN/GoRouter/ModelRegistry

## 1. Goal / Non-goals
Dynamic registry of upstream model catalogs (Go + Zen) that is refreshed periodically, cached on disk, served locally at /models, and never affects inference paths. No fallback, no model rewriting, no quota logic.

## 2. Placement & Persistence
- New package: `src/models/` with modules: `types.ts, fetcher.ts, registry.ts, diff.ts, refresh.ts, index.ts`.
- Persists under existing state dir via existing helpers (`src/paths.ts`):
  - Extend `Paths` with `modelsRegistryJson: join(state, "models-registry.json")` and `modelsDiffJson: join(state, "models-diff.json")` (or single file + inline diff). Preferred: single file `models-registry.json`; diff computed on demand from prev vs curr snapshot kept in same file as `lastDiff`. To avoid churn pick: registry file holds `go` and `zen` snapshots + `updatedAtUtc` + `lastAttempt` per lane + `lastDiff`.
  - If extending Paths is undesirable for review churn, registry module computes path as `join(paths.state, "models-registry.json")`. Either satisfies "using existing helpers" — use the join pattern that `paths.stateJson` already demonstrates.
- All writes via `atomicWriteJson` (src/util.ts) — temp+fsync+rename — so concurrent readers (server, CLI) never see half-written JSON. Schema validation on load; corrupt file => treat as no-registry (recoverable), log via `log.warn`, do not throw.

## 3. Schema
```ts
// src/models/types.ts
export const MODELS_SCHEMA_VERSION = 1;
export const MODELS_TTL_MS = 24 * 60 * 60 * 1000;      // 24h freshness
export const MODELS_COOLDOWN_MS = 5 * 60 * 1000;       // 5m retry cooldown after failure
export const MODELS_FETCH_TIMEOUT_MS = 15_000;

export interface ModelEntry { id: string; [k: string]: unknown; } // preserve upstream object verbatim, id is required key

export interface LaneSnapshot {
  fetchedAtUtc: string;          // ISO-8601 of successful fetch for this lane
  models: ModelEntry[];          // de-duplicated, validated, sorted by id for determinism
  rawHash?: string;              // optional stable hash of normalized models for change detection
}

export interface AttemptInfo {
  atUtc: string;
  success: boolean;
  httpStatus: number | null;
  error: string | null;          // redacted, bounded (slice 300)
  durationMs: number;
}

export interface RegistryFile {
  schemaVersion: number;         // == MODELS_SCHEMA_VERSION
  updatedAtUtc: string;          // time of last SUCCESSFUL transactional publish (both lanes)
  go: LaneSnapshot | null;       // null when never successfully fetched
  zen: LaneSnapshot | null;
  lastAttempt: { go: AttemptInfo | null; zen: AttemptInfo | null; combinedAtUtc: string | null; };
  lastDiff: DiffEntry[];         // diff between previous and current successful publish; empty on first publish
}

export type DiffKind = "MODEL_ADDED" | "MODEL_REMOVED" | "MODEL_CHANGED";
export interface DiffEntry { kind: DiffKind; lane: Lane; id: string; prev?: ModelEntry | null; curr?: ModelEntry | null; }
```

Upstream shape (both lanes): `GET {upstream}/models` -> `{ object:"list", data: ModelEntry[] }`. Normalizer accepts extra fields but requires `data` is array and every element has non-empty string `id`.

## 4. Validation & Edge Cases
- Malformed: non-JSON, missing/ non-array `data`, element without string `id`, empty id, non-object element -> treat lane fetch as failure.
- Duplicate ids within one lane: lane fetch fails (do not silently drop; surface as error). Duplicate across lanes is fine.
- Preserve unknown fields verbatim for CHANGED detection (deep equality via JSON.stringify of sorted keys).
- No secrets in registry file; do not persist Authorization values; log redaction via redact().

## 5. Fetcher (src/models/fetcher.ts)
- `fetchLane(lane, upstreamBase, signal?) => Promise<LaneSnapshot>` — direct fetch to upstream (`new URL("/models", upstreamBase)` or `${upstreamBase}/models`), bypasses localhost/GoRouter entirely (no loop). Uses `fetch(upstreamUrl, { method:"GET", headers:{ accept:"application/json" }, redirect:"manual", signal: AbortSignal.timeout(MODELS_FETCH_TIMEOUT_MS) })`. No local/account credential injection. Do not follow redirects. TLS validation on.
- Returns validated LaneSnapshot on 200+valid JSON; otherwise throws with message containing httpStatus.
- No retry inside fetcher; caller decides cooldown.

## 6. Registry I/O (src/models/registry.ts)
- `loadRegistry(paths) => RegistryFile | null` — existsSync check, readFileSync+JSON.parse, validate shape, fail to null on corrupt (caller treats as no-registry).
- `storeRegistry(paths, file) => void` — atomicWriteJson(registryPath, file).
- `registryAgeMs(file, nowMs) => number` — now - Date.parse(updatedAtUtc) (or max of lane fetchedAt).
- `isFresh(file, nowMs) => boolean` — age < TTL.
- `isCooldown(lastAttempt, nowMs) => boolean` — lastAttempt.success===false && (now - lastAttempt.atUtc) < COOLDOWN.
- `canRefresh(file, nowMs, forced) => boolean` — forced => !isCooldown unless bypass requested (see §7); non-forced => !isFresh && !isCooldown.
- Helpers exposed for CLI status and server cache logic.

## 7. Refresh Orchestrator (src/models/refresh.ts)
- Single-flight: module-level `inFlight: Promise<RefreshResult> | null`. Concurrent callers await same promise.
- Transactional Go+Zen: fetch both lanes in parallel (Promise.all). If either fails or validates fails, the whole refresh fails: previous RegistryFile is preserved on disk (no partial publish), `lastAttempt` is updated with per-lane AttemptInfo + error, file is still atomically written to record the failure (so cooldown applies) but `updatedAtUtc/go/zen` stay on previous known-good. On success both lanes validated, compute diff vs previous (diff.ts), then atomically publish new RegistryFile with new updatedAtUtc + new lane snapshots + lastDiff + success attempts.
- TTL / cooldown semantics:
  - Success resets TTL (updatedAtUtc = now).
  - Failure does NOT reset TTL — age continues from last successful updatedAtUtc. Only lastAttempt timestamps advance, entering cooldown window.
  - Forced refresh (`force=true` from CLI `models refresh`) bypasses TTL check but still respects? Spec: "refresh is forced (bypass TTL)" — so forced bypasses TTL and also bypasses cooldown? Required Tests bullet says cooldown, forced refresh. Safer: forced bypasses TTL but NOT cooldown unless explicitly forced+cooldown-bypass is not needed. Clarify: forced means ignore isFresh, but if last failure is within cooldown, still block unless forced explicitly wants to hammer upstream. Task says "refresh is forced (bypass TTL)" — imply forced ignores freshness but should still honor cooldown? Check test expectations (auditor): "refresh storms" suggests cooldown must hold even for forced? Actually CLI forced should bypass both TTL and cooldown to let operator retry — but with single-flight it still won't storm. Decision: forced bypasses isFresh only; cooldown still enforced UNLESS caller passes force+ignoreCooldown. For CLI `models refresh`, we bypass TTL but keep 5m cooldown? The task t5 says "refresh is forced (bypass TTL) and returns non-zero on failure." — suggests it bypasses TTL. For tests we make forced bypass TTL, cooldown is separate check that forced can optionally bypass? Provide option `{ force:boolean }` where force ignores freshness but cooldown still applies; add `force` path for CLI that wants to bypass TTL only. Expose `shouldRefresh({forced})` accordingly. Test harness can use fake clock to advance past cooldown.
- Startup trigger: `maybeRefreshOnStartup(paths, state, opts)` — if file missing or !isFresh, fire background refresh (do not block serve). Use detached promise, log result.
- Return type: `type RefreshResult = { success:boolean; registry: RegistryFile | null; error?: string; fromCache?: boolean; diff?: DiffEntry[] }`.

## 8. Diff (src/models/diff.ts)
- `computeDiff(prev: RegistryFile | null, curr: RegistryFile) => DiffEntry[]`
- Per lane, build Map id->entry for prev and curr. For each id:
  - in curr not in prev => MODEL_ADDED
  - in prev not in curr => MODEL_REMOVED
  - in both but JSON.stringify(sortedKeys(prevEntry)) !== JSON.stringify(sortedKeys(currEntry)) => MODEL_CHANGED
- No fake changes: reordering alone does not produce diff (maps), identical deep equality produces zero entries for that id.
- Deterministic output sorted by lane, kind, id.

## 9. Server Integration (for routing-engineer, t4)
- Intercept ONLY exact paths `/go/v1/models` and `/zen/v1/models` (with optional query string preserved but not used for cache key). Other /models subpaths (e.g. /models/{id}:generateContent) are inference and must NOT be intercepted.
- Auth preserved: validate local credential exactly as other lanes (same validateLocalAuth) before serving cache. Do not inject account key for models cache responses; upstream fetch already went direct.
- Cache logic (uses registry.ts helpers):
  - no registry file / corrupt / go|zen snapshot null => proxy through to upstream (existing dispatch path) — do not synthesize empty list.
  - fresh (age < TTL) => serve from registry snapshot for that lane as JSON `{ object:"list", data: models }` with 200, add header `x-gorouter-models-cache: hit` and `x-gorouter-models-age-ms`.
  - stale (age >= TTL) and not in cooldown => trigger background refresh (single-flight) but immediately serve stale snapshot (stale-while-revalidate) with `x-gorouter-models-cache: stale`.
  - stale and in cooldown or refresh in-flight failure => serve stale snapshot with `x-gorouter-models-cache: stale`.
  - On refresh success, subsequent requests see new data.
- Never intercept /chat/completions, /responses, /messages, etc.
- For tests: injectable now() and fetcher for determinism; do not add new journal terminalOutcome; existing journal behavior unchanged (models cache hits may optionally journal as endpointFamily=models with local outcome — keep consistent with current classifyEndpointFamily).

## 10. CLI (for cli-engineer, t5)
- Commands: `gorouter models status|list|refresh|diff`
- `models status` (default): prints registry state (exists/corrupt/fresh/stale), updatedAtUtc, ageMs, TTL threshold, lastAttempt per lane (at, success, httpStatus, error redacted), retry eligibility (cooldown remaining), counts per lane, lastDiff summary. JSON with --json.
- `models list [--lane go|zen] [--json]` — lists models for lane(s). Default human readable: one id per line grouped by lane; --json prints { go:[...], zen:[...] }.
- `models refresh [--json]` — forced=true, bypass TTL, awaits single-flight, prints success/failure, returns exit 1 on failure. Respects cooldown? Prints cooldown remaining if blocked.
- `models diff [--json]` — shows lastDiff from registry file. Human: "lane id KIND" lines; JSON: array of DiffEntry. Empty => "no changes".
- Extend USAGE, handle unknown subcommand, requireNoExtra.

## 11. Tests (for test-engineer, t6)
Deterministic via fake clock (Date.now mock) and fake fetcher (injected fetch function). Cover: TTL fresh vs stale, cooldown block vs eligible after 5m, forced bypasses TTL, failure preserves known-good + does not reset TTL, single-flight coalesces concurrent refreshes to one fetch per lane, transactional: one lane fails => no publish, malformed JSON / missing data / duplicate ids => lane failure => transactional failure, diff kinds and no-fake-changes, atomic write failure handling, /models cache fresh/stale/no-registry behaviors, auth preserved on /models (401 without local cred), inference paths still proxied.

## 12. Audit Hard Cases (for auditor, t7)
Partial publication, lost known-good on failure, TTL reset on failure, refresh storms via parallel requests/CLI, single-flight races, auth leakage via fetcher, self-fetch loop (fetcher must not call localhost), Windows atomic replace (atomicWriteJson), corrupt registry recovery, schema drift, inference regressions.

## 13. Implementation Order
1) types + diff (pure), 2) fetcher (direct), 3) registry I/O + validation, 4) refresh with single-flight+transaction, 5) export via index.ts, 6) server+CLI wire (separate tasks). Keep inference routing untouched until t4.

---
References: src/state.ts (STATE_SCHEMA_VERSION, atomicWriteJson), src/paths.ts (resolvePaths, ensureStateDirs), src/util.ts (atomicWriteJson, log, redact, monotonicMs, utcNow), src/server.ts (LANE_PREFIX, validateLocalAuth, dispatch, handler), src/journal.ts (endpointFamily), src/cli.ts (USAGE, domain delegation pattern).
