/**
 * W0 proving: schema / migration (criteria 1-23). Synthetic state dirs +
 * in-memory secrets only. No provider traffic, no DPAPI, no production paths.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePaths, ensureStateDirs, type Paths } from "../src/paths.ts";
import {
  createStateStore,
  classifyRawState,
  isVersionNumber,
  isStateGeneration,
  STATE_SCHEMA_VERSION,
  type StateFile,
} from "../src/state.ts";
import { createDomain, isDomainConflict } from "../src/domain.ts";
import { lockPathFor, withFileLock } from "../src/lock.ts";
import { newRef, type SecretStore } from "../src/secret-store.ts";
import { memSecrets } from "./harness.ts";
import { createOldWriter } from "./w0-old-writer-fixture.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function freshPaths(): Paths {
  const dir = mkdtempSync(join(tmpdir(), "gorouter-w0-schema-"));
  dirs.push(dir);
  const paths = resolvePaths(dir);
  ensureStateDirs(paths);
  return paths;
}

const T0 = "2026-01-01T00:00:00.000Z";

/** Raw v1-shaped account (no versions), as a pre-W0 binary persisted it. */
function v1Account(alias: string, secretRef: string, id = "acct-" + alias) {
  return { id, alias, secretRef, createdAtUtc: T0, updatedAtUtc: T0 };
}

function writeV1(paths: Paths, opts: {
  accounts?: ReturnType<typeof v1Account>[];
  go?: string | null;
  zen?: string | null;
  schemaVersion?: unknown;
  settings?: Record<string, unknown>;
  localCredentialRef?: string | null;
} = {}) {
  const doc: Record<string, unknown> = {
    schemaVersion: opts.schemaVersion ?? 1,
    accounts: opts.accounts ?? [],
    routes: { go: { accountId: opts.go ?? null }, zen: { accountId: opts.zen ?? null } },
    settings: {
      port: 8787, host: "127.0.0.1",
      upstreamGo: "https://opencode.ai/zen/go/v1", upstreamZen: "https://opencode.ai/zen/v1",
      journalRetentionDays: 30, journalMaxRecords: 100000,
      ...(opts.settings ?? {}),
    },
    localCredentialRef: opts.localCredentialRef ?? null,
  };
  writeFileSync(paths.stateJson, JSON.stringify(doc), "utf8");
}

function secretsWith(secrets: SecretStore, refs: string[]) {
  for (const r of refs) secrets.put(r, "synthetic-secret-for-" + r);
  return secrets;
}

function established(paths: Paths, secrets: SecretStore) {
  return withFileLock(lockPathFor(paths.state), 10_000, () => createStateStore(paths, secrets).ensureV2());
}

describe("loader classification (contract 6.1)", () => {
  test("1: pristine numeric-v1 is migratable (not unsupported)", () => {
    const paths = freshPaths();
    const ref = newRef();
    writeV1(paths, { accounts: [v1Account("a", ref)] });
    expect(classifyRawState(JSON.parse(readFileSync(paths.stateJson, "utf8")))).toBe("v1");
    const secrets = secretsWith(memSecrets(), [ref]);
    const st = established(paths, secrets);
    expect(st.schemaVersion).toBe(2);
    expect(isStateGeneration(st.stateGeneration)).toBe(true);
  });

  test("2: missing/non-numeric schema with valid v1 structure is legacy-v1", () => {
    for (const doc of [
      { accounts: [], routes: {}, settings: {} },
      { schemaVersion: "one", accounts: [], routes: {} },
      { schemaVersion: null, accounts: [], routes: {} },
    ]) {
      const paths = freshPaths();
      writeFileSync(paths.stateJson, JSON.stringify(doc), "utf8");
      expect(classifyRawState(JSON.parse(readFileSync(paths.stateJson, "utf8")))).toBe("legacy-v1");
      const st = established(paths, memSecrets());
      expect(st.schemaVersion).toBe(2);
      expect(isStateGeneration(st.stateGeneration)).toBe(true);
    }
  });

  test("3/11: malformed legacy that fails v1 invariants refuses (legacy-invalid)", () => {
    const paths = freshPaths();
    // duplicate aliases: migration would have to guess
    writeFileSync(paths.stateJson, JSON.stringify({
      accounts: [v1Account("dup", newRef()), v1Account("DUP", newRef())], routes: {},
    }), "utf8");
    expect(classifyRawState(JSON.parse(readFileSync(paths.stateJson, "utf8")))).toBe("legacy-invalid");
    const store = createStateStore(paths, memSecrets());
    expect(() => withFileLock(lockPathFor(paths.state), 10_000, () => store.ensureV2())).toThrow();
    // original bytes preserved (quarantined, never normalized as v2)
    expect(store.health().corrupt).toBe(true);
  });

  test("12: other numeric schemas stay write-blocked", () => {
    const paths = freshPaths();
    writeV1(paths, { schemaVersion: 3 });
    const domain = createDomain(paths, memSecrets());
    expect(() => domain.ensureState()).toThrow(/unsupported schema version 3/);
    expect(() => domain.accountAdd("x", "sk-x")).toThrow(/unsupported schema version 3/);
    expect(JSON.parse(readFileSync(paths.stateJson, "utf8")).schemaVersion).toBe(3);
  });
});
describe('migration preservation (contract 6.1)', () => {
  test('4/5: migrated accounts keep stable IDs at version 1; lanes keep selections at version 1', () => {
    const paths = freshPaths();
    const r1 = newRef();
    const r2 = newRef();
    writeV1(paths, { accounts: [v1Account('alpha', r1, 'acct-keep-1'), v1Account('beta', r2, 'acct-keep-2')], go: 'acct-keep-1', zen: null });
    const secrets = secretsWith(memSecrets(), [r1, r2]);
    const st = established(paths, secrets);
    expect(st.accounts.map((a) => [a.id, a.alias, a.version])).toEqual([
      ['acct-keep-1', 'alpha', 1],
      ['acct-keep-2', 'beta', 1],
    ]);
    expect(st.routes.go).toEqual({ accountId: 'acct-keep-1', version: 1 });
    expect(st.routes.zen).toEqual({ accountId: null, version: 1 });
  });

  test('6: settings + local credential ref preserved without decrypting', () => {
    const paths = freshPaths();
    const lc = newRef();
    writeV1(paths, { settings: { port: 9999 }, localCredentialRef: lc });
    const secrets = memSecrets();
    const st = established(paths, secrets);
    expect(st.settings.port).toBe(9999);
    expect(st.localCredentialRef).toBe(lc);
    expect(secrets.exists(lc)).toBe(false);
  });

  test('7: ordinary restart preserves generation and versions', () => {
    const paths = freshPaths();
    const ref = newRef();
    writeV1(paths, { accounts: [v1Account('a', ref)], go: 'acct-a' });
    const secrets = secretsWith(memSecrets(), [ref]);
    const first = established(paths, secrets);
    const second = createStateStore(paths, secrets).read();
    expect(second.stateGeneration).toBe(first.stateGeneration);
    expect(second.accounts[0]!.version).toBe(1);
    expect(second.routes.go.version).toBe(1);
    const third = established(paths, secrets);
    expect(third.stateGeneration).toBe(first.stateGeneration);
  });

  test('8/9/10: malformed v2 generation/versions/duplicate identities fail closed', () => {
    const bad: Record<string, unknown>[] = [
      { schemaVersion: 2, accounts: [], routes: { go: { accountId: null, version: 1 }, zen: { accountId: null, version: 1 } } },
      { schemaVersion: 2, stateGeneration: 'not-a-uuid', accounts: [], routes: { go: { accountId: null, version: 1 }, zen: { accountId: null, version: 1 } } },
      { schemaVersion: 2, stateGeneration: '123e4567-e89b-12d3-a456-426614174000', accounts: [{ id: 'x', alias: 'x', secretRef: newRef(), createdAtUtc: 't', updatedAtUtc: 't', version: 0 }], routes: { go: { accountId: null, version: 1 }, zen: { accountId: null, version: 1 } } },
      { schemaVersion: 2, stateGeneration: '123e4567-e89b-12d3-a456-426614174000', accounts: [{ id: 'dup', alias: 'a', secretRef: newRef(), createdAtUtc: 't', updatedAtUtc: 't', version: 1 }, { id: 'dup', alias: 'b', secretRef: newRef(), createdAtUtc: 't', updatedAtUtc: 't', version: 1 }], routes: { go: { accountId: null, version: 1 }, zen: { accountId: null, version: 1 } } },
      { schemaVersion: 2, stateGeneration: '123e4567-e89b-12d3-a456-426614174000', accounts: [{ id: 'a', alias: 'Same', secretRef: newRef(), createdAtUtc: 't', updatedAtUtc: 't', version: 1 }, { id: 'b', alias: 'same', secretRef: newRef(), createdAtUtc: 't', updatedAtUtc: 't', version: 1 }], routes: { go: { accountId: null, version: 1 }, zen: { accountId: null, version: 1 } } },
    ];
    for (const doc of bad) {
      const paths = freshPaths();
      writeFileSync(paths.stateJson, JSON.stringify(doc), 'utf8');
      const store = createStateStore(paths, memSecrets());
      const s = store.read();
      expect(s.accounts).toEqual([]);
      expect(store.health().corrupt).toBe(true);
      expect(existsSync(paths.stateJson)).toBe(false);
    }
  });

  test('13: frozen pre-W0 writer starting after migration refuses v2', () => {
    const paths = freshPaths();
    const ref = newRef();
    writeV1(paths, { accounts: [v1Account('a', ref)] });
    established(paths, secretsWith(memSecrets(), [ref]));
    const old = createOldWriter(paths.stateJson);
    expect(() => old.mutate((s) => { s.routes.go.accountId = null; })).toThrow(/unsupported schema version 2/);
    const raw = JSON.parse(readFileSync(paths.stateJson, 'utf8')) as StateFile;
    expect(raw.schemaVersion).toBe(2);
    expect(raw.accounts.length).toBe(1);
  });

  test('14: pre-W0 writer that cached v1 refuses after another writer migrates', () => {
    const paths = freshPaths();
    const ref = newRef();
    writeV1(paths, { accounts: [v1Account('a', ref)] });
    const old = createOldWriter(paths.stateJson);
    expect(old.read().accounts.length).toBe(1);
    established(paths, secretsWith(memSecrets(), [ref]));
    expect(() => old.mutate((s) => { s.routes.go.accountId = null; })).toThrow(/unsupported schema version 2/);
    const raw = JSON.parse(readFileSync(paths.stateJson, 'utf8')) as StateFile;
    expect(raw.schemaVersion).toBe(2);
  });

  test('15: two racing migrators converge on one generation', () => {
    const paths = freshPaths();
    const ref = newRef();
    writeV1(paths, { accounts: [v1Account('a', ref)] });
    const s1 = memSecrets();
    const s2 = memSecrets();
    const r1 = withFileLock(lockPathFor(paths.state), 10_000, () => createStateStore(paths, s1).ensureV2());
    const r2 = withFileLock(lockPathFor(paths.state), 10_000, () => createStateStore(paths, s2).ensureV2());
    expect(r2.stateGeneration).toBe(r1.stateGeneration);
    expect(r2.accounts.length).toBe(1);
  });

  test('16: old v1 writer committing before the migrator locks migrates latest state', () => {
    const paths = freshPaths();
    const ref = newRef();
    writeV1(paths, { accounts: [v1Account('a', ref)] });
    const old = createOldWriter(paths.stateJson);
    old.mutate((s) => { s.accounts.push({ id: 'acct-late', alias: 'late', secretRef: ref, createdAtUtc: T0, updatedAtUtc: T0 }); });
    const st = established(paths, secretsWith(memSecrets(), [ref]));
    expect(st.accounts.map((a) => a.alias).sort()).toEqual(['a', 'late']);
    expect(st.accounts.every((a) => a.version === 1)).toBe(true);
  });

  test('17: migration first causes the later old-v1 writer to refuse', () => {
    const paths = freshPaths();
    writeV1(paths, {});
    const old = createOldWriter(paths.stateJson);
    old.read();
    established(paths, memSecrets());
    expect(() => old.mutate((s) => { s.routes.zen.accountId = 'acct-x'; })).toThrow(/unsupported schema version 2/);
  });
});
describe('establishment, reset, failure integrity, exhaustion (contract 5.6/5.7/6.2/6.5)', () => {
  test('18: absent state establishes one persisted generation before W0 metadata use', () => {
    const paths = freshPaths();
    const secrets = memSecrets();
    const first = established(paths, secrets);
    expect(isStateGeneration(first.stateGeneration)).toBe(true);
    const onDisk = JSON.parse(readFileSync(paths.stateJson, 'utf8')) as StateFile;
    expect(onDisk.stateGeneration).toBe(first.stateGeneration);
    expect(onDisk.schemaVersion).toBe(2);
    const second = established(paths, secrets);
    expect(second.stateGeneration).toBe(first.stateGeneration);
  });

  test('19: reset creates a new generation; pre-reset requests are rejected', () => {
    const paths = freshPaths();
    const secrets = memSecrets();
    const domain = createDomain(paths, secrets);
    domain.setup();
    const before = domain.status().stateGeneration;
    const frozenGen = before;
    domain.reset();
    const after = domain.status().stateGeneration;
    expect(after).not.toBe(before);
    expect(isStateGeneration(after)).toBe(true);
    try {
      domain.accountAddChecked('b', 'sk-b', { expectedStateGeneration: frozenGen });
      expect.unreachable('stale generation must reject');
    } catch (e) {
      expect(isDomainConflict(e) && e.reason).toBe('state_generation_mismatch');
    }
    expect(domain.status().accounts).toEqual([]);
  });

  test('20: injected migration write failure leaves v1 authoritative, no phantom generation', () => {
    const paths = freshPaths();
    const ref = newRef();
    writeV1(paths, { accounts: [v1Account('a', ref)] });
    const before = readFileSync(paths.stateJson, 'utf8');
    const failing = () => { throw new Error('injected migration write failure'); };
    const store = createStateStore(paths, memSecrets(), { writeJson: failing });
    expect(() => withFileLock(lockPathFor(paths.state), 10_000, () => store.ensureV2())).toThrow(/injected migration write failure/);
    expect(readFileSync(paths.stateJson, 'utf8')).toBe(before);
    const st = store.read();
    expect(st.schemaVersion).toBe(1);
    expect(st.stateGeneration).toBe('');
    const live = established(paths, secretsWith(memSecrets(), [ref]));
    expect(isStateGeneration(live.stateGeneration)).toBe(true);
    expect(live.accounts.length).toBe(1);
  });

  test('21: injected ordinary v2 write failure leaves pre-mutation state authoritative', () => {
    const paths = freshPaths();
    const secrets = memSecrets();
    const domain = createDomain(paths, secrets);
    domain.setup();
    const acc = domain.accountAdd('a', 'sk-a');
    const gen = domain.status().stateGeneration;
    const failingStore = createStateStore(paths, secrets, { writeJson: () => { throw new Error('injected ordinary write failure'); } });
    expect(() => failingStore.mutate((s) => { s.settings.port = 1111; })).toThrow(/injected ordinary write failure/);
    const reread = createStateStore(paths, secrets).read();
    expect(reread.settings.port).not.toBe(1111);
    expect(reread.stateGeneration).toBe(gen);
    expect(reread.accounts.find((a) => a.id === acc.id)!.version).toBe(1);
    const later = createStateStore(paths, secrets);
    later.mutate((s) => { s.settings.port = 2222; });
    expect(createStateStore(paths, secrets).read().settings.port).toBe(2222);
  });

  test('22: account version at safe-integer maximum refuses without wrap', () => {
    const paths = freshPaths();
    const secrets = memSecrets();
    const domain = createDomain(paths, secrets);
    domain.setup();
    const gen = domain.status().stateGeneration;
    const added = domain.accountAddChecked('maxed', 'sk-m', { expectedStateGeneration: gen });
    const raw = JSON.parse(readFileSync(paths.stateJson, 'utf8')) as StateFile;
    const rec = raw.accounts.find((a) => a.id === added.account.id)!;
    rec.version = Number.MAX_SAFE_INTEGER;
    writeFileSync(paths.stateJson, JSON.stringify(raw), 'utf8');
    const reread = domain.status();
    expect(reread.accounts.find((a) => a.id === added.account.id)!.version).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => domain.accountUpdateChecked(added.account.id, 'sk-m2', {
      expectedStateGeneration: gen, expectedAccountVersion: Number.MAX_SAFE_INTEGER,
    })).toThrow(/version exhausted/);
    expect(domain.status().accounts.find((a) => a.id === added.account.id)!.version).toBe(Number.MAX_SAFE_INTEGER);
  });

  test('23: route version at safe-integer maximum refuses without wrap', () => {
    const paths = freshPaths();
    const secrets = memSecrets();
    const domain = createDomain(paths, secrets);
    domain.setup();
    const gen = domain.status().stateGeneration;
    const added = domain.accountAddChecked('t', 'sk-t', { expectedStateGeneration: gen });
    const raw = JSON.parse(readFileSync(paths.stateJson, 'utf8')) as StateFile;
    raw.routes.go.version = Number.MAX_SAFE_INTEGER;
    writeFileSync(paths.stateJson, JSON.stringify(raw), 'utf8');
    expect(() => domain.routeSetChecked('go', added.account.id, {
      expectedStateGeneration: gen,
      expectedRouteVersion: Number.MAX_SAFE_INTEGER,
      expectedTargetAccountVersion: 1,
    })).toThrow(/version exhausted/);
    expect(domain.status().routes.find((r) => r.lane === 'go')!.version).toBe(Number.MAX_SAFE_INTEGER);
  });
});
