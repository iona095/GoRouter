/**
 * H0 DSH adapter capture (C03): the actual frozen FileDshClient adapter runs
 * against synthetic settings only. Proves read/mutate round-trip fidelity,
 * unrelated-content preservation, and reconcile publication of approved
 * registry models. The file seam emits no HTTP/session/User-Agent traffic by
 * construction (fs+yaml+lock only); no listeners exist in containment.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileDshClient } from "../src/models/dsh-client.ts";
import { reconcileDshCatalog } from "../src/models/dsh-sync.ts";
import { loadApprovalStore } from "../src/models/dsh-approvals.ts";
import { resolvePaths } from "../src/paths.ts";
import type { RegistryFile } from "../src/models/types.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function synthHome(): string {
  const d = mkdtempSync(join(tmpdir(), "h0-dsh-"));
  dirs.push(d);
  return d;
}

const SETTINGS_YAML = `other-tool:
  keep: true
llm-pi-ai:
  providers:
    gorouter-go:
      api: openai-completions
      baseURL: http://127.0.0.1:8787/go/v1
      models:
        - id: old-go
    gorouter-zen:
      api: openai-responses
      baseURL: http://127.0.0.1:8787/zen/v1
      models:
        - id: old-zen
    other-provider:
      models:
        - id: keep-me
`;

function registryWith(goIds: string[], zenIds: string[]): RegistryFile {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    updatedAtUtc: now,
    go: { fetchedAtUtc: now, models: goIds.map((id) => ({ id })) },
    zen: { fetchedAtUtc: now, models: zenIds.map((id) => ({ id })) },
    lastAttempt: { go: null, zen: null, combinedAtUtc: null },
    lastDiff: [],
  };
}

describe("h0 DSH file-adapter capture", () => {
  test("read parses owned arrays; identity is stable", async () => {
    const home = synthHome();
    const settingsPath = join(home, "settings.yaml");
    writeFileSync(settingsPath, SETTINGS_YAML);
    const client = new FileDshClient(settingsPath);
    const snap = await client.read();
    expect(snap).not.toBeNull();
    expect(snap!.go.map((m) => m.id)).toEqual(["old-go"]);
    expect(snap!.zen.map((m) => m.id)).toEqual(["old-zen"]);
    expect(client.identity()).toBe(client.identity());
    expect(client.identity()).toContain("file:");
  });

  test("mutate commits desired arrays and preserves unrelated content", async () => {
    const home = synthHome();
    const settingsPath = join(home, "settings.yaml");
    writeFileSync(settingsPath, SETTINGS_YAML);
    const client = new FileDshClient(settingsPath);
    const before = await client.read();
    const r = await client.mutate([{ id: "new-go" }], [{ id: "new-zen" }], before!.revision);
    expect(r.revision).not.toBe(before!.revision);
    const after = await client.read();
    expect(after!.go.map((m) => m.id)).toEqual(["new-go"]);
    expect(after!.zen.map((m) => m.id)).toEqual(["new-zen"]);
    const raw = readFileSync(settingsPath, "utf8");
    expect(raw).toContain("keep-me");
    expect(raw).toContain("keep: true");
  });

  test("reconcile publishes fully-approved registry models to synthetic settings", async () => {
    const home = synthHome();
    const settingsPath = join(home, "settings.yaml");
    writeFileSync(settingsPath, SETTINGS_YAML);
    const stateDir = mkdtempSync(join(tmpdir(), "h0-dsh-state-"));
    dirs.push(stateDir);
    const paths = resolvePaths(stateDir);
    const { mkdirSync } = await import("node:fs");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      paths.dshApprovalsJson,
      JSON.stringify({
        version: 1,
        initializedAtUtc: new Date().toISOString(),
        approvals: [
          { lane: "go", dshProviderId: "gorouter-go", apiProtocol: "openai-completions", modelId: "m1", approvedAtUtc: new Date().toISOString(), source: "operator" },
          { lane: "zen", dshProviderId: "gorouter-zen", apiProtocol: "openai-responses", modelId: "z1", approvedAtUtc: new Date().toISOString(), source: "operator" },
        ],
      }),
    );
    const client = new FileDshClient(settingsPath);
    const st = await reconcileDshCatalog(registryWith(["m1"], ["z1"]), client, {
      approvalStore: loadApprovalStore(paths),
      reloadApprovalStore: () => loadApprovalStore(paths),
      expectedPort: 8787,
    } as never);
    expect(st.mutationPerformed).toBe(true);
    const snap = await client.read();
    expect(snap!.go.map((m) => m.id)).toEqual(["m1"]);
    expect(snap!.zen.map((m) => m.id)).toEqual(["z1"]);
  });

  test("reconcile with absent approval store blocks without mutating (fail-closed gate)", async () => {
    const home = synthHome();
    const settingsPath = join(home, "settings.yaml");
    writeFileSync(settingsPath, SETTINGS_YAML);
    const stateDir = mkdtempSync(join(tmpdir(), "h0-dsh-state-"));
    dirs.push(stateDir);
    const { mkdirSync } = await import("node:fs");
    mkdirSync(stateDir, { recursive: true });
    const client = new FileDshClient(settingsPath);
    const paths = resolvePaths(stateDir);
    const st = await reconcileDshCatalog(registryWith(["m1"], ["z1"]), client, {
      approvalStore: loadApprovalStore(paths),
      reloadApprovalStore: () => loadApprovalStore(paths),
    } as never);
    expect(st.mutationPerformed).toBe(false);
    expect(st.outcome).toBe("blocked");
    const snap = await client.read();
    expect(snap!.go.map((m) => m.id)).toEqual(["old-go"]);
  });
});
