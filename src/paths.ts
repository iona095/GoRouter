/**
 * GoRouter V1 — path resolution.
 *
 * Runtime state (accounts, route selections, journal, DPAPI secret blobs)
 * lives OUTSIDE the source repository by default: %LOCALAPPDATA%\GoRouter,
 * overridable with GOROUTER_STATE_DIR.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

export const STATE_DIR_ENV = "GOROUTER_STATE_DIR";

export function stateDir(): string {
  const override = process.env[STATE_DIR_ENV];
  if (override && override.trim().length > 0) return override.trim();
  const local = process.env.LOCALAPPDATA;
  if (local && local.trim().length > 0) return join(local.trim(), "GoRouter");
  return join(homedir(), ".gorouter");
}

export interface Paths {
  state: string;
  stateJson: string;
  secretsDir: string;
  journalDb: string;
}

export function resolvePaths(base?: string): Paths {
  const state = base ?? stateDir();
  return {
    state,
    stateJson: join(state, "state.json"),
    secretsDir: join(state, "secrets"),
    journalDb: join(state, "journal.db"),
  };
}

export function ensureStateDirs(paths: Paths): void {
  mkdirSync(paths.state, { recursive: true });
  mkdirSync(paths.secretsDir, { recursive: true });
}
