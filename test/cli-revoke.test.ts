/**
 * F-21: revoke truthfulness at the real CLI boundary (subprocess, temp
 * GOROUTER_STATE_DIR — never the operator's state). Revoke must not exit 0
 * and print success when nothing was revoked or the change never reached DSH.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePaths, ensureStateDirs } from "../src/paths.ts";
import { initializeApprovalStore, type ApprovalTuple } from "../src/models/dsh-approvals.ts";
import { storeRegistry, emptyRegistryFile } from "../src/models/registry.ts";
import type { Lane } from "../src/state.ts";

const MAIN = "M:/AIFUN/GoRouter/Main";
const NOW = "2026-09-05T00:00:00.000Z";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tup(lane: Lane, modelId: string): ApprovalTuple {
  return lane === "go"
    ? { lane, modelId, dshProviderId: "gorouter-go", apiProtocol: "openai-completions" }
    : { lane, modelId, dshProviderId: "gorouter-zen", apiProtocol: "openai-responses" };
}

function seedState(approved: ApprovalTuple[], withRegistry: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "gorouter-cli-"));
  dirs.push(dir);
  const paths = resolvePaths(dir);
  ensureStateDirs(paths);
  initializeApprovalStore(paths, approved, "operator", { nowIso: NOW });
  if (withRegistry) {
    const reg = emptyRegistryFile(NOW);
    reg.go = { fetchedAtUtc: NOW, models: [{ id: "g1" }] };
    reg.zen = { fetchedAtUtc: NOW, models: [{ id: "z1" }] };
    storeRegistry(paths, reg);
  }
  return dir;
}

async function runCli(dir: string, args: string[]): Promise<{ code: number | null; out: string }> {
  const p = Bun.spawn([process.execPath, "src/cli.ts", ...args], {
    cwd: MAIN,
    env: { ...process.env, GOROUTER_STATE_DIR: dir },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  return { code, out: out + "\n" + err };
}

describe("cli revoke truthfulness (F-21)", () => {
  test("revoke of a never-approved model exits non-zero and never prints success", async () => {
    const dir = seedState([tup("go", "g1")], false);
    const r = await runCli(dir, ["models", "approvals", "revoke", "--lane", "go", "never-approved"]);
    expect(r.code).not.toBe(0);
    expect(r.out).not.toMatch(/^revoked /m);
    expect(r.out).toMatch(/nothing to revoke|not approved/i);
  }, 60000);

  test("revoke with unreachable DSH exits non-zero (approval removed, propagation failed)", async () => {
    // Registry present but no DSH settings file: sync cannot reach DSH, so
    // the model may still be live there despite the local revocation.
    const dir = seedState([tup("go", "g1")], true);
    const r = await runCli(dir, ["models", "approvals", "revoke", "--lane", "go", "g1"]);
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/may still be active|not.*reach/i);
  }, 60000);
});
