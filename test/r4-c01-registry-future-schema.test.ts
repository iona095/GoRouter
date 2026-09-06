/** R4-C01 validation: future-version registry must not be overwritten by refresh. */
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePaths, ensureStateDirs } from "../src/paths.ts";
import { registryPathFor, loadRegistry, peekRegistry } from "../src/models/registry.ts";
import { refreshRegistry, clearRefreshSingleFlightForTests, maybeRefreshOnStartup } from "../src/models/refresh.ts";
import type { FetchFn } from "../src/models/fetcher.ts";

const dirs: string[] = [];
afterEach(() => { clearRefreshSingleFlightForTests(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function listData(ids: string[]) { return { object: "list", data: ids.map((id) => ({ id, object: "model" })) }; }
function goodFetch(): FetchFn {
  return (async (url: string) => {
    if (url.includes("upstream.go")) return Response.json(listData(["m-go"]));
    return Response.json(listData(["m-zen"]));
  }) as FetchFn;
}
function badFetch(): FetchFn {
  return (async () => new Response("upstream down", { status: 502 })) as FetchFn;
}

describe("R4-C01 future registry overwrite", () => {
  test("forced refresh preserves future-schema file byte-identical (success path)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gorouter-c01-")); dirs.push(dir);
    const paths = resolvePaths(dir); ensureStateDirs(paths);
    const p = registryPathFor(paths);
    const future = { schemaVersion: 99, futureSentinel: "must-survive", updatedAtUtc: "2026-01-01T00:00:00.000Z", go: null, zen: null, lastAttempt: { go: null, zen: null, combinedAtUtc: null }, lastDiff: [] };
    writeFileSync(p, JSON.stringify(future, null, 2) + "\n");
    const before = readFileSync(p, "utf8");
    const r = await refreshRegistry(paths, { upstreamGo: "https://upstream.go", upstreamZen: "https://upstream.zen", fetchFn: goodFetch(), forced: true });
    expect(readFileSync(p, "utf8")).toBe(before);
    expect(r.success).toBe(false);
  });

  test("failed refresh preserves future-schema file byte-identical", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gorouter-c01-")); dirs.push(dir);
    const paths = resolvePaths(dir); ensureStateDirs(paths);
    const p = registryPathFor(paths);
    const future = { schemaVersion: 99, futureSentinel: "must-survive", updatedAtUtc: "2026-01-01T00:00:00.000Z", go: null, zen: null, lastAttempt: { go: null, zen: null, combinedAtUtc: null }, lastDiff: [] };
    writeFileSync(p, JSON.stringify(future, null, 2) + "\n");
    const before = readFileSync(p, "utf8");
    const r = await refreshRegistry(paths, { upstreamGo: "https://upstream.go", upstreamZen: "https://upstream.zen", fetchFn: badFetch(), forced: true });
    expect(readFileSync(p, "utf8")).toBe(before);
    expect(r.success).toBe(false);
  });

  test("startup refresh does not overwrite future-schema file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gorouter-c01-")); dirs.push(dir);
    const paths = resolvePaths(dir); ensureStateDirs(paths);
    const p = registryPathFor(paths);
    const future = { schemaVersion: 99, futureSentinel: "must-survive", updatedAtUtc: "2026-01-01T00:00:00.000Z", go: null, zen: null, lastAttempt: { go: null, zen: null, combinedAtUtc: null }, lastDiff: [] };
    writeFileSync(p, JSON.stringify(future, null, 2) + "\n");
    const before = readFileSync(p, "utf8");
    const peek = peekRegistry(paths);
    expect(peek.file).toBeNull();
    const pending = maybeRefreshOnStartup(paths, "https://upstream.go", "https://upstream.zen", { fetchFn: goodFetch() });
    if (pending) await pending;
    expect(readFileSync(p, "utf8")).toBe(before);
  });
});
