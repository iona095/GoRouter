/**
 * B.1 — Semantic diff tests (test/dsh-semantic-diff.test.ts)
 *
 * Covers src/models/diff.ts computeDiff semantics:
 *  - created-only churn is NOT a MODEL_CHANGED (top-level `created` ignored)
 *  - object / owned_by / unknown-future-field deltas ARE MODEL_CHANGED
 *  - add/remove detection
 *  - deterministic ordering
 *  - raw entries (incl. created) preserved through storeRegistry/loadRegistry
 *  - end-to-end refreshRegistry with mocked fetchFn: unchanged catalog
 *    (only created advanced) yields zero-diff lastDiff in the persisted registry
 */
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePaths, ensureStateDirs } from "../src/paths.ts";
import {
  MODELS_SCHEMA_VERSION,
  type RegistryFile,
  type ModelEntry,
  type DiffEntry,
  type LaneSnapshot,
} from "../src/models/types.ts";
import { registryPathFor, loadRegistry, storeRegistry } from "../src/models/registry.ts";
import { computeDiff } from "../src/models/diff.ts";
import { refreshRegistry, clearRefreshSingleFlightForTests } from "../src/models/refresh.ts";
import type { FetchFn } from "../src/models/fetcher.ts";

// ---------------------------------------------------------------------------
// Helpers (mirror test/dsh-sync.test.ts conventions)
// ---------------------------------------------------------------------------

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function freshPaths() {
  const dir = mkdtempSync(join(tmpdir(), "gorouter-difftest-"));
  dirs.push(dir);
  const paths = resolvePaths(dir);
  ensureStateDirs(paths);
  return { dir, paths };
}

function makeModel(id: string, extra: Record<string, unknown> = {}): ModelEntry {
  return { id, object: "model", ...extra } as ModelEntry;
}

function snap(models: ModelEntry[], atIso = "2026-01-01T00:00:00.000Z"): LaneSnapshot {
  return { fetchedAtUtc: atIso, models: [...models].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) };
}

function regFile(opts: {
  go?: LaneSnapshot | null;
  zen?: LaneSnapshot | null;
  updatedAtUtc?: string;
  lastDiff?: DiffEntry[];
}): RegistryFile {
  return {
    schemaVersion: MODELS_SCHEMA_VERSION,
    updatedAtUtc: opts.updatedAtUtc ?? "2026-01-01T00:00:00.000Z",
    go: opts.go !== undefined ? opts.go : null,
    zen: opts.zen !== undefined ? opts.zen : null,
    lastAttempt: { go: null, zen: null, combinedAtUtc: null },
    lastDiff: opts.lastDiff ?? [],
  };
}

function mockFetchFn(lanes: { go: ModelEntry[]; zen: ModelEntry[] }): FetchFn {
  return async (url: string) => {
    const body = url.includes("/go/v1")
      ? { object: "list", data: lanes.go }
      : url.includes("/zen/v1")
        ? { object: "list", data: lanes.zen }
        : { object: "list", data: [] };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
}

// ---------------------------------------------------------------------------
// Semantic equality
// ---------------------------------------------------------------------------

describe("computeDiff semantic equality", () => {
  test("created-only churn → zero MODEL_CHANGED entries", () => {
    const prev = regFile({
      go: snap([makeModel("go-a", { created: 1000, owned_by: "acme" })]),
      zen: snap([makeModel("zen-b", { created: 2000, owned_by: "acme" })]),
    });
    const curr = regFile({
      go: snap([makeModel("go-a", { created: 9999999, owned_by: "acme" })]),
      zen: snap([makeModel("zen-b", { created: 1, owned_by: "acme" })]),
    });
    const diff = computeDiff(prev, curr);
    expect(diff.filter((d) => d.kind === "MODEL_CHANGED")).toHaveLength(0);
    expect(diff).toHaveLength(0);
  });

  test("created-only churn with reordered-but-identical other fields → zero changed", () => {
    // Key order inside the object must not matter (stable stringify sorts keys).
    const prev = regFile({
      go: snap([{ ...makeModel("go-a", { created: 1000, owned_by: "acme", meta: { tier: "free" } }) } as ModelEntry]),
    });
    const reordered = {
      meta: { tier: "free" },
      owned_by: "acme",
      created: 424242,
      object: "model",
      id: "go-a",
    } as unknown as ModelEntry;
    const diff = computeDiff(prev, regFile({ go: snap([reordered]) }));
    expect(diff).toHaveLength(0);
  });

  test("object delta → MODEL_CHANGED with prev/curr captured", () => {
    const prev = regFile({ go: snap([makeModel("go-a", { created: 1000, object: "model" })]) });
    const curr = regFile({ go: snap([makeModel("go-a", { created: 1000, object: "model.v2" })]) });
    const diff = computeDiff(prev, curr);
    expect(diff).toHaveLength(1);
    expect(diff[0]!.kind).toBe("MODEL_CHANGED");
    expect(diff[0]!.lane).toBe("go");
    expect(diff[0]!.id).toBe("go-a");
    expect((diff[0]!.prev as ModelEntry).object).toBe("model");
    expect((diff[0]!.curr as ModelEntry).object).toBe("model.v2");
  });

  test("owned_by delta → MODEL_CHANGED (created equal, still detected)", () => {
    const prev = regFile({ zen: snap([makeModel("zen-b", { created: 1000, owned_by: "acme" })]) });
    const curr = regFile({ zen: snap([makeModel("zen-b", { created: 1000, owned_by: "other" })]) });
    const diff = computeDiff(prev, curr);
    expect(diff).toHaveLength(1);
    expect(diff[0]).toMatchObject({ kind: "MODEL_CHANGED", lane: "zen", id: "zen-b" });
  });

  test("future unknown metadata field delta → MODEL_CHANGED", () => {
    const prev = regFile({
      go: snap([makeModel("go-a", { created: 1000, owned_by: "acme", future_field: "x" })]),
    });
    const curr = regFile({
      go: snap([makeModel("go-a", { created: 1000, owned_by: "acme", future_field: "y" })]),
    });
    const diff = computeDiff(prev, curr);
    expect(diff).toHaveLength(1);
    expect(diff[0]!.kind).toBe("MODEL_CHANGED");
  });

  test("future unknown field added/removed → MODEL_CHANGED both directions", () => {
    const base = makeModel("go-a", { created: 1000, owned_by: "acme" });
    const withNew = makeModel("go-a", { created: 1000, owned_by: "acme", newly_documented: true });
    expect(computeDiff(regFile({ go: snap([base]) }), regFile({ go: snap([withNew]) }))).toHaveLength(1);
    expect(computeDiff(regFile({ go: snap([withNew]) }), regFile({ go: snap([base]) }))).toHaveLength(1);
  });

  test("top-level created ignored but nested created is significant", () => {
    // The ignore is scoped to the TOP-LEVEL `created` field only.
    const prev = regFile({ go: snap([makeModel("go-a", { created: 1000, meta: { created: 1 } })]) });
    const curr = regFile({ go: snap([makeModel("go-a", { created: 2000, meta: { created: 2 } })]) });
    const diff = computeDiff(prev, curr);
    expect(diff).toHaveLength(1);
    expect(diff[0]!.kind).toBe("MODEL_CHANGED");
  });

  test("null prev → all entries are MODEL_ADDED", () => {
    const diff = computeDiff(null, regFile({
      go: snap([makeModel("go-a")]),
      zen: snap([makeModel("zen-b")]),
    }));
    expect(diff).toHaveLength(2);
    expect(diff.every((d) => d.kind === "MODEL_ADDED")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Add/remove
// ---------------------------------------------------------------------------

describe("computeDiff add/remove", () => {
  test("added model in go, removed model in zen", () => {
    const prev = regFile({
      go: snap([makeModel("go-a", { created: 1 })]),
      zen: snap([makeModel("zen-old", { created: 1 })]),
    });
    const curr = regFile({
      go: snap([makeModel("go-a", { created: 2 }), makeModel("go-new", { created: 3 })]),
      zen: snap([]),
    });
    const diff = computeDiff(prev, curr);
    expect(diff).toHaveLength(2);
    expect(diff).toContainEqual(expect.objectContaining({ kind: "MODEL_ADDED", lane: "go", id: "go-new" }));
    expect(diff).toContainEqual(expect.objectContaining({ kind: "MODEL_REMOVED", lane: "zen", id: "zen-old" }));
  });

  test("add/remove on both lanes with unchanged survivor", () => {
    const prev = regFile({
      go: snap([makeModel("keep", { created: 1 }), makeModel("gone", { created: 1 })]),
      zen: snap([makeModel("zen-keep", { created: 1 })]),
    });
    const curr = regFile({
      go: snap([makeModel("keep", { created: 9 }), makeModel("arrive", { created: 1 })]),
      zen: snap([makeModel("zen-keep", { created: 9 }), makeModel("zen-arrive", { created: 1 })]),
    });
    const diff = computeDiff(prev, curr);
    // created churn on survivors must NOT show up; adds and the removal must appear
    expect(diff).toHaveLength(3);
    expect(diff.map((d) => `${d.lane}:${d.kind}:${d.id}`).sort()).toEqual([
      "go:MODEL_ADDED:arrive",
      "go:MODEL_REMOVED:gone",
      "zen:MODEL_ADDED:zen-arrive",
    ]);
  });

  test("lane snapshot removed (null) drops lane from diff", () => {
    const prev = regFile({ go: snap([makeModel("go-a")]), zen: snap([makeModel("zen-b")]) });
    const curr = regFile({ go: snap([makeModel("go-a")]), zen: null });
    const diff = computeDiff(prev, curr);
    expect(diff).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Determinism / ordering
// ---------------------------------------------------------------------------

describe("computeDiff determinism and ordering", () => {
  test("output sorted by lane, kind, id regardless of input order; repeated calls identical", () => {
    const prev = regFile({
      go: snap([makeModel("g3", { created: 1, owned_by: "a" }), makeModel("g1", { created: 1 })]),
      zen: snap([makeModel("z2", { created: 1, owned_by: "a" }), makeModel("z1", { created: 1, object: "model" })]),
    });
    // Same semantic content but shuffled models arrays and moved key insertion order.
    const shuffled = regFile({
      go: snap([
        makeModel("g1", { created: 1 }),
        { object: "model", owned_by: "b", id: "g3", created: 1 } as unknown as ModelEntry,
      ]),
      zen: snap([
        { object: "model.changed", created: 1, id: "z1" } as unknown as ModelEntry,
        makeModel("z2", { created: 1, owned_by: "b" }),
        makeModel("z0", { created: 1 }),
      ]),
    });
    const d1 = computeDiff(prev, shuffled);
    const d2 = computeDiff(prev, shuffled);
    expect(d1).toEqual(d2);
    // Deterministic key: lane, kind, id — non-decreasing lexicographically
    const keys = d1.map((d) => `${d.lane}|${d.kind}|${d.id}`);
    const sorted = [...keys].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    expect(keys).toEqual(sorted);
    // Expected semantic content: g3 changed (owned_by), z1 changed (object), z2 changed (owned_by), z0 added
    expect(keys).toEqual([
      "go|MODEL_CHANGED|g3",
      "zen|MODEL_ADDED|z0",
      "zen|MODEL_CHANGED|z1",
      "zen|MODEL_CHANGED|z2",
    ]);
  });

  test("identical snapshots → empty diff, same object identity-free result", () => {
    const reg = regFile({
      go: snap([makeModel("go-a", { created: 1, owned_by: "x" })]),
      zen: snap([makeModel("zen-b", { created: 1 })]),
    });
    expect(computeDiff(reg, reg)).toHaveLength(0);
    expect(computeDiff(reg, structuredClone(reg))).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Raw `created` preserved through registry roundtrip
// ---------------------------------------------------------------------------

describe("registry roundtrip preserves raw created", () => {
  test("storeRegistry/loadRegistry keeps created verbatim even when diff ignores it", () => {
    const { paths } = freshPaths();
    const reg = regFile({
      go: snap([makeModel("go-a", { created: 1717000000, owned_by: "acme" })]),
      zen: snap([makeModel("zen-b", { created: 1728000000, context_window: 128000 })]),
    });
    storeRegistry(paths, reg);
    const loaded = loadRegistry(paths);
    expect(loaded).not.toBeNull();
    expect(loaded!.go!.models[0]!.created).toBe(1717000000);
    expect(loaded!.zen!.models[0]!.created).toBe(1728000000);
    // Full raw entry equality (not just created)
    expect(loaded!.go!.models[0]).toEqual(reg.go!.models[0]);
    expect(loaded!.zen!.models[0]).toEqual(reg.zen!.models[0]);
  });

  test("roundtripped registry with only created churn still diffs to zero", () => {
    const { paths } = freshPaths();
    const before = regFile({
      go: snap([makeModel("go-a", { created: 1, owned_by: "acme" })]),
      zen: snap([makeModel("zen-b", { created: 1, owned_by: "acme" })]),
    });
    storeRegistry(paths, before);
    const loaded = loadRegistry(paths)!;
    const after = regFile({
      go: snap([makeModel("go-a", { created: 2, owned_by: "acme" })]),
      zen: snap([makeModel("zen-b", { created: 2, owned_by: "acme" })]),
    });
    const diff = computeDiff(loaded, after);
    expect(diff).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// End-to-end refreshRegistry with mocked fetchFn
// ---------------------------------------------------------------------------

describe("refreshRegistry end-to-end with mocked fetchFn", () => {
  test("unchanged-catalog re-refresh (only created advanced) yields +0/-0/~0 in reg.lastDiff", async () => {
    const { paths } = freshPaths();
    clearRefreshSingleFlightForTests();

    const catalogV1 = {
      go: [makeModel("go-a", { created: 1000, owned_by: "acme" }), makeModel("go-b", { created: 1001 })],
      zen: [makeModel("zen-b", { created: 2000, owned_by: "acme" })],
    };

    // First refresh: establishes the registry (all additions).
    const r1 = await refreshRegistry(paths, {
      upstreamGo: "http://upstream.test/go/v1",
      upstreamZen: "http://upstream.test/zen/v1",
      fetchFn: mockFetchFn(catalogV1),
      nowMs: Date.parse("2026-01-01T00:00:00.000Z"),
      nowIso: "2026-01-01T00:00:00.000Z",
    });
    expect(r1.success).toBe(true);
    expect(r1.fromCache).toBe(false);
    expect(r1.diff.map((d) => d.kind).sort()).toEqual(["MODEL_ADDED", "MODEL_ADDED", "MODEL_ADDED"]);

    // Second refresh: identical catalog except `created` advanced on every model.
    const catalogV2 = {
      go: [
        makeModel("go-a", { created: 9999999, owned_by: "acme" }),
        makeModel("go-b", { created: 9999999 }),
      ],
      zen: [makeModel("zen-b", { created: 9999999, owned_by: "acme" })],
    };
    clearRefreshSingleFlightForTests();
    const r2 = await refreshRegistry(paths, {
      upstreamGo: "http://upstream.test/go/v1",
      upstreamZen: "http://upstream.test/zen/v1",
      fetchFn: mockFetchFn(catalogV2),
      forced: true, // bypass TTL so the second fetch actually happens
      nowMs: Date.parse("2026-01-02T00:00:00.000Z"),
      nowIso: "2026-01-02T00:00:00.000Z",
    });
    expect(r2.success).toBe(true);
    expect(r2.fromCache).toBe(false);

    // +0 / -0 / ~0 : no additions, no removals, no semantic changes.
    const added = r2.diff.filter((d) => d.kind === "MODEL_ADDED");
    const removed = r2.diff.filter((d) => d.kind === "MODEL_REMOVED");
    const changed = r2.diff.filter((d) => d.kind === "MODEL_CHANGED");
    expect(added).toHaveLength(0);
    expect(removed).toHaveLength(0);
    expect(changed).toHaveLength(0);
    expect(r2.diff).toHaveLength(0);

    // Persisted registry agrees: lastDiff empty, raw created values advanced.
    const reg = loadRegistry(paths);
    expect(reg).not.toBeNull();
    expect(reg!.lastDiff).toHaveLength(0);
    expect(reg!.go!.models.map((m) => m.created)).toEqual([9999999, 9999999]);
    expect(reg!.zen!.models[0]!.created).toBe(9999999);
    expect(reg!.updatedAtUtc).toBe("2026-01-02T00:00:00.000Z");
  });

  test("changed owned_by across refresh surfaces as MODEL_CHANGED in reg.lastDiff", async () => {
    const { paths } = freshPaths();
    clearRefreshSingleFlightForTests();

    const v1 = { go: [makeModel("go-a", { created: 1000, owned_by: "acme" })], zen: [] };
    const r1 = await refreshRegistry(paths, {
      upstreamGo: "http://upstream.test/go/v1",
      upstreamZen: "http://upstream.test/zen/v1",
      fetchFn: mockFetchFn(v1),
      nowMs: Date.parse("2026-01-01T00:00:00.000Z"),
      nowIso: "2026-01-01T00:00:00.000Z",
    });
    expect(r1.success).toBe(true);

    const v2 = { go: [makeModel("go-a", { created: 1000, owned_by: "newowner" })], zen: [] };
    clearRefreshSingleFlightForTests();
    const r2 = await refreshRegistry(paths, {
      upstreamGo: "http://upstream.test/go/v1",
      upstreamZen: "http://upstream.test/zen/v1",
      fetchFn: mockFetchFn(v2),
      forced: true,
      nowMs: Date.parse("2026-01-02T00:00:00.000Z"),
      nowIso: "2026-01-02T00:00:00.000Z",
    });
    expect(r2.success).toBe(true);
    expect(registryPathFor(paths)).toBeTruthy();
    expect(r2.diff).toHaveLength(1);
    expect(r2.diff[0]).toMatchObject({ kind: "MODEL_CHANGED", lane: "go", id: "go-a" });
    expect(loadRegistry(paths)!.lastDiff).toEqual(r2.diff);
  });
});
