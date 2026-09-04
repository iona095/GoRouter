/**
 * Slice A — upstream model catalog fetcher.
 *
 * Direct fetch to upstream (bypasses GoRouter localhost entirely).
 * No local/account credential, no loopback, no auth leakage.
 */
import { log } from "../util.ts";
import type { Lane } from "../state.ts";
import { MODELS_FETCH_TIMEOUT_MS, type LaneSnapshot, type ModelEntry } from "./types.ts";

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Ingestion bounds (F-03/M3): a degraded or hostile pinned upstream must not
 * OOM the router or bloat the on-disk registry. Bodies are read through a
 * capped reader (declared Content-Length checked first), entry counts and id
 * lengths are capped during normalization. Anything past a cap rejects the
 * whole fetch so the previous good registry stays authoritative.
 */
export const MAX_CATALOG_BYTES = 5 * 1024 * 1024;
export const MAX_CATALOG_MODELS = 10_000;
export const MAX_MODEL_ID_LENGTH = 256;

async function readCappedBody(res: Response, cap: number, what: string): Promise<Uint8Array> {
  const declared = Number(res.headers.get("content-length") ?? NaN);
  if (Number.isFinite(declared) && declared > cap) {
    throw new Error(`${what}: body too large (declared ${declared} > ${cap} bytes)`);
  }
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.length;
      if (total > cap) {
        try { await reader.cancel(); } catch { /* best effort */ }
        throw new Error(`${what}: body too large (over ${cap} bytes)`);
      }
      chunks.push(value);
    }
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

/** Validate and normalize the upstream /models response. */
function normalizeModelsResponse(raw: unknown, lane: Lane): ModelEntry[] {
  if (typeof raw !== "object" || raw === null) throw new Error(`lane ${lane}: response is not an object`);
  const obj = raw as Record<string, unknown>;
  const data = obj.data;
  if (!Array.isArray(data)) throw new Error(`lane ${lane}: missing or non-array data`);
  if (data.length > MAX_CATALOG_MODELS) throw new Error(`lane ${lane}: too many models (${data.length} > ${MAX_CATALOG_MODELS})`);
  const seen = new Set<string>();
  const out: ModelEntry[] = [];
  for (let i = 0; i < data.length; i++) {
    const el = data[i];
    if (typeof el !== "object" || el === null) throw new Error(`lane ${lane}: data[${i}] is not an object`);
    const rec = el as Record<string, unknown>;
    const id = rec.id;
    if (typeof id !== "string" || id.trim().length === 0) throw new Error(`lane ${lane}: data[${i}] missing non-empty string id`);
    if (id.trim().length > MAX_MODEL_ID_LENGTH) throw new Error(`lane ${lane}: data[${i}] id too long (over ${MAX_MODEL_ID_LENGTH} chars)`);
    if (seen.has(id)) throw new Error(`lane ${lane}: duplicate model id '${id}'`);
    seen.add(id);
    // preserve verbatim but guarantee id is present
    out.push(el as ModelEntry);
  }
  // Deterministic order for storage/comparison
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}

export function upstreamModelsUrl(upstreamBase: string): string {
  // upstreamBase is like https://opencode.ai/zen/go/v1 or http://127.0.0.1:port
  // Join with /models without double slash issues
  const base = upstreamBase.replace(/\/+$/, "");
  return base + "/models";
}

/**
 * Fetch one lane's catalog directly from upstream.
 * Throws on non-200, malformed, duplicate ids, network, or timeout.
 */
export async function fetchLane(
  lane: Lane,
  upstreamBase: string,
  opts: { fetchFn?: FetchFn; signal?: AbortSignal } = {},
): Promise<LaneSnapshot> {
  const url = upstreamModelsUrl(upstreamBase);
  const fetchFn: FetchFn = opts.fetchFn ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("fetch timeout")), MODELS_FETCH_TIMEOUT_MS);
  // Merge external signal
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort(opts.signal.reason);
    else opts.signal.addEventListener("abort", () => controller.abort(opts.signal!.reason), { once: true });
  }
  let res: Response;
  try {
    res = await fetchFn(url, {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "manual",
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timeout);
    throw new Error(`lane ${lane}: fetch failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  clearTimeout(timeout);
  if (res.status !== 200) {
    // Capped read: the error body itself is untrusted and must not be buffered whole.
    const bodyBytes = await readCappedBody(res, MAX_CATALOG_BYTES, `lane ${lane} error`).catch(() => new Uint8Array(0));
    const bodySnippet = new TextDecoder().decode(bodyBytes.slice(0, 300));
    throw new Error(`lane ${lane}: upstream status ${res.status} ${bodySnippet}`);
  }
  let raw: unknown;
  try {
    const bodyBytes = await readCappedBody(res, MAX_CATALOG_BYTES, `lane ${lane}`);
    raw = JSON.parse(new TextDecoder().decode(bodyBytes));
  } catch (e) {
    if (e instanceof Error && /body too large/.test(e.message)) throw e;
    throw new Error(`lane ${lane}: invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  const models = normalizeModelsResponse(raw, lane);
  return { fetchedAtUtc: new Date().toISOString(), models };
}

export { normalizeModelsResponse };
