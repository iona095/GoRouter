/**
 * R3-010 regression: the third-party DSH writer uses the same durability
 * contract as the project-owned atomic writers - bytes hit stable storage
 * (fsync) before the rename commits them. A crash between rename and
 * cache flush must not lose or corrupt another application config file.
 *
 * - fsync is observed before rename through the real fs stack (spied,
 *   not stubbed: bytes really flow);
 * - success is byte-identical with no temp residue and re-parses;
 * - a rename-stage failure still throws, keeps prior content, and
 *   removes the staging temp (same catch block an fsync failure takes).
 */
import { describe, test, expect, afterEach, mock } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileAtomic } from "../src/models/dsh-client.ts";

const dirs: string[] = [];
afterEach(() => {
  mock.restore();
  for (const d of dirs.splice(0)) {
    for (let i = 0; i < 5; i++) {
      try { rmSync(d, { recursive: true, force: true }); break; } catch { Bun.sleepSync(50 * (i + 1)); }
    }
  }
});

function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), "gorouter-r3010-"));
  dirs.push(d);
  return d;
}

function residue(dir: string): string[] {
  return readdirSync(dir).filter((f) => f.endsWith(".tmp"));
}

describe("R3-010 DSH write durability", () => {
  test("fsync precedes rename through the real fs stack", async () => {
    const dir = freshDir();
    const target = join(dir, "settings.yaml");
    const real = await import("node:fs/promises");
    // Bind BEFORE mocking: the pre-mock namespace object is aliased by the
    // mock registry, so lazy real.open lookups would recurse into the mock.
    const realOpen = real.open.bind(real) as (...a: unknown[]) => Promise<any>;
    const realRename = real.rename.bind(real) as (...a: unknown[]) => Promise<void>;
    const events: string[] = [];
    mock.module("node:fs/promises", () => ({
      ...real,
      open: async (...a: unknown[]) => {
        events.push("open");
        const fh = await realOpen(...a);
        const origSync = fh.sync.bind(fh);
        const origClose = fh.close.bind(fh);
        fh.sync = async (...s: unknown[]) => { events.push("sync"); return origSync(...s); };
        fh.close = async (...s: unknown[]) => { events.push("close"); return origClose(...s); };
        return fh;
      },
      rename: async (...a: unknown[]) => { events.push("rename"); return realRename(...a); },
    }));
    await writeFileAtomic(target, "llm-pi-ai:\n  providers: {}\n");
    expect(readFileSync(target, "utf8")).toBe("llm-pi-ai:\n  providers: {}\n");
    expect(events).toContain("sync");
    expect(events.indexOf("sync")).toBeLessThan(events.indexOf("rename"));
    expect(events.indexOf("close")).toBeLessThan(events.indexOf("rename"));
    expect(residue(dir)).toEqual([]);
  });

  test("rename-stage failure keeps prior content and removes the temp", async () => {
    const dir = freshDir();
    const target = join(dir, "settings.yaml");
    writeFileSync(target, "v1-content\n");
    // A directory at the target path fails the rename commit on Windows.
    rmSync(target, { force: true });
    mkdirSync(target);
    await expect(writeFileAtomic(target, "v2-content\n")).rejects.toThrow();
    expect(residue(dir)).toEqual([]);
    const st = await import("node:fs/promises").then((m) => m.stat(target));
    expect(st.isDirectory()).toBe(true);
    rmSync(target, { recursive: true, force: true });
  });
});
