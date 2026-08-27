import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function makeModel(id: string, extra: Record<string, unknown> = {}) { return { id, object: "model" as const, created: 1, owned_by: "test", ...extra }; }

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) try { rmSync(d, { recursive: true, force: true }); } catch {}
});

// ---------------------------------------------------------------------------
// R3-1 cross-process lost-update: file .lock serialization
// FILE_SHARED_LOCK_MECHANISM = <file>.lock wx exclusive (dsh-atomic-write)
// ---------------------------------------------------------------------------

describe("R3-1 cross-process lost-update (file .lock serialization)", () => {
  test("R3-1a: B mutates before A, A stale mutate conflicts not overwrite", async () => {
    const { FileDshClient } = await import("../src/models/dsh-client.ts");
    const dir = mkdtempSync(join(tmpdir(), "gorouter-r3a-")); dirs.push(dir);
    const settingsPath = join(dir, "settings.yaml");
    const initialYaml = "# r3-1a initial\nunrelatedKey: keep-me\nanother: 123\nllm-pi-ai:\n  providers:\n    gorouter-go:\n      models:\n        - id: a\n          object: model\n    gorouter-zen:\n      models:\n        - id: b\n          object: model\n";
    writeFileSync(settingsPath, initialYaml, "utf8");
    const clientA = new FileDshClient(settingsPath);
    const snapA = await clientA.read();
    const revA = snapA!.revision;
    const clientB = new FileDshClient(settingsPath);
    const snapB = await clientB.read();
    await clientB.mutate([makeModel("a"), makeModel("b-external")], [makeModel("b")], snapB!.revision);
    expect(readFileSync(settingsPath, "utf8")).toContain("b-external");
    await expect(clientA.mutate([makeModel("a"), makeModel("a-stale")], [makeModel("b")], revA)).rejects.toThrow();
    const fin = await clientA.read();
    expect(fin!.go.map(m=>m.id)).toContain("b-external");
    expect(fin!.go.map(m=>m.id)).not.toContain("a-stale");
  });

  test("R3-1b: concurrent mutates from same revision exactly one wins", async () => {
    const { FileDshClient, isConflictError } = await import("../src/models/dsh-client.ts");
    const dir = mkdtempSync(join(tmpdir(), "gorouter-r3b-")); dirs.push(dir);
    const settingsPath = join(dir, "settings.yaml");
    const initialYaml = "meta: before\nllm-pi-ai:\n  providers:\n    gorouter-go:\n      models:\n        - id: a\n    gorouter-zen:\n      models:\n        - id: b\n";
    writeFileSync(settingsPath, initialYaml, "utf8");
    const clientA = new FileDshClient(settingsPath);
    const clientB = new FileDshClient(settingsPath);
    const snapA = await clientA.read(); const snapB = await clientB.read();
    expect(snapA!.revision).toBe(snapB!.revision);
    const results = await Promise.allSettled([
      clientA.mutate([makeModel("a"), makeModel("a-winner")], [makeModel("b")], snapA!.revision),
      clientB.mutate([makeModel("a"), makeModel("b-winner")], [makeModel("b")], snapB!.revision),
    ]);
    const ful = results.filter(r=>r.status==="fulfilled"); const rej = results.filter(r=>r.status==="rejected");
    expect(ful.length).toBe(1); expect(rej.length).toBe(1);
    expect(isConflictError((rej[0] as PromiseRejectedResult).reason)).toBe(true);
    const fin = await clientA.read(); const ids = fin!.go.map(m=>m.id);
    expect((ids.includes("a-winner")?1:0)+(ids.includes("b-winner")?1:0)).toBe(1);
  });

  test("R3-1c: unrelated YAML keys survive locked mutation", async () => {
    const { FileDshClient } = await import("../src/models/dsh-client.ts");
    const { parse: yamlParse } = await import("yaml");
    const dir = mkdtempSync(join(tmpdir(), "gorouter-r3c-")); dirs.push(dir);
    const settingsPath = join(dir, "settings.yaml");
    const initialYaml = "# comment survives\nui-onboarding: done\nagent-presets:\n  foo: bar\nllm-pi-ai:\n  providers:\n    gorouter-go:\n      models:\n        - id: old\n    gorouter-zen:\n      models:\n        - id: zold\npermission: allow\n";
    writeFileSync(settingsPath, initialYaml, "utf8");
    const client = new FileDshClient(settingsPath);
    const snap = await client.read();
    await client.mutate([makeModel("new-go")], [makeModel("new-zen")], snap!.revision);
    const doc = yamlParse(readFileSync(settingsPath, "utf8")) as Record<string,unknown>;
    expect(doc["ui-onboarding"]).toBe("done");
    expect((doc["agent-presets"] as Record<string,unknown>)?.["foo"]).toBe("bar");
    expect(doc["permission"]).toBe("allow");
    const prov = ((doc["llm-pi-ai"] as Record<string,unknown>)?.["providers"] as Record<string,unknown>);
    expect(((prov?.["gorouter-go"] as Record<string,unknown>)?.["models"] as Array<Record<string,unknown>>)?.some(m=>m["id"]==="new-go")).toBe(true);
    expect(((prov?.["gorouter-zen"] as Record<string,unknown>)?.["models"] as Array<Record<string,unknown>>)?.some(m=>m["id"]==="new-zen")).toBe(true);
  });

  test("R3-1d: real YAML non-JSON round-trip (bundled yaml)", async () => {
    const { FileDshClient } = await import("../src/models/dsh-client.ts");
    const dir = mkdtempSync(join(tmpdir(), "gorouter-r3d-")); dirs.push(dir);
    const settingsPath = join(dir, "settings.yaml");
    const yamlOnly = "# YAML-only not JSON\ndefaults: &defaults\n  retry: 3\nmeta:\n  <<: *defaults\n  name: 'hash'\nllm-pi-ai:\n  providers:\n    gorouter-go:\n      models: []\n    gorouter-zen:\n      models: []\n";
    expect(()=>JSON.parse(yamlOnly)).toThrow();
    writeFileSync(settingsPath, yamlOnly, "utf8");
    const client = new FileDshClient(settingsPath);
    const snap = await client.read();
    expect(snap).not.toBeNull(); expect(snap!.go.length).toBe(0);
    await client.mutate([makeModel("a")], [makeModel("b")], snap!.revision);
    expect((await client.read())!.go.map(m=>m.id)).toEqual(["a"]);
    writeFileSync(settingsPath, yamlOnly, "utf8");
    expect((await client.read())!.go.length).toBe(0);
  });
});
