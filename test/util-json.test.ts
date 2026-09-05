/**
 * CURRENT-004 — bounded, cycle-safe serialization.
 *
 * safeJsonStringify never throws on cyclic/deep inputs (emits bounded
 * markers instead), never mutates its input, and serializes acyclic values
 * byte-identically to JSON.stringify (normal paths preserve object identity
 * — no behavior change where it is adopted).
 */
import { describe, test, expect } from "bun:test";
import { safeJsonStringify } from "../src/util.ts";

describe("CURRENT-004 safeJsonStringify", () => {
  test("cyclic objects serialize with a bounded marker instead of throwing", () => {
    const a: Record<string, unknown> = { id: "a" };
    a.self = a;
    const b: Record<string, unknown> = { id: "b", child: a };
    a.peer = b; // indirect cycle a -> b -> a
    let out = "";
    expect(() => { out = safeJsonStringify(a); }).not.toThrow();
    expect(out).toContain("[Circular]");
    expect(out).toContain('"id":"a"');
    expect(out.length).toBeLessThan(1000);
    // input untouched: identity and shape preserved
    expect(a.self).toBe(a);
    expect((a.peer as Record<string, unknown>).id).toBe("b");
  });

  test("cyclic arrays do not throw or recurse forever", () => {
    const arr: unknown[] = ["x"];
    arr.push(arr);
    let out = "";
    expect(() => { out = safeJsonStringify(arr); }).not.toThrow();
    expect(out).toContain("[Circular]");
    expect(arr.length).toBe(2);
  });

  test("pathological depth is bounded", () => {
    let deep: Record<string, unknown> = {};
    let cur = deep;
    for (let i = 0; i < 500; i++) { const n: Record<string, unknown> = {}; cur.next = n; cur = n; }
    let out = "";
    expect(() => { out = safeJsonStringify(deep); }).not.toThrow();
    expect(out.length).toBeLessThan(20000);
  });

  test("toJSON carriers (Date and kin) match JSON.stringify", () => {
    const v = { at: new Date("2026-01-02T03:04:05.006Z"), n: 1 };
    expect(safeJsonStringify(v)).toBe(JSON.stringify(v));
    const custom = { toJSON: () => ({投影: 1}) };
    expect(safeJsonStringify(custom)).toBe(JSON.stringify(custom));
  });

  test("acyclic values are byte-identical to JSON.stringify", () => {
    const shared = { id: "s" };
    const v = { object: "list", data: [shared, shared, { n: 1, b: true, z: null }], s: "text ✓" };
    expect(safeJsonStringify(v)).toBe(JSON.stringify(v));
    expect(safeJsonStringify([1, "a", null])).toBe('[1,"a",null]');
    expect(safeJsonStringify("plain")).toBe('"plain"');
  });
});
