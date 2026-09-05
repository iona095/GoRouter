/**
 * GR-006 regression: a cached /models response journals the ONE route
 * snapshot it was admitted under. A route change between a validity check
 * and a second lookup must not rewrite the journal row.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../src/server.ts";
import { createStateStore, makeAccount, type StateStore } from "../src/state.ts";
import { createJournal } from "../src/journal.ts";
import { resolvePaths, ensureStateDirs } from "../src/paths.ts";
import { newRef } from "../src/secret-store.ts";
import { storeRegistry } from "../src/models/registry.ts";
import { MODELS_SCHEMA_VERSION } from "../src/models/types.ts";
import type { RegistryFile } from "../src/models/types.ts";
import { memSecrets, authHeaders, readJournalRows, LOCAL_KEY } from "./harness.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    for (let i = 0; i < 5; i++) {
      try { rmSync(d, { recursive: true, force: true }); break; } catch { Bun.sleepSync(50 * (i + 1)); }
    }
  }
});

function freshRegistry(): RegistryFile {
  const now = new Date().toISOString();
  const lane = (ids: string[]) => ({ fetchedAtUtc: now, models: ids.map((id) => ({ id, object: "model" as const })) });
  return {
    schemaVersion: MODELS_SCHEMA_VERSION,
    updatedAtUtc: now,
    go: lane(["cached-go-1"]),
    zen: lane(["cached-zen-1"]),
    lastAttempt: { go: null, zen: null, combinedAtUtc: null },
    lastDiff: [],
  };
}

describe("GR-006 one immutable cached-model snapshot", () => {
  test("a route change mid-request cannot rewrite the journal row", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "gorouter-gr006-"));
    dirs.push(stateDir);
    const paths = resolvePaths(stateDir);
    ensureStateDirs(paths);
    const secrets = memSecrets();
    const localRef = newRef();
    secrets.put(localRef, LOCAL_KEY);
    const real = createStateStore(paths, secrets);
    real.mutate((s) => {
      s.localCredentialRef = localRef;
      s.settings.port = 0;
      s.settings.upstreamGo = "http://127.0.0.1:1";
      s.settings.upstreamZen = "http://127.0.0.1:1";
    });
    real.mutate((s) => {
      const ref = newRef();
      secrets.put(ref, "sk-first");
      s.accounts.push(makeAccount("first", ref));
    });
    const first = real.read().accounts.find((a) => a.alias === "first")!;
    real.mutate((s) => { s.routes.go.accountId = first.id; });
    storeRegistry(paths, freshRegistry());
    // Seam: the second lookup in one request sees a different world.
    let calls = 0;
    const state: StateStore = {
      ...real,
      resolveSnapshot: (lane) => {
        calls++;
        const snap = real.resolveSnapshot(lane);
        if (calls === 1) return snap;
        return { ...snap, accountId: "acct_second", alias: "second" };
      },
    };
    const journal = createJournal(paths.journalDb, 30, 100000);
    const server = createServer({ state, journal, paths, startupRefresh: false });
    await server.serve();
    try {
      const res = await fetch("http://127.0.0.1:" + server.port() + "/go/v1/models", { headers: authHeaders() });
      expect(res.status).toBe(200);
      expect(res.headers.get("x-gorouter-models-cache")).toBe("hit");
      expect(calls).toBe(1);
      const rows = readJournalRows(paths.journalDb);
      expect(rows.length).toBe(1);
      expect(rows[0]!.selected_account_id).toBe(first.id);
      expect(rows[0]!.selected_account_alias_snapshot).toBe("first");
    } finally {
      server.stop();
      journal.close();
    }
  }, 30000);
});
