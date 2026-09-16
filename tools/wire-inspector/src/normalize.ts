/**
 * WI01 header normalization + canonical JSON helpers.
 * Preserve original casing when available; diff on case-insensitive form.
 */
import { createHash } from "node:crypto";

export interface NormalizedHeaders {
  /** lower-name -> value (last wins) */
  lower: Record<string, string>;
  /** lower-name -> first-seen original casing */
  originalCase: Record<string, string>;
}

export function normalizeHeadersFromRecord(rec: Record<string, string>): NormalizedHeaders {
  const lower: Record<string, string> = {};
  const originalCase: Record<string, string> = {};
  for (const [k, v] of Object.entries(rec)) {
    const lk = k.toLowerCase();
    if (!(lk in originalCase)) originalCase[lk] = k;
    lower[lk] = v;
  }
  return { lower, originalCase };
}

export function normalizeHeadersFromHeaders(h: Headers): NormalizedHeaders {
  const rec: Record<string, string> = {};
  h.forEach((v, k) => { rec[k] = v; });
  return normalizeHeadersFromRecord(rec);
}

/** Canonical JSON: sorted keys, compact. Ignores key order/whitespace. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (typeof v === "object" && v !== null) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = sortKeys((v as Record<string, unknown>)[k]);
    }
    return out;
  }
  return v;
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Flatten JSON to dotted paths: "messages[0].content", "model", ... */
export function flattenPaths(value: unknown, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  walk(value, prefix, out);
  return out;
}

function walk(v: unknown, path: string, out: Map<string, string>): void {
  if (Array.isArray(v)) {
    if (v.length === 0 && path) { out.set(path, "[]"); return; }
    v.forEach((item, i) => walk(item, path + "[" + i + "]", out));
    return;
  }
  if (typeof v === "object" && v !== null) {
    const keys = Object.keys(v as Record<string, unknown>);
    if (keys.length === 0 && path) { out.set(path, "{}"); return; }
    for (const k of keys) {
      const child = path ? path + "." + k : k;
      walk((v as Record<string, unknown>)[k], child, out);
    }
    return;
  }
  out.set(path, JSON.stringify(v));
}
