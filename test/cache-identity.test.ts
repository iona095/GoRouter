/**
 * CURRENT-010 — cache identity keys (mtime + size + ino).
 *
 * Honest claim chain (see prompt2 verification):
 * (1) Every product write path is an atomic rename (state.write via
 * atomicWriteJson, storeRegistry, secret put via atomicWriteBytes,
 * approval store) — a rename mints a new file identity (ino). The
 * assumption-pinning tests below fail loudly if any writer ever goes
 * in-place, which is the change that would silently void the ino key.
 * (2) The cache comparator includes ino, so any product write busts the
 * cache even at equal size and equal mtime tick.
 * (3) Coherence tests prove write-then-read through the real product path.
 *
 * What is NOT claimed: on NTFS, exact sub-100ns mtime equality cannot be
 * forced from user space (verified: utimesSync second-float round-trips to
 * ~80ns off), so no filesystem test can exhibit the old key's false-hit —
 * which itself bounds the original defect's practical reach on this
 * platform. The residual (hostile in-place same-size rewrite + exact mtime
 * forgery, bypassing all product APIs) is out of contract: a content digest
 * would require re-reading the file on every check, defeating the cache's
 * purpose (per-request state reads; ~350ms DPAPI decrypt avoidance).
 */
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, renameSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePaths, ensureStateDirs } from "../src/paths.ts";
import { createStateStore } from "../src/state.ts";
import { lockPathFor, withFileLock } from "../src/lock.ts";
import { peekRegistry, storeRegistry, emptyRegistryFile, registryPathFor } from "../src/models/registry.ts";
import { createSecretStore, newRef } from "../src/secret-store.ts";
import { memSecrets } from "./harness.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    for (let i = 0; i < 10; i++) {
      try { rmSync(d, { recursive: true, force: true }); break; }
      catch { if (i < 9) Bun.sleepSync(100); }
    }
  }
});

/** Pad JSON with trailing whitespace so two payloads share a byte size. */
function sameSize(a: string, size: number): string {
  if (a.length > size) throw new Error("payload exceeds target size");
  return a + " ".repeat(size - a.length);
}

describe("CURRENT-010 cache identity", () => {
  test("state: product writes mint new file identity; reads stay coherent", () => {
    const dir = mkdtempSync(join(tmpdir(), "gorouter-cacheid-"));
    dirs.push(dir);
    const paths = resolvePaths(dir);
    ensureStateDirs(paths);
    const store = createStateStore(paths, memSecrets());
    // W0: establish the lineage before raw writes (unestablished husks fail closed).
    withFileLock(lockPathFor(paths.state), 10_000, () => store.ensureV2());
    store.mutate((s) => { s.settings.upstreamGo = "http://127.0.0.1:1111/a"; });
    const ino1 = statSync(paths.stateJson).ino;
    expect(store.read().settings.upstreamGo).toBe("http://127.0.0.1:1111/a");
    // Assumption pin (1): the atomic-rename writer must mint new identity.
    store.mutate((s) => { s.settings.upstreamGo = "http://127.0.0.1:2222/b"; });
    const ino2 = statSync(paths.stateJson).ino;
    expect(ino2).not.toBe(ino1);
    // Coherence (3): the write is visible through the cache.
    expect(store.read().settings.upstreamGo).toBe("http://127.0.0.1:2222/b");
  });

  test("registry: product writes mint new file identity; peek stays coherent", () => {
    const dir = mkdtempSync(join(tmpdir(), "gorouter-cacheid-"));
    dirs.push(dir);
    const paths = resolvePaths(dir);
    ensureStateDirs(paths);
    const p = registryPathFor(paths);
    storeRegistry(paths, { ...emptyRegistryFile(), go: null, zen: null });
    const ino1 = statSync(p).ino;
    expect(peekRegistry(paths).file).not.toBeNull();
    // Assumption pin (1).
    storeRegistry(paths, { ...emptyRegistryFile("2001-01-01T00:00:00.000Z"), go: null, zen: null });
    expect(statSync(p).ino).not.toBe(ino1);
    // Coherence (3).
    expect(peekRegistry(paths).file?.updatedAtUtc).toBe("2001-01-01T00:00:00.000Z");
  });

  test("secrets: product writes mint new file identity; get stays coherent", () => {
    const dir = mkdtempSync(join(tmpdir(), "gorouter-cacheid-"));
    dirs.push(dir);
    const secretsDir = join(dir, "secrets");
    const store = createSecretStore(secretsDir);
    const ref = newRef();
    store.put(ref, "value-number-one");
    expect(store.get(ref)).toBe("value-number-one");
    const blobPath = join(secretsDir, `${ref}.bin`);
    const ino1 = statSync(blobPath).ino;
    const size1 = readFileSync(blobPath, "utf8").length;
    // Assumption pin (1); same-length plaintexts keep blob size stable so
    // the equal-size arm of the comparator is genuinely exercised.
    store.put(ref, "value-number-two");
    expect(readFileSync(blobPath, "utf8").length).toBe(size1);
    expect(statSync(blobPath).ino).not.toBe(ino1);
    // Coherence (3).
    expect(store.get(ref)).toBe("value-number-two");
  });

  test("state: external atomic rename replacement (same size) is re-read", () => {
    const dir = mkdtempSync(join(tmpdir(), "gorouter-cacheid-"));
    dirs.push(dir);
    const paths = resolvePaths(dir);
    ensureStateDirs(paths);
    const store = createStateStore(paths, memSecrets());
    // W0: establish the lineage before raw writes (unestablished husks fail closed).
    withFileLock(lockPathFor(paths.state), 10_000, () => store.ensureV2());
    store.mutate((s) => { s.settings.upstreamGo = "http://127.0.0.1:1111/a"; });
    expect(store.read().settings.upstreamGo).toBe("http://127.0.0.1:1111/a");
    // External actor using the same mechanism product writes use (atomic
    // rename) with equal byte size: the new identity must bust the cache.
    const size = readFileSync(paths.stateJson, "utf8").length;
    const raw = JSON.parse(readFileSync(paths.stateJson, "utf8")) as Record<string, unknown>;
    (raw.settings as Record<string, unknown>).upstreamGo = "http://127.0.0.1:2222/b";
    const tmp = join(dir, "state.replace");
    writeFileSync(tmp, sameSize(JSON.stringify(raw), size), "utf8");
    renameSync(tmp, paths.stateJson);
    expect(store.read().settings.upstreamGo).toBe("http://127.0.0.1:2222/b");
  });
});
