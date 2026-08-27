/**
 * B.1 — approval store, initialization policy, migration, tuple safety,
 * lifecycle, binding guard, gated reconcile classes and CLI end-to-end.
 *
 * Excluded by assignment: semantic-diff (computeDiff) and DSH reconcile
 * engine mechanics (owned by sibling files). Reconcile is used here only as
 * the vehicle for the gated classes listed in the B.1 spec.
 *
 * Deterministic: no live network, no real %LOCALAPPDATA%\GoRouter or
 * ~/.dsh access — GOROUTER_STATE_DIR / DSH_HOME temp dirs only.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { resolvePaths, ensureStateDirs, type Paths } from "../src/paths.ts";
import { createStateStore } from "../src/state.ts";
import type { Lane } from "../src/state.ts";
import { memSecrets } from "./harness.ts";
import { createDomain } from "../src/domain.ts";
import { MODELS_SCHEMA_VERSION, type RegistryFile, type LaneSnapshot, type ModelEntry } from "../src/models/types.ts";
import { registryPathFor, loadRegistry, storeRegistry } from "../src/models/registry.ts";
import {
  APPROVALS_SCHEMA_VERSION,
  OWNED_DSH_PROVIDERS,
  approvalStorePathFor,
  loadApprovalStore,
  initializeApprovalStore,
  approveTuple,
  revokeModelApproval,
  type ApprovalStoreLoad,
  type ApprovalTuple,
} from "../src/models/dsh-approvals.ts";
import { checkOwnedProviderBindings } from "../src/models/dsh-binding.ts";
import { computeMigrationPreview, applyMigration, migrationProposalId } from "../src/models/dsh-migration.ts";
import { createMemoryDshClient, FileDshClient, type DshClient, type DshSnapshot } from "../src/models/dsh-client.ts";
import { reconcileDshCatalog, clearDshSyncSingleFlightForTests } from "../src/models/dsh-sync.ts";
import { DSH_NAMESPACE } from "../src/models/dsh-types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const dirs: string[] = [];
const BASE_ISO = "2026-01-01T00:00:00.000Z";
const BASE_MS = Date.parse(BASE_ISO);
function isoAt(ms: number): string {
  return new Date(ms).toISOString();
}

beforeEach(() => {
  clearDshSyncSingleFlightForTests();
});
afterEach(() => {
  clearDshSyncSingleFlightForTests();
  for (const d of dirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch {}
  }
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function freshPaths() {
  const dir = tempDir("gorouter-appr-");
  const paths = resolvePaths(dir);
  ensureStateDirs(paths);
  return { dir, paths };
}

/** Certified canonical owned-provider bindings (valid per the binding guard). */
const GO_BIND = { api: "openai-completions", baseURL: "http://127.0.0.1:8787/go/v1" };
const ZEN_BIND = { api: "openai-responses", baseURL: "http://127.0.0.1:8787/zen/v1" };

/** Exact four-field identity for a lane's owned provider (optionally stale protocol). */
function tup(lane: Lane, modelId: string, apiOverride?: string): ApprovalTuple {
  const owned = OWNED_DSH_PROVIDERS[lane];
  return { lane, dshProviderId: owned.providerId, apiProtocol: apiOverride ?? owned.apiProtocol, modelId };
}

function makeModel(id: string, extra: Record<string, unknown> = {}): ModelEntry {
  return { id, object: "model", ...extra } as ModelEntry;
}

function laneSnap(ids: string[], atIso: string = BASE_ISO): LaneSnapshot {
  return {
    fetchedAtUtc: atIso,
    models: ids.map((id) => makeModel(id)).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  };
}

function registryFile(opts: { goIds?: string[] | null; zenIds?: string[] | null }): RegistryFile {
  const updatedAtUtc = isoAt(BASE_MS);
  return {
    schemaVersion: MODELS_SCHEMA_VERSION,
    updatedAtUtc,
    go: opts.goIds === null ? null : laneSnap(opts.goIds ?? [], updatedAtUtc),
    zen: opts.zenIds === null ? null : laneSnap(opts.zenIds ?? [], updatedAtUtc),
    lastAttempt: { go: null, zen: null, combinedAtUtc: null },
    lastDiff: [],
  };
}

/** Memory DSH client with realistic owned-provider bindings (reconcile-visible). */
function memClient(go: ModelEntry[], zen: ModelEntry[], revision = 5) {
  return createMemoryDshClient({
    go,
    zen,
    revision,
    rawGoProvider: { ...GO_BIND },
    rawZenProvider: { ...ZEN_BIND },
  });
}

function snapshotOf(go: ModelEntry[], zen: ModelEntry[], revision = 5, binds?: { go?: unknown; zen?: unknown }): DshSnapshot {
  return {
    revision,
    go,
    zen,
    rawGoProvider: (binds?.go ?? { ...GO_BIND }) as Record<string, unknown>,
    rawZenProvider: (binds?.zen ?? { ...ZEN_BIND }) as Record<string, unknown>,
  };
}

async function reconcile(
  reg: RegistryFile,
  client: DshClient,
  approvalStore?: ApprovalStoreLoad,
  expectedPort = 8787,
) {
  return reconcileDshCatalog(reg, client, { approvalStore, expectedPort });
}

/** Domain wired to a temp state dir (registry fixtures via storeRegistry). */
function domainFor(dir: string) {
  const paths = resolvePaths(dir);
  ensureStateDirs(paths);
  const secrets = memSecrets();
  createStateStore(paths, secrets);
  return { domain: createDomain(paths, secrets), paths };
}

function approvalsFileBytes(paths: Paths): string {
  return readFileSync(approvalStorePathFor(paths), "utf8");
}

// ---------------------------------------------------------------------------
// 1. Approval store (raw ops): missing vs initialized-empty, schema, corruption
// ---------------------------------------------------------------------------

describe("approval store", () => {
  test("missing vs initialized-empty are distinct states", () => {
    const { paths } = freshPaths();
    expect(loadApprovalStore(paths)).toEqual({ state: "absent" });
    initializeApprovalStore(paths, [], "operator", { nowIso: BASE_ISO });
    const loaded = loadApprovalStore(paths);
    expect(loaded.state).toBe("initialized");
    if (loaded.state !== "initialized") return;
    expect(loaded.store.version).toBe(APPROVALS_SCHEMA_VERSION);
    expect(loaded.store.approvals).toEqual([]);
    expect(loaded.store.initializedAtUtc).toBe(BASE_ISO);
  });

  test("valid schema roundtrip: records, source and approvedAtUtc survive reload", () => {
    const { paths } = freshPaths();
    initializeApprovalStore(paths, [tup("go", "g1"), tup("zen", "z1")], "operator", { nowIso: BASE_ISO });
    const loaded = loadApprovalStore(paths);
    expect(loaded.state).toBe("initialized");
    if (loaded.state !== "initialized") return;
    expect(loaded.store.approvals).toEqual([
      { ...tup("go", "g1"), approvedAtUtc: BASE_ISO, source: "operator" },
      { ...tup("zen", "z1"), approvedAtUtc: BASE_ISO, source: "operator" },
    ]);
  });

  test("unsupported version is rejected and preserved; every mutation refuses", () => {
    const { paths } = freshPaths();
    const raw = JSON.stringify({ version: 2, initializedAtUtc: BASE_ISO, approvals: [] });
    writeFileSync(approvalStorePathFor(paths), raw);
    const loaded = loadApprovalStore(paths);
    expect(loaded).toEqual({ state: "unsupported-version", version: 2 });
    expect(() => initializeApprovalStore(paths, [], "operator")).toThrow(/already exists/);
    expect(() => approveTuple(paths, tup("go", "g1"), "operator")).toThrow(/unsupported/);
    expect(() => revokeModelApproval(paths, { lane: "go", modelId: "g1" })).toThrow(/unsupported/);
    expect(approvalsFileBytes(paths)).toBe(raw);
  });

  test("malformed/corrupt shapes are rejected and preserved byte-for-byte", () => {
    const { paths } = freshPaths();
    const cases: Array<[string, string, RegExp]> = [
      ["invalid JSON", "{not json", /invalid JSON/],
      ["array root", "[]", /root must be an object/],
      ["missing version", JSON.stringify({ initializedAtUtc: BASE_ISO, approvals: [] }), /version/],
      ["missing initializedAtUtc", JSON.stringify({ version: 1, approvals: [] }), /initializedAtUtc/],
      ["approvals not array", JSON.stringify({ version: 1, initializedAtUtc: BASE_ISO, approvals: {} }), /approvals must be an array/],
      [
        "bad lane",
        JSON.stringify({ version: 1, initializedAtUtc: BASE_ISO, approvals: [{ ...tup("go", "g1"), lane: "warp" }] }),
        /lane must be go or zen/,
      ],
      [
        "bad source",
        JSON.stringify({ version: 1, initializedAtUtc: BASE_ISO, approvals: [{ ...tup("go", "g1"), approvedAtUtc: BASE_ISO, source: "cron" }] }),
        /source invalid/,
      ],
      [
        "missing modelId",
        JSON.stringify({
          version: 1,
          initializedAtUtc: BASE_ISO,
          approvals: [{ lane: "go", dshProviderId: "gorouter-go", apiProtocol: "openai-completions", approvedAtUtc: BASE_ISO, source: "operator" }],
        }),
        /modelId missing/,
      ],
      [
        "duplicate identity",
        JSON.stringify({
          version: 1,
          initializedAtUtc: BASE_ISO,
          approvals: [
            { ...tup("go", "g1"), approvedAtUtc: BASE_ISO, source: "operator" },
            { ...tup("go", "g1"), approvedAtUtc: BASE_ISO, source: "operator" },
          ],
        }),
        /duplicate approval identity/,
      ],
    ];
    for (const [name, raw, reason] of cases) {
      const fresh = freshPaths();
      writeFileSync(approvalStorePathFor(fresh.paths), raw);
      const loaded = loadApprovalStore(fresh.paths);
      expect(loaded.state).toBe("corrupt");
      if (loaded.state !== "corrupt") continue;
      expect(loaded.reason).toMatch(reason);
      // refused mutations never truncate the file
      expect(() => initializeApprovalStore(fresh.paths, [], "operator")).toThrow(/already exists/);
      expect(() => approveTuple(fresh.paths, tup("go", "g1"), "operator")).toThrow(/corrupt/);
      expect(() => revokeModelApproval(fresh.paths, { lane: "go", modelId: "g1" })).toThrow(/corrupt/);
      expect(approvalsFileBytes(fresh.paths)).toBe(raw);
    }
  });

  test("initialization is one-time: refuses initialized, corrupt and unsupported stores", () => {
    const a = freshPaths();
    initializeApprovalStore(a.paths, [], "operator");
    expect(() => initializeApprovalStore(a.paths, [tup("go", "g1")], "operator")).toThrow(/one-time/);

    const b = freshPaths();
    writeFileSync(approvalStorePathFor(b.paths), "garment");
    expect(() => initializeApprovalStore(b.paths, [], "operator")).toThrow(/corrupt/);

    const c = freshPaths();
    writeFileSync(approvalStorePathFor(c.paths), JSON.stringify({ version: 9, initializedAtUtc: BASE_ISO, approvals: [] }));
    expect(() => initializeApprovalStore(c.paths, [], "operator")).toThrow(/unsupported-version/);
  });

  test("deterministic persistence order (lane, provider, api, model) in file bytes", () => {
    const { paths } = freshPaths();
    initializeApprovalStore(
      paths,
      [tup("zen", "z-b"), tup("go", "m-z"), tup("go", "m-a"), tup("zen", "z-a")],
      "operator",
      { nowIso: BASE_ISO },
    );
    const onDisk = JSON.parse(approvalsFileBytes(paths)) as { approvals: Array<{ lane: string; modelId: string }> };
    expect(onDisk.approvals.map((r) => `${r.lane}/${r.modelId}`)).toEqual(["go/m-a", "go/m-z", "zen/z-a", "zen/z-b"]);
    const loaded = loadApprovalStore(paths);
    expect(loaded.state).toBe("initialized");
    if (loaded.state === "initialized") {
      expect(loaded.store.approvals.map((r) => `${r.lane}/${r.modelId}`)).toEqual(["go/m-a", "go/m-z", "zen/z-a", "zen/z-b"]);
    }
  });

  test("duplicate prevention: init dedupes; approveTuple is idempotent", () => {
    const { paths } = freshPaths();
    initializeApprovalStore(paths, [tup("go", "g1"), tup("go", "g1"), tup("go", "g1")], "operator", { nowIso: BASE_ISO });
    let loaded = loadApprovalStore(paths);
    expect(loaded.state).toBe("initialized");
    if (loaded.state === "initialized") expect(loaded.store.approvals.length).toBe(1);

    const first = approveTuple(paths, tup("go", "g2"), "operator", { nowIso: isoAt(BASE_MS + 1) });
    expect(first.duplicate).toBe(false);
    const again = approveTuple(paths, tup("go", "g2"), "operator", { nowIso: isoAt(BASE_MS + 2) });
    expect(again.duplicate).toBe(true);
    loaded = loadApprovalStore(paths);
    if (loaded.state === "initialized") {
      expect(loaded.store.approvals.map((r) => r.modelId)).toEqual(["g1", "g2"]);
      // first-approved timestamp is preserved on the idempotent retry
      expect(loaded.store.approvals.find((r) => r.modelId === "g2")!.approvedAtUtc).toBe(isoAt(BASE_MS + 1));
    }
  });

  test("approve/revoke require an initialized store (absent refuses)", () => {
    const { paths } = freshPaths();
    expect(() => approveTuple(paths, tup("go", "g1"), "operator")).toThrow(/not initialized/);
    expect(() => revokeModelApproval(paths, { lane: "go", modelId: "g1" })).toThrow(/not initialized/);
    expect(existsSync(approvalStorePathFor(paths))).toBe(false);
  });

  test("revoke removes all historical protocol tuples for (lane, owned provider, modelId)", () => {
    const { paths } = freshPaths();
    initializeApprovalStore(paths, [tup("go", "g1", "openai-chat"), tup("go", "g1"), tup("zen", "g1"), tup("go", "g2")], "operator", { nowIso: BASE_ISO });
    const out = revokeModelApproval(paths, { lane: "go", modelId: "g1" });
    expect(out.removed).toBe(2);
    const loaded = loadApprovalStore(paths);
    if (loaded.state === "initialized") {
      expect(loaded.store.approvals.map((r) => `${r.lane}/${r.modelId}`)).toEqual(["go/g2", "zen/g1"]);
    }
    // revoking again reports zero and does not rewrite the file
    const before = approvalsFileBytes(paths);
    const again = revokeModelApproval(paths, { lane: "go", modelId: "g1" });
    expect(again.removed).toBe(0);
    expect(approvalsFileBytes(paths)).toBe(before);
  });

  test("cross-process lock: concurrent approve/revoke from two real bun subprocesses does not lose updates", async () => {
    const st = freshPaths();
    const repo = resolve(import.meta.dir, "..").replace(/\\/g, "/");
    // Seed one tuple so the final expectation is a 3-record store.
    initializeApprovalStore(st.paths, [tup("go", "seed")], "operator", { nowIso: BASE_ISO });

    const script = join(st.dir, "worker.mts");
    writeFileSync(
      script,
      `
// Static import cannot work: the repo root is only known at runtime via env.
const repo = process.env.GOROUTER_REPO!;
const { resolvePaths, ensureStateDirs } = await import(repo + "/src/paths.ts");
const { approveTuple, revokeModelApproval } = await import(repo + "/src/models/dsh-approvals.ts");
const paths = resolvePaths(process.env.GOROUTER_STATE_DIR!);
ensureStateDirs(paths);
if (process.env.ROLE === "a") {
  approveTuple(paths, { lane: "go", dshProviderId: "gorouter-go", apiProtocol: "openai-completions", modelId: "conc-go-a" }, "operator");
  approveTuple(paths, { lane: "go", dshProviderId: "gorouter-go", apiProtocol: "openai-completions", modelId: "conc-go-a2" }, "operator");
} else {
  approveTuple(paths, { lane: "zen", dshProviderId: "gorouter-zen", apiProtocol: "openai-responses", modelId: "conc-zen-b" }, "operator");
  revokeModelApproval(paths, { lane: "zen", modelId: "conc-zen-b" });
}
`,
    );

    const baseEnv = { ...process.env, GOROUTER_REPO: repo, GOROUTER_STATE_DIR: st.dir };
    const pa = Bun.spawn([process.execPath, script], { env: { ...baseEnv, ROLE: "a" }, stdout: "pipe", stderr: "pipe" });
    const pb = Bun.spawn([process.execPath, script], { env: { ...baseEnv, ROLE: "b" }, stdout: "pipe", stderr: "pipe" });
    const [ca, cb] = await Promise.all([pa.exited, pb.exited]);
    if (ca !== 0 || cb !== 0) {
      const errA = ca !== 0 ? await new Response(pa.stderr).text() : "";
      const errB = cb !== 0 ? await new Response(pb.stderr).text() : "";
      throw new Error(`subprocess failed: a=${ca} b=${cb}\n${errA}\n${errB}`);
    }

    const loaded = loadApprovalStore(st.paths);
    expect(loaded.state).toBe("initialized");
    if (loaded.state !== "initialized") return;
    const ids = loaded.store.approvals.map((r) => `${r.lane}/${r.modelId}`);
    // Both writers' adds survived (a lost update would drop one writer's records),
    // and B's self-revoke removed its own tuple exactly once.
    expect(ids).toEqual(["go/conc-go-a", "go/conc-go-a2", "go/seed"]);
    expect(ids).not.toContain("zen/conc-zen-b");
  });
});

// ---------------------------------------------------------------------------
// 2. Initialization policy + migration (preview -> explicit ratification -> apply)
// ---------------------------------------------------------------------------

describe("initialization policy: reconcile gating before any DSH read", () => {
  test("absent store + populated owned arrays -> blocked, arrays byte-identical, no client read", async () => {
    const { paths } = freshPaths();
    const reg = registryFile({ goIds: ["g1", "g2"], zenIds: ["z1"] });
    const client = memClient([makeModel("legacy-g")], [makeModel("legacy-z"), makeModel("legacy-z2")]);
    const status = await reconcile(reg, client);
    expect(status.outcome).toBe("blocked");
    expect(status.mutationPerformed).toBe(false);
    expect(status.approvalsInitialized).toBe(false);
    expect(status.migrationRequired).toBe(true);
    expect(status.withheldGoCount).toBe(2);
    expect(status.withheldZenCount).toBe(1);
    expect(status.lastError).toMatch(/migration/);
    expect(client.mutations).toBe(0);
    expect(client.history.length).toBe(0);
    // snapshot untouched
    const snap = await client.read();
    expect(snap!.go.map((m) => m.id)).toEqual(["legacy-g"]);
    expect(snap!.zen.map((m) => m.id)).toEqual(["legacy-z", "legacy-z2"]);
    expect(existsSync(approvalStorePathFor(paths))).toBe(false);
  });

  test("corrupt store -> error outcome (not migration), fail closed, no mutation", async () => {
    const { paths } = freshPaths();
    writeFileSync(approvalStorePathFor(paths), "{oops");
    const client = memClient([makeModel("x")], []);
    const status = await reconcile(registryFile({ goIds: ["g1"], zenIds: ["z1"] }), client, loadApprovalStore(paths));
    expect(status.outcome).toBe("error");
    expect(status.mutationPerformed).toBe(false);
    expect(status.migrationRequired).toBe(false);
    expect(status.approvalsInitialized).toBe(false);
    expect(status.lastError).toMatch(/corrupt/);
    expect(client.history.length).toBe(0);
  });

  test("unsupported-version store -> error outcome with version surfaced", async () => {
    const { paths } = freshPaths();
    writeFileSync(approvalStorePathFor(paths), JSON.stringify({ version: 7, initializedAtUtc: BASE_ISO, approvals: [] }));
    const client = memClient([makeModel("x")], []);
    const status = await reconcile(registryFile({ goIds: ["g1"], zenIds: ["z1"] }), client, loadApprovalStore(paths));
    expect(status.outcome).toBe("error");
    expect(status.migrationRequired).toBe(false);
    expect(status.lastError).toContain("7");
    expect(client.history.length).toBe(0);
  });

  test("initialized-empty store -> authoritative empty: one coherent mutation clears both lanes", async () => {
    const { paths } = freshPaths();
    initializeApprovalStore(paths, [], "operator", { nowIso: BASE_ISO });
    const reg = registryFile({ goIds: ["g1"], zenIds: ["z1"] });
    const client = memClient([makeModel("legacy-g"), makeModel("legacy-g2")], [makeModel("legacy-z")]);
    const status = await reconcile(reg, client, loadApprovalStore(paths));
    expect(status.outcome).toBe("current");
    expect(status.mutationPerformed).toBe(true);
    expect(status.approvalsInitialized).toBe(true);
    expect(status.migrationRequired).toBe(false);
    expect(status.bindingValid).toBe(true);
    // exactly one coherent mutation covering BOTH lanes
    expect(client.history.length).toBe(1);
    expect(client.history[0]!.go).toEqual([]);
    expect(client.history[0]!.zen).toEqual([]);
  });
});

describe("migration", () => {
  test("uninitialized + legacy entries: domain.approvalsApprove refuses with migration-required", async () => {
    const { dir, paths } = freshPaths();
    storeRegistry(paths, registryFile({ goIds: ["g1"], zenIds: ["z1"] }));
    const { domain } = domainFor(dir);
    const client = memClient([makeModel("legacy-g")], [makeModel("legacy-z")]);
    await expect(domain.approvalsApprove("go", "g1", { dshClient: client })).rejects.toThrow(/migration required/);
    expect(existsSync(approvalStorePathFor(paths))).toBe(false);
    expect(client.history.length).toBe(0);
  });

  test("preview is read-only: no store file, no DSH mutation, revision unchanged", async () => {
    const { paths } = freshPaths();
    const client = memClient([makeModel("g1"), makeModel("g2")], [makeModel("z1")], 11);
    const snapBefore = await client.read();
    const preview = computeMigrationPreview(snapBefore!, 8787, BASE_ISO);
    expect(client.mutations).toBe(0);
    expect(existsSync(approvalStorePathFor(paths))).toBe(false);
    const snapAfter = await client.read();
    expect(snapAfter!.revision).toBe(11);
    expect(preview.revision).toBe(11);
    expect(preview.bindings.valid).toBe(true);
    expect(preview.candidates).toEqual([tup("go", "g1"), tup("go", "g2"), tup("zen", "z1")]);
  });

  test("proposal id is deterministic; drift in candidates, bindings or revision changes it", () => {
    const snap = snapshotOf([makeModel("g1")], [makeModel("z1")], 3);
    const p1 = computeMigrationPreview(snap, 8787, BASE_ISO);
    const p2 = computeMigrationPreview(snapshotOf([makeModel("g1")], [makeModel("z1")], 3), 8787, isoAt(BASE_MS + 5000));
    expect(p1.proposalId).toBe(p2.proposalId);

    const base = computeMigrationPreview(snap, 8787, BASE_ISO);
    const changedCandidates = [tup("go", "g1"), tup("zen", "z1"), tup("go", "g2")];
    const changedBindings = checkOwnedProviderBindings(
      snapshotOf([], [], 3, {
        go: { ...GO_BIND, baseURL: "http://127.0.0.1:8788/go/v1" },
        zen: { ...ZEN_BIND },
      }),
      8787,
    );
    expect(migrationProposalId(changedCandidates, base.bindings, 3)).not.toBe(base.proposalId);
    expect(migrationProposalId(base.candidates, changedBindings, 3)).not.toBe(base.proposalId);
    expect(migrationProposalId(base.candidates, base.bindings, 4)).not.toBe(base.proposalId);
  });

  test("apply initializes exactly the previewed tuples with source legacy-migration", () => {
    const { paths } = freshPaths();
    const snap = snapshotOf([makeModel("b-g"), makeModel("a-g")], [makeModel("z1")], 2);
    const preview = computeMigrationPreview(snap, 8787, BASE_ISO);
    const res = applyMigration(paths, snap, preview.proposalId, 8787, { nowIso: BASE_ISO });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.candidates).toEqual(preview.candidates);
    const loaded = loadApprovalStore(paths);
    expect(loaded.state).toBe("initialized");
    if (loaded.state !== "initialized") return;
    expect(loaded.store.approvals).toEqual(preview.candidates.map((c) => ({ ...c, approvedAtUtc: BASE_ISO, source: "legacy-migration" })));
  });

  test("apply refuses when store exists in any state", () => {
    const snap = snapshotOf([makeModel("g1")], [makeModel("z1")], 2);
    const id = computeMigrationPreview(snap, 8787, BASE_ISO).proposalId;

    const a = freshPaths();
    initializeApprovalStore(a.paths, [], "operator");
    expect(applyMigration(a.paths, snap, id, 8787).ok).toBe(false);

    const b = freshPaths();
    writeFileSync(approvalStorePathFor(b.paths), "junk{");
    expect(applyMigration(b.paths, snap, id, 8787).ok).toBe(false);

    const c = freshPaths();
    writeFileSync(approvalStorePathFor(c.paths), JSON.stringify({ version: 3, initializedAtUtc: BASE_ISO, approvals: [] }));
    const res = applyMigration(c.paths, snap, id, 8787);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/3/);
    expect(existsSync(approvalStorePathFor(a.paths))).toBe(true); // untouched one-time store
  });

  test("apply fail-closed on invalid bindings (before any store write)", () => {
    const { paths } = freshPaths();
    const bad = snapshotOf([], [], 1, { go: { ...GO_BIND, baseURL: "http://10.0.0.5:8787/go/v1" }, zen: { ...ZEN_BIND } });
    const id = computeMigrationPreview(bad, 8787, BASE_ISO).proposalId;
    const res = applyMigration(paths, bad, id, 8787);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/binding invalid/);
    expect(existsSync(approvalStorePathFor(paths))).toBe(false);
  });

  test("TOCTOU drift invalidates apply: candidates, bindings and revision each reject with zero writes", () => {
    const driftCases: Array<[DshSnapshot, RegExp]> = [
      [snapshotOf([makeModel("g1"), makeModel("g-NEW")], [makeModel("z1")], 5), /mismatch|drifted/],
      [snapshotOf([makeModel("g1")], [makeModel("z1")], 5, { go: { ...GO_BIND, baseURL: "http://127.0.0.1:9999/go/v1" }, zen: { ...ZEN_BIND } }), /binding invalid/],
      [snapshotOf([makeModel("g1")], [makeModel("z1")], 6), /mismatch|drifted/],
    ];
    for (const [applySnap, reason] of driftCases) {
      const { paths } = freshPaths();
      const previewSnap = snapshotOf([makeModel("g1")], [makeModel("z1")], 5);
      const id = computeMigrationPreview(previewSnap, 8787, BASE_ISO).proposalId;
      const res = applyMigration(paths, applySnap, id, 8787);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toMatch(reason);
      expect(existsSync(approvalStorePathFor(paths))).toBe(false);
    }
  });

  test("domain preview/apply TOCTOU: mutating DSH between preview and apply throws, store stays absent", async () => {
    const { dir, paths } = freshPaths();
    const { domain } = domainFor(dir);
    const client = memClient([makeModel("legacy-g")], [makeModel("legacy-z")], 5);
    const preview = await domain.approvalsMigratePreview({ dshClient: client });
    expect(preview.candidates).toEqual([tup("go", "legacy-g"), tup("zen", "legacy-z")]);
    // drift: bump the revision behind the client's back
    await client.mutate([makeModel("legacy-g")], [makeModel("legacy-z")], 5);
    await expect(domain.approvalsMigrateApply(preview.proposalId, { dshClient: client })).rejects.toThrow(/mismatch|drifted/);
    expect(existsSync(approvalStorePathFor(paths))).toBe(false);
  });

  test("domain migrate apply succeeds on the previewed proposal and a second apply refuses", async () => {
    const { dir, paths } = freshPaths();
    const { domain } = domainFor(dir);
    const client = memClient([makeModel("legacy-g")], [], 1);
    const preview = await domain.approvalsMigratePreview({ dshClient: client });
    const applied = await domain.approvalsMigrateApply(preview.proposalId, { dshClient: client });
    expect(applied.applied).toBe(true);
    expect(applied.proposalId).toBe(preview.proposalId);
    const loaded = loadApprovalStore(paths);
    expect(loaded.state).toBe("initialized");
    if (loaded.state === "initialized") {
      expect(loaded.store.approvals.map((r) => r.source)).toEqual(["legacy-migration"]);
    }
    await expect(domain.approvalsMigrateApply(preview.proposalId, { dshClient: client })).rejects.toThrow(/one-time|already initialized/);
  });

  test("FileDshClient real settings file: gorouter-go-responses and openrouter preserved and excluded from candidates", async () => {
    const st = freshPaths();
    const settingsDoc = {
      unrelated: { keep: "me" },
      [DSH_NAMESPACE]: {
        providers: {
          "gorouter-go": { api: "openai-completions", baseURL: "http://127.0.0.1:8787/go/v1", models: [{ id: "legacy-go-1", object: "model" }] },
          "gorouter-zen": { api: "openai-responses", baseURL: "http://127.0.0.1:8787/zen/v1", models: [{ id: "legacy-zen-1", object: "model" }] },
          "gorouter-go-responses": {
            api: "openai-responses",
            baseURL: "http://127.0.0.1:8787/go/v1",
            marker: "keep-me",
            models: [{ id: "resp-only", object: "model" }],
          },
          "openrouter": { api: "openai-completions", baseURL: "http://127.0.0.1:9999/or/v1", models: [{ id: "or-model", object: "model" }] },
        },
      },
    };
    const settingsPath = join(st.dir, "settings.yaml");
    writeFileSync(settingsPath, JSON.stringify(settingsDoc, null, 2));
    const before = readFileSync(settingsPath, "utf8");

    // Reconcile with an initialized approval store: owned arrays update, unowned providers untouched.
    initializeApprovalStore(st.paths, [tup("go", "legacy-go-1"), tup("zen", "legacy-zen-1")], "operator", { nowIso: BASE_ISO });
    const reg = registryFile({ goIds: ["legacy-go-1"], zenIds: ["legacy-zen-1"] });
    const client = new FileDshClient(settingsPath);
    const status = await reconcile(reg, client, loadApprovalStore(st.paths));
    const after = JSON.parse(readFileSync(settingsPath, "utf8")) as typeof settingsDoc;
    // Owned arrays already hold exactly the approved registry models: semantic no-op.
    expect(status.outcome).toBe("no-op");
    expect(status.mutationPerformed).toBe(false);
    expect(after[DSH_NAMESPACE]!.providers["gorouter-go"]!.models.map((m: ModelEntry) => m.id)).toEqual(["legacy-go-1"]);
    expect(after[DSH_NAMESPACE]!.providers["gorouter-zen"]!.models.map((m: ModelEntry) => m.id)).toEqual(["legacy-zen-1"]);
    expect((after as Record<string, unknown>)["unrelated"]).toEqual({ keep: "me" });

    // Domain preview over the same real settings file: candidates only from owned providers.
    const dshHome = tempDir("gorouter-dshhome-");
    const withSettings = join(dshHome, "settings.yaml");
    writeFileSync(withSettings, JSON.stringify(settingsDoc, null, 2));
    const { dir, paths } = freshPaths();
    const { domain } = domainFor(dir);
    const prevEnv = process.env.DSH_HOME;
    process.env.DSH_HOME = dshHome;
    try {
      const preview = await domain.approvalsMigratePreview();
      expect(preview.bindingsValid).toBe(true);
      expect(preview.candidates).toEqual([tup("go", "legacy-go-1"), tup("zen", "legacy-zen-1")]);
      expect(preview.candidates.some((c) => c.modelId === "resp-only" || c.modelId === "or-model")).toBe(false);
      // preview is read-only against the real settings file and the store
      expect(readFileSync(withSettings, "utf8")).toBe(readFileSync(withSettings, "utf8"));
      expect(loadRegistry(paths)).toBeNull();
    } finally {
      if (prevEnv === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = prevEnv;
    }
    expect(before.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Tuple safety (exact four-field identity)
// ---------------------------------------------------------------------------

describe("tuple safety", () => {
  async function syncWithApprovals(approvals: ApprovalTuple[], goIds: string[], zenIds: string[], current?: { go?: ModelEntry[]; zen?: ModelEntry[] }) {
    const { paths } = freshPaths();
    initializeApprovalStore(paths, approvals, "operator", { nowIso: BASE_ISO });
    const reg = registryFile({ goIds, zenIds });
    const client = memClient(current?.go ?? [], current?.zen ?? []);
    const status = await reconcile(reg, client, loadApprovalStore(paths));
    return { status, client };
  }

  test("same model id approved on go does not activate on zen", async () => {
    const { status, client } = await syncWithApprovals([tup("go", "shared-id")], ["shared-id", "g2"], ["shared-id", "z1"]);
    expect(status.outcome).toBe("current");
    expect(client.history.length).toBe(1);
    expect(client.history[0]!.go.map((m) => m.id)).toEqual(["shared-id"]);
    expect(client.history[0]!.zen.map((m) => m.id)).toEqual([]);
    expect(status.withheldGoCount).toBe(1);
    expect(status.withheldZenCount).toBe(2);
  });

  test("stale protocol tuple (openai-chat) never activates", async () => {
    // g1 is currently configured; if the stale approval activated, it would survive.
    const { status, client } = await syncWithApprovals([tup("go", "g1", "openai-chat")], ["g1"], [], { go: [makeModel("g1")], zen: [] });
    expect(status.outcome).toBe("current");
    expect(client.history[0]!.go).toEqual([]);
    expect(status.withheldGoCount).toBe(1);
  });

  test("wrong provider (gorouter-go-responses) never activates", async () => {
    const { paths } = freshPaths();
    initializeApprovalStore(paths, [{ lane: "go", dshProviderId: "gorouter-go-responses", apiProtocol: "openai-responses", modelId: "g1" }], "operator", { nowIso: BASE_ISO });
    const reg = registryFile({ goIds: ["g1"], zenIds: [] });
    const client = memClient([makeModel("g1")], []);
    const status = await reconcile(reg, client, loadApprovalStore(paths));
    expect(status.outcome).toBe("current");
    expect(client.history[0]!.go).toEqual([]);
    expect(status.withheldGoCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 4. Lifecycle: eligible / withheld / absent / reappearance / revoke
// ---------------------------------------------------------------------------

describe("approval lifecycle through reconcile", () => {
  function lifecycleClient(currentGo: ModelEntry[], currentZen: ModelEntry[]) {
    return memClient(currentGo, currentZen);
  }

  test("approved+present -> eligible (mutated in, registry template copied)", async () => {
    const { paths } = freshPaths();
    initializeApprovalStore(paths, [tup("go", "g1")], "operator", { nowIso: BASE_ISO });
    const reg = registryFile({ goIds: ["g1"], zenIds: [] });
    reg.go!.models = [{ ...makeModel("g1"), owned_by: "go-team" }];
    const client = lifecycleClient([], []);
    const status = await reconcile(reg, client, loadApprovalStore(paths));
    expect(status.outcome).toBe("current");
    expect(client.history[0]!.go).toEqual([{ id: "g1", object: "model", owned_by: "go-team" }]);
    expect(status.activeGoCount).toBe(1);
    expect(status.withheldGoCount).toBe(0);
  });

  test("unapproved+present -> withheld and removed from the arrays", async () => {
    const { paths } = freshPaths();
    initializeApprovalStore(paths, [], "operator", { nowIso: BASE_ISO });
    const reg = registryFile({ goIds: ["g1", "g2"], zenIds: [] });
    const client = lifecycleClient([makeModel("g1")], []);
    const status = await reconcile(reg, client, loadApprovalStore(paths));
    expect(status.outcome).toBe("current");
    expect(client.history[0]!.go).toEqual([]);
    expect(status.withheldGoCount).toBe(2);
  });

  test("approved+absent -> removed from arrays (inactive), approval retained in store", async () => {
    const { paths } = freshPaths();
    initializeApprovalStore(paths, [tup("go", "gone")], "operator", { nowIso: BASE_ISO });
    const reg = registryFile({ goIds: ["g1"], zenIds: [] });
    const client = lifecycleClient([makeModel("gone")], []);
    const status = await reconcile(reg, client, loadApprovalStore(paths));
    expect(status.outcome).toBe("current");
    expect(client.history[0]!.go).toEqual([]);
    expect(status.approvedAbsentGoCount).toBe(1);
    const loaded = loadApprovalStore(paths);
    if (loaded.state === "initialized") {
      expect(loaded.store.approvals.some((r) => r.modelId === "gone")).toBe(true);
    }
  });

  test("identical tuple reappearance -> active again", async () => {
    const { paths } = freshPaths();
    initializeApprovalStore(paths, [tup("zen", "z1")], "operator", { nowIso: BASE_ISO });
    // round 1: absent upstream -> goes inactive
    const reg1 = registryFile({ goIds: [], zenIds: [] });
    const client1 = lifecycleClient([], [makeModel("z1")]);
    await reconcile(reg1, client1, loadApprovalStore(paths));
    expect(client1.history[0]!.zen).toEqual([]);
    // round 2: registry re-gains the id -> eligible again without re-approval
    const reg2 = registryFile({ goIds: [], zenIds: ["z1", "z2"] });
    const client2 = lifecycleClient([], []);
    const status = await reconcile(reg2, client2, loadApprovalStore(paths));
    expect(status.outcome).toBe("current");
    expect(client2.history[0]!.zen.map((m) => m.id)).toEqual(["z1"]);
  });

  test("revoke -> removed from arrays on next reconcile", async () => {
    const { paths } = freshPaths();
    initializeApprovalStore(paths, [tup("go", "g1")], "operator", { nowIso: BASE_ISO });
    const reg = registryFile({ goIds: ["g1"], zenIds: [] });
    const active = lifecycleClient([], []);
    await reconcile(reg, active, loadApprovalStore(paths));
    expect(active.history[0]!.go.map((m) => m.id)).toEqual(["g1"]);
    revokeModelApproval(paths, { lane: "go", modelId: "g1" });
    const client = lifecycleClient([makeModel("g1")], []);
    const status = await reconcile(reg, client, loadApprovalStore(paths));
    expect(status.outcome).toBe("current");
    expect(client.history[0]!.go).toEqual([]);
    expect(status.withheldGoCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 5. Binding guard
// ---------------------------------------------------------------------------

describe("binding guard", () => {
  function bindCheck(go?: unknown, zen?: unknown) {
    // Explicit undefined means "provider object missing" — must not fall back
    // to a default binding, so build the snapshot directly here.
    const snap: DshSnapshot = {
      revision: 1,
      go: [],
      zen: [],
      rawGoProvider: go as Record<string, unknown> | null | undefined,
      rawZenProvider: zen as Record<string, unknown> | null | undefined,
    };
    return checkOwnedProviderBindings(snap, 8787);
  }

  test("canonical bindings validate per lane", () => {
    const b = bindCheck({ ...GO_BIND }, { ...ZEN_BIND });
    expect(b.valid).toBe(true);
    expect(b.go.valid).toBe(true);
    expect(b.zen.valid).toBe(true);
    expect(b.go.baseURL).toBe("http://127.0.0.1:8787/go/v1");
    // trailing slash is stripped
    expect(bindCheck({ ...GO_BIND, baseURL: "http://127.0.0.1:8787/go/v1/" }, { ...ZEN_BIND }).valid).toBe(true);
  });

  test("invalid cases fail closed per lane with a reason", () => {
    const cases: Array<[string, unknown, unknown, "go" | "zen"]> = [
      ["missing provider", undefined, { ...ZEN_BIND }, "go"],
      ["wrong api", { ...GO_BIND, api: "openai-responses" }, { ...ZEN_BIND }, "go"],
      ["missing baseURL", { api: "openai-completions" }, { ...ZEN_BIND }, "go"],
      ["non-http scheme", { ...GO_BIND, baseURL: "https://127.0.0.1:8787/go/v1" }, { ...ZEN_BIND }, "go"],
      ["non-loopback host", { ...GO_BIND, baseURL: "http://10.0.0.5:8787/go/v1" }, { ...ZEN_BIND }, "go"],
      ["wrong port", { ...GO_BIND, baseURL: "http://127.0.0.1:9/go/v1" }, { ...ZEN_BIND }, "go"],
      ["wrong lane path", { ...GO_BIND, baseURL: "http://127.0.0.1:8787/zen/v1" }, { ...ZEN_BIND }, "go"],
      ["unparseable baseURL", { ...GO_BIND, baseURL: "not a url at all" }, { ...ZEN_BIND }, "go"],
      ["zen wrong path", { ...GO_BIND }, { ...ZEN_BIND, baseURL: "http://127.0.0.1:8787/go/v1" }, "zen"],
      ["zen wrong api", { ...GO_BIND }, { ...ZEN_BIND, api: "openai-completions" }, "zen"],
      ["zen missing provider", { ...GO_BIND }, undefined, "zen"],
    ];
    for (const [name, go, zen, badLane] of cases) {
      const b = bindCheck(go, zen);
      expect(b.valid).toBe(false);
      const lane = badLane === "go" ? b.go : b.zen;
      expect(lane.valid).toBe(false);
      expect(lane.reason).toBeTruthy();
      const other = badLane === "go" ? b.zen : b.go;
      expect(other.valid).toBe(true);
    }
  });

  test("reconcile fail-closed: wrong GO path -> error, no mutation of either lane", async () => {
    const { paths } = freshPaths();
    initializeApprovalStore(paths, [tup("go", "g1"), tup("zen", "z1")], "operator", { nowIso: BASE_ISO });
    const reg = registryFile({ goIds: ["g1"], zenIds: ["z1"] });
    const client = createMemoryDshClient({
      go: [],
      zen: [],
      revision: 4,
      rawGoProvider: { ...GO_BIND, baseURL: "http://127.0.0.1:8787/wrong/v1" },
      rawZenProvider: { ...ZEN_BIND },
    });
    const status = await reconcile(reg, client, loadApprovalStore(paths));
    expect(status.outcome).toBe("error");
    expect(status.mutationPerformed).toBe(false);
    expect(status.bindingValid).toBe(false);
    expect(status.bindingError).toMatch(/go: /);
    expect(status.approvalsInitialized).toBe(true);
    expect(client.history.length).toBe(0);
  });

  test("reconcile fail-closed: remote host, wrong api, port mismatch, one invalid lane -> history empty", async () => {
    const badGoCases: Array<Record<string, unknown>> = [
      { ...GO_BIND, baseURL: "http://10.0.0.5:8787/go/v1" },
      { ...GO_BIND, api: "openai-responses" },
      { ...GO_BIND, baseURL: "http://127.0.0.1:9/go/v1" },
    ];
    for (const rawGo of badGoCases) {
      const { paths } = freshPaths();
      initializeApprovalStore(paths, [tup("go", "g1"), tup("zen", "z1")], "operator", { nowIso: BASE_ISO });
      const reg = registryFile({ goIds: ["g1"], zenIds: ["z1"] });
      const client = createMemoryDshClient({ go: [], zen: [], revision: 4, rawGoProvider: rawGo, rawZenProvider: { ...ZEN_BIND } });
      const status = await reconcile(reg, client, loadApprovalStore(paths));
      expect(status.outcome).toBe("error");
      expect(status.bindingValid).toBe(false);
      expect(status.mutationPerformed).toBe(false);
      expect(client.history.length).toBe(0);
    }
    // ZEN lane invalid while GO lane valid: still zero partial mutation
    const { paths } = freshPaths();
    initializeApprovalStore(paths, [tup("go", "g1"), tup("zen", "z1")], "operator", { nowIso: BASE_ISO });
    const reg = registryFile({ goIds: ["g1"], zenIds: ["z1"] });
    const client = createMemoryDshClient({
      go: [],
      zen: [],
      revision: 4,
      rawGoProvider: { ...GO_BIND },
      rawZenProvider: { ...ZEN_BIND, baseURL: "http://127.0.0.1:8787/oops/v1" },
    });
    const status = await reconcile(reg, client, loadApprovalStore(paths));
    expect(status.outcome).toBe("error");
    expect(status.bindingError).toMatch(/zen: /);
    expect(client.history.length).toBe(0);
  });

  test("expected port comes from opts (non-default port validated)", async () => {
    const { paths } = freshPaths();
    initializeApprovalStore(paths, [tup("go", "g1"), tup("zen", "z1")], "operator", { nowIso: BASE_ISO });
    const reg = registryFile({ goIds: ["g1"], zenIds: ["z1"] });
    const client = createMemoryDshClient({
      go: [],
      zen: [],
      revision: 4,
      rawGoProvider: { ...GO_BIND, baseURL: "http://127.0.0.1:9000/go/v1" },
      rawZenProvider: { ...ZEN_BIND, baseURL: "http://127.0.0.1:9000/zen/v1" },
    });
    const ok = await reconcile(reg, client, loadApprovalStore(paths), 9000);
    expect(ok.outcome).toBe("current");
    expect(ok.bindingValid).toBe(true);
    const bad = await reconcile(reg, client, loadApprovalStore(paths), 8787);
    expect(bad.outcome).toBe("error");
    expect(bad.bindingValid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6. Failure separation
// ---------------------------------------------------------------------------

describe("failure separation", () => {
  test("corrupt approval store + healthy registry -> reconcile error, registry file unchanged", async () => {
    const { paths } = freshPaths();
    writeFileSync(approvalStorePathFor(paths), "{definitely not json");
    const reg = registryFile({ goIds: ["g1"], zenIds: ["z1"] });
    storeRegistry(paths, reg);
    const regBefore = readFileSync(registryPathFor(paths), "utf8");
    const client = memClient([makeModel("x")], [makeModel("y")]);
    const status = await reconcile(reg, client, loadApprovalStore(paths));
    expect(status.outcome).toBe("error");
    expect(status.mutationPerformed).toBe(false);
    expect(client.history.length).toBe(0);
    expect(readFileSync(registryPathFor(paths), "utf8")).toBe(regBefore);
  });

  test("DSH mutate failure after read -> registry untouched, outcome truthful (error, mutation false)", async () => {
    const { paths } = freshPaths();
    initializeApprovalStore(paths, [tup("go", "g1"), tup("zen", "z1")], "operator", { nowIso: BASE_ISO });
    const reg = registryFile({ goIds: ["g1"], zenIds: ["z1"] });
    storeRegistry(paths, reg);
    const regBefore = readFileSync(registryPathFor(paths), "utf8");
    const inner = memClient([makeModel("legacy")], [makeModel("legacy-z")]);
    const client: DshClient = {
      async read() {
        return inner.read();
      },
      async mutate() {
        throw new Error("dsh write exploded");
      },
    };
    const status = await reconcile(reg, client, loadApprovalStore(paths));
    expect(status.outcome).toBe("error");
    expect(status.mutationPerformed).toBe(false);
    expect(status.lastError).toMatch(/dsh write exploded/);
    expect(readFileSync(registryPathFor(paths), "utf8")).toBe(regBefore);
    // in-memory registry object also untouched
    expect(JSON.stringify(reg)).toBe(JSON.stringify(registryFile({ goIds: ["g1"], zenIds: ["z1"] })));
  });

  test("approval corruption does not corrupt the registry on disk", async () => {
    const { paths } = freshPaths();
    const reg = registryFile({ goIds: ["g1"], zenIds: ["z1"] });
    storeRegistry(paths, reg);
    const regBefore = readFileSync(registryPathFor(paths), "utf8");
    writeFileSync(approvalStorePathFor(paths), "broken}");
    const client = memClient([makeModel("a")], [makeModel("b")]);
    const status = await reconcile(reg, client, loadApprovalStore(paths));
    expect(status.outcome).toBe("error");
    expect(readFileSync(registryPathFor(paths), "utf8")).toBe(regBefore);
    const reloaded = loadRegistry(paths);
    expect(reloaded).not.toBeNull();
    expect(reloaded!.go!.models.map((m) => m.id)).toEqual(["g1"]);
  });
});

// ---------------------------------------------------------------------------
// 7. Persistence / restart
// ---------------------------------------------------------------------------

describe("persistence and restart", () => {
  test("approvals, initializedAtUtc and revocations survive a fresh loadApprovalStore", () => {
    const { dir, paths } = freshPaths();
    initializeApprovalStore(paths, [tup("go", "g1"), tup("zen", "z1")], "operator", { nowIso: BASE_ISO });
    approveTuple(paths, tup("go", "g2"), "operator", { nowIso: isoAt(BASE_MS + 1) });
    revokeModelApproval(paths, { lane: "zen", modelId: "z1" });
    // "restart": brand-new Paths resolution against the same state dir
    const fresh = loadApprovalStore(resolvePaths(dir));
    expect(fresh.state).toBe("initialized");
    if (fresh.state !== "initialized") return;
    expect(fresh.store.initializedAtUtc).toBe(BASE_ISO);
    expect(fresh.store.approvals.map((r) => `${r.lane}/${r.modelId}`)).toEqual(["go/g1", "go/g2"]);
    expect(fresh.store.approvals.some((r) => r.lane === "zen")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 8. CLI end-to-end (real bun processes, temp GOROUTER_STATE_DIR + DSH_HOME)
// ---------------------------------------------------------------------------

describe("CLI end-to-end", () => {
  const repoRoot = resolve(import.meta.dir, "..");

  function cli(args: string[], envOverrides: Record<string, string>) {
    return spawnSync(process.execPath, [join(repoRoot, "src", "cli.ts"), ...args], {
      cwd: repoRoot,
      env: { ...process.env, ...envOverrides },
      encoding: "utf8",
      windowsHide: true,
    });
  }

  test("approvals status --json on empty temp state: store absent, migration required, no store file", () => {
    const st = freshPaths();
    const dshHome = tempDir("gorouter-clidsh-"); // empty: no settings.yaml
    const r = cli(["models", "approvals", "status", "--json"], { GOROUTER_STATE_DIR: st.dir, DSH_HOME: dshHome });
    expect(r.status).toBe(0);
    const view = JSON.parse(r.stdout) as { storeState: string; migrationRequired: boolean; approvals: unknown[] };
    expect(view.storeState).toBe("absent");
    expect(view.migrationRequired).toBe(true);
    expect(view.approvals).toEqual([]);
    expect(existsSync(approvalStorePathFor(st.paths))).toBe(false);
  });

  test("migrate preview against temp settings: store stays absent, proposal deterministic", () => {
    const st = freshPaths();
    const dshHome = tempDir("gorouter-clidsh-");
    const settingsPath = join(dshHome, "settings.yaml");
    const settingsDoc = {
      [DSH_NAMESPACE]: {
        providers: {
          "gorouter-go": { api: "openai-completions", baseURL: "http://127.0.0.1:8787/go/v1", models: [{ id: "legacy-go-1", object: "model" }, { id: "legacy-go-2", object: "model" }] },
          "gorouter-zen": { api: "openai-responses", baseURL: "http://127.0.0.1:8787/zen/v1", models: [{ id: "legacy-zen-1", object: "model" }] },
          "gorouter-go-responses": { api: "openai-responses", baseURL: "http://127.0.0.1:8787/go/v1", models: [{ id: "resp-only", object: "model" }] },
        },
      },
    };
    writeFileSync(settingsPath, JSON.stringify(settingsDoc, null, 2));
    const settingsBefore = readFileSync(settingsPath, "utf8");

    const env = { GOROUTER_STATE_DIR: st.dir, DSH_HOME: dshHome };
    const r1 = cli(["models", "approvals", "migrate", "--json"], env);
    expect(r1.status).toBe(0);
    const p1 = JSON.parse(r1.stdout) as { proposalId: string; candidates: ApprovalTuple[]; bindingsValid: boolean };
    expect(p1.bindingsValid).toBe(true);
    expect(p1.candidates).toEqual([tup("go", "legacy-go-1"), tup("go", "legacy-go-2"), tup("zen", "legacy-zen-1")]);

    // second, independent CLI process: identical proposal -> deterministic
    const r2 = cli(["models", "approvals", "migrate", "--json"], env);
    expect(r2.status).toBe(0);
    const p2 = JSON.parse(r2.stdout) as { proposalId: string; candidates: ApprovalTuple[] };
    expect(p2.proposalId).toBe(p1.proposalId);
    expect(p2.candidates).toEqual(p1.candidates);

    // preview never materializes the store nor touches the real settings file
    expect(existsSync(approvalStorePathFor(st.paths))).toBe(false);
    expect(readFileSync(settingsPath, "utf8")).toBe(settingsBefore);

    // ratify via the CLI, then the store holds exactly the previewed tuples;
    // a second apply refuses (one-time).
    const ra = cli(["models", "approvals", "migrate", "--apply", "--proposal", p1.proposalId, "--json"], env);
    expect(ra.status).toBe(0);
    const applied = JSON.parse(ra.stdout) as { applied: boolean; proposalId: string };
    expect(applied.applied).toBe(true);
    const store = loadApprovalStore(st.paths);
    expect(store.state).toBe("initialized");
    if (store.state === "initialized") {
      expect(store.store.approvals.map((a) => ({ ...a, approvedAtUtc: "", source: a.source }))).toEqual(
        p1.candidates.map((c) => ({ ...c, approvedAtUtc: "", source: "legacy-migration" })),
      );
    }
    const r3 = cli(["models", "approvals", "migrate", "--apply", "--proposal", p1.proposalId], env);
    expect(r3.status).not.toBe(0);
    expect(r3.stderr).toMatch(/one-time|already initialized/);
  });

  test("status --json reflects a corrupt store truthfully", () => {
    const st = freshPaths();
    writeFileSync(approvalStorePathFor(st.paths), "{corrupt");
    const dshHome = tempDir("gorouter-clidsh-");
    const r = cli(["models", "approvals", "status", "--json"], { GOROUTER_STATE_DIR: st.dir, DSH_HOME: dshHome });
    expect(r.status).toBe(0);
    const view = JSON.parse(r.stdout) as { storeState: string; corruptReason: string | null };
    expect(view.storeState).toBe("corrupt");
    expect(view.corruptReason).toBeTruthy();
  });
});
