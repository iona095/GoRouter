/**
 * GR-011 regression: failed atomic writes must not leak temp files. Every
 * failure stage (write, fsync, rename) leaves the target intact and no
 * `.tmp` file behind.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWriteJson, atomicWriteBytes } from "../src/util.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    for (let i = 0; i < 5; i++) {
      try { rmSync(d, { recursive: true, force: true }); break; } catch { Bun.sleepSync(50 * (i + 1)); }
    }
  }
});

function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), "gorouter-gr011-"));
  dirs.push(d);
  return d;
}

function tmpFiles(dir: string): string[] {
  return readdirSync(dir).filter((f) => f.endsWith(".tmp"));
}

describe("GR-011 failed atomic writes leave no temp files", () => {
  test("unserializable value: target intact, no tmp (json write stage)", () => {
    const dir = freshDir();
    const target = join(dir, "state.json");
    writeFileSync(target, "{\"v\":1}");
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => atomicWriteJson(target, cyclic)).toThrow();
    expect(readFileSync(target, "utf8")).toBe("{\"v\":1}");
    expect(tmpFiles(dir)).toEqual([]);
  });

  test("rename failure (target is a directory): originals intact, no tmp", () => {
    const dir = freshDir();
    const target = join(dir, "victim");
    writeFileSync(target, "original");
    // Renaming a file onto a non-empty directory fails on Windows (EPERM).
    rmSync(target, { force: true });
    mkdirSync(target);
    writeFileSync(join(target, "child.txt"), "x");
    expect(() => atomicWriteBytes(target, Buffer.from("new-bytes"))).toThrow();
    expect(tmpFiles(dir)).toEqual([]);
  });

  test("success path still writes atomically", () => {
    const dir = freshDir();
    const target = join(dir, "state.json");
    atomicWriteJson(target, { v: 2 });
    expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({ v: 2 });
    expect(tmpFiles(dir)).toEqual([]);
    atomicWriteBytes(target, Buffer.from("raw"));
    expect(readFileSync(target, "utf8")).toBe("raw");
    expect(tmpFiles(dir)).toEqual([]);
  });
});
