/**
 * Frozen pre-W0 writer fixture (contract 6.3 / criteria 13-14/16-17).
 *
 * Replicates the EXACT old-source load/mutate/write envelope of state.ts at
 * Main HEAD d5d4d99 (STATE_SCHEMA_VERSION = 1 era):
 * - numeric schemaVersion !== 1: unsupported gate (defaults served, writes refused);
 * - missing/non-numeric schema: legacy tolerance (accountId-only routes);
 * - mutate() re-reads via mtime/size/ino cache check, THEN enforces the gate,
 *   so a process that cached v1 observes a migrated v2 file and refuses;
 * - clone-on-mutate before fn.
 * Deliberately omits (irrelevant to the old-writer proof): settings validation,
 * transient-read retry, R4-003 paths, quarantine-on-corrupt (proof files are
 * well-formed and quarantine is not under test here).
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import { atomicWriteJson } from '../src/util.ts';

export const OLD_SCHEMA_VERSION = 1;

export interface OldState {
  schemaVersion: number;
  accounts: { id: string; alias: string; secretRef: string; createdAtUtc: string; updatedAtUtc: string }[];
  routes: { go: { accountId: string | null }; zen: { accountId: string | null } };
}

function oldDefaults(): OldState {
  return { schemaVersion: 1, accounts: [], routes: { go: { accountId: null }, zen: { accountId: null } } };
}

export function createOldWriter(stateJson: string) {
  let cache: { mtimeMs: number; size: number; ino: number; state: OldState } | null = null;
  let unsupportedSchema: number | null = null;

  function load(): OldState {
    if (!existsSync(stateJson)) return oldDefaults();
    const st = statSync(stateJson);
    if (cache && cache.mtimeMs === st.mtimeMs && cache.size === st.size && cache.ino === st.ino) return cache.state;
    const parsed: unknown = JSON.parse(readFileSync(stateJson, 'utf8'));
    const v = (parsed as { schemaVersion?: unknown }).schemaVersion;
    if (typeof v === 'number' && v !== OLD_SCHEMA_VERSION) {
      unsupportedSchema = v;
      cache = null;
      return oldDefaults();
    }
    const raw = parsed as Record<string, unknown>;
    const out = oldDefaults();
    if (Array.isArray(raw.accounts)) {
      for (const e of raw.accounts) {
        const a = e as Record<string, unknown>;
        if (typeof a.id === 'string' && typeof a.alias === 'string' && typeof a.secretRef === 'string') {
          out.accounts.push({ id: a.id, alias: a.alias, secretRef: a.secretRef, createdAtUtc: String(a.createdAtUtc || ''), updatedAtUtc: String(a.updatedAtUtc || '') });
        }
      }
    }
    const r = raw.routes as Record<string, { accountId?: unknown }> | undefined;
    for (const lane of ['go', 'zen'] as const) {
      const id = r ? r[lane] : undefined;
      const aid = (id as { accountId?: unknown } | undefined)?.accountId;
      out.routes[lane] = { accountId: typeof aid === 'string' ? aid : null };
    }
    unsupportedSchema = null;
    cache = { mtimeMs: st.mtimeMs, size: st.size, ino: st.ino, state: out };
    return out;
  }

  return {
    read: load,
    mutate(fn: (s: OldState) => void): OldState {
      const current = load();
      if (unsupportedSchema !== null) {
        throw new Error('refusing to write: unsupported schema version ' + unsupportedSchema);
      }
      const candidate = structuredClone(current);
      fn(candidate);
      atomicWriteJson(stateJson, candidate as unknown as Record<string, unknown>);
      cache = null;
      return candidate;
    },
  };
}
