/**
 * B.1 — Approval-gated DSH reconciliation semantics.
 *
 * Covers the approval-gate status classes and approval-derived eligibility:
 *  absent -> blocked (migrationRequired, zero mutation, no DSH read),
 *  corrupt -> error fail-closed, unsupported-version -> error,
 *  binding-invalid -> error fail-closed (no partial two-lane mutation),
 *  tuple safety (lane/protocol/provider identity), lifecycle
 *  (approved+present / unapproved / approved+absent / reappearance / revoke),
 *  initialized-empty authoritative store, and real approval-store persistence
 *  feeding reconcile from disk.
 * Engine mechanics (offline/no-op/revision/verification/coalescing) live in
 * test/dsh-sync.test.ts.
 */
import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePaths, ensureStateDirs } from "../src/paths.ts";
import type { RegistryFile, ModelEntry } from "../src/models/types.ts";
import { MODELS_SCHEMA_VERSION } from "../src/models/types.ts";
import {
  createMemoryDshClient,
  FileDshClient,
  type DshClient,
  type DshSnapshot,
} from "../src/models/dsh-client.ts";
import { reconcileDshCatalog, clearDshSyncSingleFlightForTests } from "../src/models/dsh-sync.ts";
import {
  APPROVALS_SCHEMA_VERSION,
  OWNED_DSH_PROVIDERS,
  initializeApprovalStore,
  approveTuple,
  revokeModelApproval,
  loadApprovalStore,
  approvalStorePathFor,
  type ApprovalStoreLoad,
  type ApprovalRecord,
} from "../src/models/dsh-approvals.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_ISO = "2026-01-01T00:00:00.000Z";
const dirs: string[] = [];
beforeEach(() => { clearDshSyncSingleFlightForTests(); });
afterEach(() => {
  clearDshSyncSingleFlightForTests();
  for (const d of dirs.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
});

function freshPaths() {
  const dir = mkdtempSync(join(tmpdir(), "gorouter-approvals-"));
  dirs.push(dir);
  const paths = resolvePaths(dir);
  ensureStateDirs(paths);
  return { dir, paths };
}

function makeModel(id: string, extra: Record<string, unknown> = {}): ModelEntry {
  return { id, object: "model", ...extra } as ModelEntry;
}

function laneSnap(ids: string[]): { fetchedAtUtc: string; models: ModelEntry[] } {
  return { fetchedAtUtc: BASE_ISO, models: ids.map((id) => makeModel(id)) };
}

function authoritativeReg(goIds: string[], zenIds: string[]): RegistryFile {
  return {
    schemaVersion: MODELS_SCHEMA_VERSION,
    updatedAtUtc: BASE_ISO,
    go: laneSnap(goIds),
    zen: laneSnap(zenIds),
    lastAttempt: { go: null, zen: null, combinedAtUtc: null },
    lastDiff: [],
  } as RegistryFile;
}

/** Certified owned provider bindings on the canonical local lane routes. */
const GO_BIND = { api: "openai-completions", baseURL: "http://127.0.0.1:8787/go/v1" };
const ZEN_BIND = { api: "openai-responses", baseURL: "http://127.0.0.1:8787/zen/v1" };
const RAW_BINDINGS = { rawGoProvider: { ...GO_BIND }, rawZenProvider: { ...ZEN_BIND } };

function approval(lane: "go" | "zen", modelId: string, overrides: Partial<ApprovalRecord> = {}): ApprovalRecord {
  return {
    lane,
    dshProviderId: OWNED_DSH_PROVIDERS[lane].providerId,
    apiProtocol: OWNED_DSH_PROVIDERS[lane].apiProtocol,
    modelId,
    approvedAtUtc: BASE_ISO,
    source: "operator",
    ...overrides,
  };
}

/** Hand-built initialized approval store view for injection into reconcile. */
function initStore(goIds: string[], zenIds: string[]): ApprovalStoreLoad {
  return {
    state: "initialized",
    store: {
      version: APPROVALS_SCHEMA_VERSION,
      initializedAtUtc: BASE_ISO,
      approvals: [...goIds.map((id) => approval("go", id)), ...zenIds.map((id) => approval("zen", id))],
    },
  };
}

/** Memory client that counts reads (proves gate ordering: gate fires BEFORE any DSH read). */
function countingMemoryClient(initial: Parameters<typeof createMemoryDshClient>[0]): DshClient & { reads: number; mutations: number } {
  const inner = createMemoryDshClient(initial);
  const counter = { reads: 0, mutations: 0 };
  const wrapped = {
    async read() {
      counter.reads += 1;
      return inner.read();
    },
    async mutate(g: ModelEntry[], z: ModelEntry[], r: number) {
      counter.mutations += 1;
      return inner.mutate(g, z, r);
    },
  } as unknown as DshClient & { reads: number; mutations: number };
  Object.defineProperty(wrapped, "reads", { get: () => counter.reads });
  Object.defineProperty(wrapped, "mutations", { get: () => counter.mutations });
  return wrapped;
}

// ---------------------------------------------------------------------------
// 1. Approval gate: absent store -> blocked BEFORE any DSH read
// ---------------------------------------------------------------------------

describe("gate: absent store -> blocked", () => {
  test("absent store: outcome blocked, migrationRequired, zero mutation, zero DSH reads", async () => {
    const reg = authoritativeReg(["go-a", "go-b"], ["zen-x"]);
    const client = countingMemoryClient({ go: [makeModel("stale-go")], zen: [], ...RAW_BINDINGS });
    const st = await reconcileDshCatalog(reg, client); // no approvalStore opt => absent
    expect(st.outcome).toBe("blocked");
    expect(st.mutationPerformed).toBe(false);
    expect(st.approvalsInitialized).toBe(false);
    expect(st.migrationRequired).toBe(true);
    expect(st.reachable).toBeNull();
    expect(st.lastError).toMatch(/migration ratification/);
    // Gate fires BEFORE any DSH read
    expect(client.reads).toBe(0);
    expect(client.mutations).toBe(0);
  });

  test("absent store with populated owned arrays: arrays byte-identical (memory client history empty)", async () => {
    const reg = authoritativeReg(["go-a"], ["zen-x"]);
    const seededGo = [makeModel("legacy-go", { displayName: "Legacy" })];
    const seededZen = [makeModel("legacy-zen"), makeModel("legacy-zen-2")];
    const client = countingMemoryClient({ go: seededGo, zen: seededZen, ...RAW_BINDINGS });
    const before = await client.read();
    const st = await reconcileDshCatalog(reg, client);
    expect(st.outcome).toBe("blocked");
    const after = await client.read();
    expect(after!.go).toEqual(before!.go);
    expect(after!.zen).toEqual(before!.zen);
    expect(after!.go.map((m) => m.id)).toEqual(["legacy-go"]);
    expect(after!.zen.map((m) => m.id)).toEqual(["legacy-zen", "legacy-zen-2"]);
  });

  test("absent store: withheld counts equal registry lane counts", async () => {
    const reg = authoritativeReg(["go-a", "go-b", "go-c"], ["zen-x", "zen-y"]);
    const client = countingMemoryClient({ go: [], zen: [], ...RAW_BINDINGS });
    const st = await reconcileDshCatalog(reg, client);
    expect(st.outcome).toBe("blocked");
    expect(st.withheldGoCount).toBe(3);
    expect(st.withheldZenCount).toBe(2);
    expect(st.activeGoCount).toBeNull();
    expect(st.activeZenCount).toBeNull();
    expect(st.approvedAbsentGoCount).toBeNull();
    expect(st.approvedAbsentZenCount).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. Approval gate: corrupt store -> error fail-closed
// ---------------------------------------------------------------------------

describe("gate: corrupt store -> error", () => {
  test("corrupt store: outcome error, actionable message, no DSH read, no mutation", async () => {
    const reg = authoritativeReg(["go-a"], ["zen-x"]);
    const corrupt: ApprovalStoreLoad = { state: "corrupt", reason: "approval store root must be an object" };
    const client = countingMemoryClient({ go: [makeModel("keep")], zen: [makeModel("keepz")], ...RAW_BINDINGS });
    const st = await reconcileDshCatalog(reg, client, { approvalStore: corrupt });
    expect(st.outcome).toBe("error");
    expect(st.mutationPerformed).toBe(false);
    expect(st.approvalsInitialized).toBe(false);
    expect(st.migrationRequired).toBe(false);
    expect(st.lastError).toMatch(/corrupt/);
    expect(st.lastError).toMatch(/NOT auto-reset/);
    expect(client.reads).toBe(0);
    expect(client.mutations).toBe(0);
  });

  test("unsupported-version store: outcome error with version in message, no mutation", async () => {
    const reg = authoritativeReg(["go-a"], ["zen-x"]);
    const future: ApprovalStoreLoad = { state: "unsupported-version", version: 2 };
    const client = countingMemoryClient({ go: [makeModel("keep")], zen: [makeModel("keepz")], ...RAW_BINDINGS });
    const st = await reconcileDshCatalog(reg, client, { approvalStore: future });
    expect(st.outcome).toBe("error");
    expect(st.mutationPerformed).toBe(false);
    expect(st.approvalsInitialized).toBe(false);
    expect(st.migrationRequired).toBe(false);
    expect(st.lastError).toContain("2");
    expect(client.reads).toBe(0);
    expect(client.mutations).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Approval gate: binding-invalid -> error fail-closed, no partial mutation
// ---------------------------------------------------------------------------

describe("gate: invalid owned provider bindings -> fail closed", () => {
  const REG = authoritativeReg(["go-a"], ["zen-x"]);

  async function expectBindingFailure(bindings: { rawGoProvider?: Record<string, unknown> | null; rawZenProvider?: Record<string, unknown> | null }, match: RegExp) {
    const client = countingMemoryClient({
      go: [makeModel("existing-go")],
      zen: [makeModel("existing-zen")],
      rawGoProvider: bindings.rawGoProvider === undefined ? { ...GO_BIND } : bindings.rawGoProvider,
      rawZenProvider: bindings.rawZenProvider === undefined ? { ...ZEN_BIND } : bindings.rawZenProvider,
    });
    const st = await reconcileDshCatalog(REG, client, { approvalStore: initStore(["go-a"], ["zen-x"]) });
    expect(st.outcome).toBe("error");
    expect(st.mutationPerformed).toBe(false);
    expect(st.bindingValid).toBe(false);
    expect(st.bindingError).toMatch(match);
    expect(st.approvalsInitialized).toBe(true);
    expect(st.migrationRequired).toBe(false);
    // No partial two-lane mutation: zero mutations, arrays untouched
    expect(client.mutations).toBe(0);
    const snap = await client.read();
    expect(snap!.go.map((m) => m.id)).toEqual(["existing-go"]);
    expect(snap!.zen.map((m) => m.id)).toEqual(["existing-zen"]);
    return st;
  }

  test("missing owned providers entirely (null raw bindings)", async () => {
    await expectBindingFailure({ rawGoProvider: null, rawZenProvider: null }, /missing from DSH settings/);
  });

  test("wrong GO lane path fails closed (zen provider pointing at /go/v1 pattern)", async () => {
    await expectBindingFailure(
      { rawGoProvider: { api: "openai-completions", baseURL: "http://127.0.0.1:8787/zen/v1" } },
      /gorouter-go.*lane path/,
    );
  });

  test("wrong ZEN lane path fails closed", async () => {
    await expectBindingFailure(
      { rawZenProvider: { api: "openai-responses", baseURL: "http://127.0.0.1:8787/go/v1" } },
      /gorouter-zen.*lane path/,
    );
  });

  test("remote (non-loopback) host fails closed", async () => {
    await expectBindingFailure(
      { rawGoProvider: { api: "openai-completions", baseURL: "http://10.0.0.5:8787/go/v1" } },
      /not loopback/,
    );
  });

  test("port mismatch fails closed", async () => {
    await expectBindingFailure(
      { rawZenProvider: { api: "openai-responses", baseURL: "http://127.0.0.1:9/zen/v1" } },
      /port 9 != canonical/,
    );
  });

  test("wrong api protocol fails closed", async () => {
    await expectBindingFailure(
      { rawGoProvider: { api: "openai-chat", baseURL: "http://127.0.0.1:8787/go/v1" } },
      /api protocol 'openai-chat' != certified 'openai-completions'/,
    );
  });

  test("expectedPort opt propagates: reconcile honors a non-default canonical port", async () => {
    const client = countingMemoryClient({
      go: [makeModel("g")],
      zen: [makeModel("z")],
      rawGoProvider: { api: "openai-completions", baseURL: "http://127.0.0.1:9001/go/v1" },
      rawZenProvider: { ...ZEN_BIND, baseURL: "http://127.0.0.1:9001/zen/v1" },
    });
    const st = await reconcileDshCatalog(REG, client, { approvalStore: initStore(["go-a"], ["zen-x"]), expectedPort: 9001 });
    expect(st.outcome).toBe("current");
    expect(st.bindingValid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. Tuple safety: approval identity is exact (lane, owned provider, protocol, model)
// ---------------------------------------------------------------------------

describe("tuple safety", () => {
  test("same model id approved on go does not activate on zen and vice versa", async () => {
    const reg = authoritativeReg(["shared"], ["shared"]);
    const client = createMemoryDshClient({ go: [], zen: [], ...RAW_BINDINGS });
    const st = await reconcileDshCatalog(reg, client as DshClient, { approvalStore: initStore(["shared"], []) });
    expect(st.outcome).toBe("current");
    const snap = await client.read();
    expect(snap!.go.map((m) => m.id)).toEqual(["shared"]);       // approved on go -> active
    expect(snap!.zen.map((m) => m.id)).toEqual([]);              // NOT approved on zen -> withheld
    expect(st.withheldZenCount).toBe(1);
  });

  test("stale protocol tuple (openai-chat approval) does not activate on the current certified protocol", async () => {
    const reg = authoritativeReg(["legacy"], []);
    const store: ApprovalStoreLoad = {
      state: "initialized",
      store: { version: 1, initializedAtUtc: BASE_ISO, approvals: [approval("go", "legacy", { apiProtocol: "openai-chat" })] },
    };
    const client = createMemoryDshClient({ go: [], zen: [], ...RAW_BINDINGS });
    const st = await reconcileDshCatalog(reg, client as DshClient, { approvalStore: store });
    const snap = await client.read();
    expect(snap!.go.map((m) => m.id)).toEqual([]); // stale tuple never activates
    expect(st.withheldGoCount).toBe(1);
  });

  test("wrong provider (gorouter-go-responses) approval does not activate", async () => {
    const reg = authoritativeReg(["foreign"], []);
    const store: ApprovalStoreLoad = {
      state: "initialized",
      store: { version: 1, initializedAtUtc: BASE_ISO, approvals: [approval("go", "foreign", { dshProviderId: "gorouter-go-responses" })] },
    };
    const client = createMemoryDshClient({ go: [], zen: [], ...RAW_BINDINGS });
    const st = await reconcileDshCatalog(reg, client as DshClient, { approvalStore: store });
    const snap = await client.read();
    expect(snap!.go.map((m) => m.id)).toEqual([]);
    expect(st.withheldGoCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 5. Lifecycle: eligibility transitions
// ---------------------------------------------------------------------------

describe("lifecycle", () => {
  test("approved+present -> active (mutated in); unapproved+present -> withheld and removed", async () => {
    const reg = authoritativeReg(["approved", "unapproved"], ["zen-x"]);
    const client = createMemoryDshClient({ go: [], zen: [], ...RAW_BINDINGS });
    const st = await reconcileDshCatalog(reg, client as DshClient, { approvalStore: initStore(["approved"], ["zen-x"]) });
    expect(st.outcome).toBe("current");
    const snap = await client.read();
    expect(snap!.go.map((m) => m.id)).toEqual(["approved"]);
    expect(st.withheldGoCount).toBe(1);
    expect(st.activeGoCount).toBe(1);
  });

  test("approved+absent -> removed from arrays (inactive), approval retained in store", async () => {
    const reg = authoritativeReg(["go-a"], []); // zen-gone approved but absent upstream
    const store = initStore(["go-a"], ["zen-gone"]);
    const client = createMemoryDshClient({ go: [], zen: [makeModel("zen-gone")], ...RAW_BINDINGS });
    const st = await reconcileDshCatalog(reg, client as DshClient, { approvalStore: store });
    expect(st.outcome).toBe("current");
    const snap = await client.read();
    expect(snap!.zen.map((m) => m.id)).toEqual([]);
    expect(st.approvedAbsentZenCount).toBe(1);
    // approval retained in the (hand-built) store view
    const zenApprovals = store.state === "initialized" ? store.store.approvals.filter((r) => r.lane === "zen") : [];
    expect(zenApprovals.map((r) => r.modelId)).toEqual(["zen-gone"]);
  });

  test("identical tuple reappearance: registry regains a previously approved-absent id -> active again", async () => {
    const approved = initStore(["go-a", "returning"], ["zen-x"]);
    // Round 1: absent upstream -> inactive
    const reg1 = authoritativeReg(["go-a"], ["zen-x"]);
    const client1 = createMemoryDshClient({ go: [], zen: [], ...RAW_BINDINGS });
    await reconcileDshCatalog(reg1, client1 as DshClient, { approvalStore: approved });
    // Round 2: registry regains the id -> becomes newly eligible and active
    clearDshSyncSingleFlightForTests();
    const reg2 = authoritativeReg(["go-a", "returning"], ["zen-x"]);
    const client2 = createMemoryDshClient({ go: [makeModel("go-a")], zen: [], ...RAW_BINDINGS });
    const st2 = await reconcileDshCatalog(reg2, client2 as DshClient, { approvalStore: approved });
    expect(st2.outcome).toBe("current");
    const snap2 = await client2.read();
    expect(snap2!.go.map((m) => m.id)).toEqual(["go-a", "returning"]);
  });
});

// ---------------------------------------------------------------------------
// 6. Initialized-empty store: authoritative empty clears arrays coherently
// ---------------------------------------------------------------------------

describe("initialized-empty store", () => {
  test("empty approvals + populated owned arrays -> one coherent mutation clears both lanes", async () => {
    const reg = authoritativeReg(["go-a"], ["zen-x"]);
    const client = createMemoryDshClient({ go: [makeModel("legacy-go")], zen: [makeModel("legacy-zen")], ...RAW_BINDINGS }) as DshClient & { history: Array<{ go: ModelEntry[]; zen: ModelEntry[] }> };
    const st = await reconcileDshCatalog(reg, client, { approvalStore: initStore([], []) });
    expect(st.outcome).toBe("current");
    expect(st.mutationPerformed).toBe(true);
    expect(client.history.length).toBe(1);
    expect(client.history[0]!.go).toEqual([]);
    expect(client.history[0]!.zen).toEqual([]);
    expect(st.activeGoCount).toBe(0);
    expect(st.activeZenCount).toBe(0);
    expect(st.withheldGoCount).toBe(1);
    expect(st.withheldZenCount).toBe(1);
  });

  test("missing (absent) vs initialized-empty are distinct: absent blocks, empty authorizes", async () => {
    const reg = authoritativeReg(["g"], ["z"]);
    const blocked = countingMemoryClient({ go: [makeModel("x")], zen: [makeModel("y")], ...RAW_BINDINGS });
    const s1 = await reconcileDshCatalog(reg, blocked);
    expect(s1.outcome).toBe("blocked");
    expect(blocked.reads).toBe(0);
    clearDshSyncSingleFlightForTests();
    const cleared = createMemoryDshClient({ go: [makeModel("x")], zen: [makeModel("y")], ...RAW_BINDINGS });
    const s2 = await reconcileDshCatalog(reg, cleared as DshClient, { approvalStore: initStore([], []) });
    expect(s2.outcome).toBe("current");
    expect(s2.mutationPerformed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 7. Real approval store on disk feeding reconcile (persistence/restart)
// ---------------------------------------------------------------------------

describe("real approval store persistence feeds reconcile", () => {
  test("initialize -> load in a fresh loadApprovalStore -> approvals survive and drive eligibility", async () => {
    const { paths } = freshPaths();
    // Absent first
    expect(loadApprovalStore(paths).state).toBe("absent");
    initializeApprovalStore(
      paths,
      [
        { lane: "go", dshProviderId: OWNED_DSH_PROVIDERS.go.providerId, apiProtocol: OWNED_DSH_PROVIDERS.go.apiProtocol, modelId: "go-a" },
        { lane: "zen", dshProviderId: OWNED_DSH_PROVIDERS.zen.providerId, apiProtocol: OWNED_DSH_PROVIDERS.zen.apiProtocol, modelId: "zen-x" },
      ],
      "operator",
      { nowIso: BASE_ISO },
    );
    const loaded = loadApprovalStore(paths);
    expect(loaded.state).toBe("initialized");
    if (loaded.state !== "initialized") return; // narrowing
    expect(loaded.store.initializedAtUtc).toBe(BASE_ISO);
    expect(loaded.store.approvals.map((r) => [r.lane, r.modelId])).toEqual([["go", "go-a"], ["zen", "zen-x"]]);
    // The freshly-loaded store drives reconcile identically to a hand-built view
    const reg = authoritativeReg(["go-a", "go-b"], ["zen-x", "zen-y"]);
    const client = createMemoryDshClient({ go: [], zen: [], ...RAW_BINDINGS });
    const st = await reconcileDshCatalog(reg, client as DshClient, { approvalStore: loaded });
    expect(st.outcome).toBe("current");
    const snap = await client.read();
    expect(snap!.go.map((m) => m.id)).toEqual(["go-a"]);
    expect(snap!.zen.map((m) => m.id)).toEqual(["zen-x"]);
  });

  test("approve is idempotent; revoke removes and reconcile drops the model from arrays", async () => {
    const { paths } = freshPaths();
    initializeApprovalStore(paths, [], "operator", { nowIso: BASE_ISO });
    const t = { lane: "go" as const, dshProviderId: OWNED_DSH_PROVIDERS.go.providerId, apiProtocol: OWNED_DSH_PROVIDERS.go.apiProtocol, modelId: "go-a" };
    const first = approveTuple(paths, t, "operator", { nowIso: BASE_ISO });
    expect(first.duplicate).toBe(false);
    const again = approveTuple(paths, t, "operator", { nowIso: BASE_ISO });
    expect(again.duplicate).toBe(true);
    // Active via the persisted store
    const reg = authoritativeReg(["go-a"], []);
    const client1 = createMemoryDshClient({ go: [], zen: [], ...RAW_BINDINGS });
    const s1 = await reconcileDshCatalog(reg, client1 as DshClient, { approvalStore: loadApprovalStore(paths) });
    expect(s1.outcome).toBe("current");
    expect((await client1.read())!.go.map((m) => m.id)).toEqual(["go-a"]);
    clearDshSyncSingleFlightForTests();
    // Revoke -> model drops out of arrays on next reconcile
    const rev = revokeModelApproval(paths, { lane: "go", modelId: "go-a" });
    expect(rev.removed).toBe(1);
    const client2 = createMemoryDshClient({ go: [makeModel("go-a")], zen: [], ...RAW_BINDINGS });
    const s2 = await reconcileDshCatalog(reg, client2 as DshClient, { approvalStore: loadApprovalStore(paths) });
    expect(s2.outcome).toBe("current");
    expect((await client2.read())!.go.map((m) => m.id)).toEqual([]);
  });

  test("corrupt store file: load rejects+preserves verbatim; reconcile fails closed; refused mutation never truncates", async () => {
    const { paths } = freshPaths();
    ensureStateDirs(paths);
    const storePath = approvalStorePathFor(paths);
    const corruptBytes = "{ not json at all";
    writeFileSync(storePath, corruptBytes, "utf8");
    const loaded = loadApprovalStore(paths);
    expect(loaded.state).toBe("corrupt");
    // Reconcile against the corrupt store fails closed with no DSH I/O
    const reg = authoritativeReg(["go-a"], ["zen-x"]);
    const client = createMemoryDshClient({ go: [makeModel("keep")], zen: [makeModel("keepz")], ...RAW_BINDINGS });
    const st = await reconcileDshCatalog(reg, client as DshClient, { approvalStore: loaded });
    expect(st.outcome).toBe("error");
    expect(st.mutationPerformed).toBe(false);
    // File bytes unchanged after the refused mutation path
    expect(readFileSync(storePath, "utf8")).toBe(corruptBytes);
    // initializeApprovalStore refuses to overwrite the corrupt file
    expect(() => initializeApprovalStore(paths, [], "operator", { nowIso: BASE_ISO })).toThrow();
    expect(readFileSync(storePath, "utf8")).toBe(corruptBytes);
    expect(existsSync(storePath)).toBe(true);
  });

  test("initialize is one-time: second initialize refuses (valid store preserved)", async () => {
    const { paths } = freshPaths();
    initializeApprovalStore(paths, [], "operator", { nowIso: BASE_ISO });
    const before = readFileSync(approvalStorePathFor(paths), "utf8");
    expect(() => initializeApprovalStore(paths, [], "operator", { nowIso: BASE_ISO })).toThrow();
    expect(readFileSync(approvalStorePathFor(paths), "utf8")).toBe(before);
  });

  test("unsupported-version file preserved verbatim through reconcile", async () => {
    const { paths } = freshPaths();
    ensureStateDirs(paths);
    const storePath = approvalStorePathFor(paths);
    const v2Bytes = JSON.stringify({ version: 2, initializedAtUtc: BASE_ISO, approvals: [] });
    writeFileSync(storePath, v2Bytes, "utf8");
    const loaded = loadApprovalStore(paths);
    expect(loaded.state).toBe("unsupported-version");
    const reg = authoritativeReg(["g"], ["z"]);
    const st = await reconcileDshCatalog(reg, createMemoryDshClient({ go: [], zen: [], ...RAW_BINDINGS }) as DshClient, { approvalStore: loaded });
    expect(st.outcome).toBe("error");
    expect(st.lastError).toContain("2");
    expect(readFileSync(storePath, "utf8")).toBe(v2Bytes);
  });
});

// ---------------------------------------------------------------------------
// 8. Provider metadata preserved through approval-gated FileDshClient reconcile
// ---------------------------------------------------------------------------

describe("FileDshClient metadata under approval gating", () => {
  test("binding metadata on owned providers survives an approval-gated mutation; unrelated provider untouched", async () => {
    const { paths } = freshPaths();
    const settingsPath = join(paths.state, "settings.yaml");
    const initialDoc = {
      "llm-pi-ai": {
        providers: {
          "gorouter-go": { displayName: "Go", api: "openai-completions", baseURL: "http://127.0.0.1:8787/go/v1", apiKeyEnv: "OPENCODE_API_KEY", models: [{ id: "go-a" }] },
          "gorouter-zen": { displayName: "Zen", api: "openai-responses", baseURL: "http://127.0.0.1:8787/zen/v1", models: [{ id: "zen-x" }] },
          "openrouter": { displayName: "OpenRouter", api: "openai", models: [{ id: "other" }] },
        },
      },
    };
    writeFileSync(settingsPath, JSON.stringify(initialDoc, null, 2), "utf8");
    const client = new FileDshClient(settingsPath, null);
    const reg = authoritativeReg(["go-a", "go-new"], ["zen-x"]);
    const st = await reconcileDshCatalog(reg, client as unknown as DshClient, { approvalStore: initStore(["go-a", "go-new"], ["zen-x"]) });
    expect(st.outcome).toBe("current");
    const raw = JSON.parse(readFileSync(settingsPath, "utf8")) as { "llm-pi-ai": { providers: Record<string, Record<string, unknown>> } };
    const providers = raw["llm-pi-ai"].providers;
    // Binding-relevant metadata (api/baseURL) — the approval-gate's own inputs — preserved verbatim
    expect(providers["gorouter-go"]!["api"]).toBe("openai-completions");
    expect(providers["gorouter-go"]!["baseURL"]).toBe("http://127.0.0.1:8787/go/v1");
    expect(providers["gorouter-go"]!["displayName"]).toBe("Go");
    expect(providers["gorouter-zen"]!["api"]).toBe("openai-responses");
    expect(providers["gorouter-zen"]!["baseURL"]).toBe("http://127.0.0.1:8787/zen/v1");
    // Unrelated provider untouched
    expect(providers["openrouter"]!["models"]).toEqual([{ id: "other" }]);
    // Models updated per approvals
    expect((providers["gorouter-go"]!["models"] as ModelEntry[]).map((m) => m.id).sort()).toEqual(["go-a", "go-new"]);
  });
});

// ---------------------------------------------------------------------------
// 9. Success status contract: approval fields on success outcomes
// ---------------------------------------------------------------------------

describe("success status contract", () => {
  test("current outcome carries approvalsInitialized:true, migrationRequired:false, bindingValid:true, approvedAbsent counts", async () => {
    const reg = authoritativeReg(["go-a"], []); // zen-gone approved but absent
    const client = createMemoryDshClient({ go: [], zen: [], ...RAW_BINDINGS });
    const st = await reconcileDshCatalog(reg, client as DshClient, { approvalStore: initStore(["go-a"], ["zen-gone"]) });
    expect(st.outcome).toBe("current");
    expect(st.approvalsInitialized).toBe(true);
    expect(st.migrationRequired).toBe(false);
    expect(st.bindingValid).toBe(true);
    expect(st.bindingError).toBeNull();
    expect(st.approvedAbsentGoCount).toBe(0);
    expect(st.approvedAbsentZenCount).toBe(1);
    expect(st.lastError).toBeNull();
    expect(st.lastSuccessAt).not.toBeNull();
  });
});
