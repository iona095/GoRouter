/**
 * State-file quarantine: a corrupt state.json must be preserved as evidence
 * (F-19) instead of being served-and-forgotten or overwritten by the next
 * mutation.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePaths, ensureStateDirs } from "../src/paths.ts";
import { createStateStore } from "../src/state.ts";
import { memSecrets } from "./harness.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function freshStateDir(): { dir: string; stateJson: string } {
  const dir = mkdtempSync(join(tmpdir(), "gorouter-state-"));
  dirs.push(dir);
  const paths = resolvePaths(dir);
  ensureStateDirs(paths);
  return { dir, stateJson: paths.stateJson };
}

describe("corrupt state quarantine (F-19)", () => {
  test("corrupt state.json is quarantined, defaults served, health flags it", () => {
    const { dir, stateJson } = freshStateDir();
    const garbage = "{not json!!";
    writeFileSync(stateJson, garbage);
    const store = createStateStore(resolvePaths(dir), memSecrets());
    const s = store.read();
    expect(s.accounts).toEqual([]);
    expect(store.health()).toEqual({ corrupt: true });
    // Original moved away to a timestamped backup holding the evidence.
    expect(existsSync(stateJson)).toBe(false);
    const backups = readdirSync(dir).filter((f) => f.startsWith("state.json.corrupt-"));
    expect(backups.length).toBe(1);
    expect(readFileSync(join(dir, backups[0]!), "utf8")).toBe(garbage);
  });

  test("a later mutation writes fresh state without touching the quarantined evidence", () => {
    const { dir, stateJson } = freshStateDir();
    writeFileSync(stateJson, "{corrupt");
    const paths = resolvePaths(dir);
    const store = createStateStore(paths, memSecrets());
    store.read(); // triggers quarantine
    store.mutate((s) => {
      s.settings.port = 9999;
    });
    const backups = readdirSync(dir).filter((f) => f.startsWith("state.json.corrupt-"));
    expect(backups.length).toBe(1);
    expect(readFileSync(join(dir, backups[0]!), "utf8")).toBe("{corrupt");
    const fresh = JSON.parse(readFileSync(stateJson, "utf8")) as { settings: { port: number } };
    expect(fresh.settings.port).toBe(9999);
    expect(store.health()).toEqual({ corrupt: false });
  });

  test("valid state never quarantines", () => {
    const { dir, stateJson } = freshStateDir();
    const paths = resolvePaths(dir);
    const store = createStateStore(paths, memSecrets());
    store.mutate((s) => {
      s.settings.port = 8787;
    });
    store.read();
    expect(readdirSync(dir).filter((f) => f.includes(".corrupt-"))).toEqual([]);
    expect(existsSync(stateJson)).toBe(true);
  });
});
