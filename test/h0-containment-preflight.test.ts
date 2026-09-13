/**
 * H0 containment preflight (C03): machine-checked C02-derivative invariants,
 * executed INSIDE the envelope before/around application tests. Every bound
 * C03 batch runs this file (standalone B0 batch first, then embedded in each
 * test batch). Failure here invalidates the batch regardless of app results.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync, existsSync, writeFileSync, unlinkSync } from "node:fs";
import { networkInterfaces } from "node:os";

const SECRET_RE = /token|key|secret|cred|cookie|session|auth|bearer|apikey|openai|opencode|anthropic|gemini|authorization/i;

function proc(p: string): string | null {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

describe("h0 containment preflight (C02 derivative, per-batch)", () => {
  test("no external network interfaces (loopback namespace only)", () => {
    const ifaces = networkInterfaces();
    const addrs: string[] = [];
    for (const list of Object.values(ifaces)) for (const a of list ?? []) addrs.push(a.address);
    expect(addrs.length).toBeGreaterThan(0);
    for (const a of addrs) {
      expect(a === "127.0.0.1" || a === "::1").toBe(true);
    }
  });

  test("no external routes (empty route table)", () => {
    const route = proc("/proc/net/route");
    expect(route).not.toBeNull();
    const lines = route!.trim().split("\n");
    expect(lines.length).toBeLessThanOrEqual(1);
  });

  test("no production/host mounts (no Main, no daemon socket)", () => {
    const mounts = proc("/proc/mounts");
    expect(mounts).not.toBeNull();
    expect(/gorouter|Main|docker\.sock|docker\.engine/i.test(mounts!)).toBe(false);
  });

  test("production source paths absent (ENOENT)", () => {
    for (const p of ["/Main", "/.git", "/github", "/prod", "/host"]) {
      let code = "READABLE!!!";
      try {
        readFileSync(p);
      } catch (e) {
        code = (e as { code?: string }).code ?? "ERR";
      }
      expect(code).toBe("ENOENT");
    }
  });

  test("contained environment allowlisted (no secret-bearing names; scratch roots)", () => {
    const names = Object.keys(process.env);
    expect(names.some((n) => SECRET_RE.test(n))).toBe(false);
    expect(process.env.HOME ?? "").toMatch(/^\/w\//);
    expect(process.env.TMPDIR ?? "").toMatch(/^\/w\//);
    expect(process.env.S0_RUN_ID ?? "").toBeTruthy();
  });

  test("least privilege: zero effective capabilities, no-new-privs set", () => {
    const st = proc("/proc/self/status") ?? "";
    const eff = /^CapEff:\s*([0-9a-f]+)/m.exec(st)?.[1];
    expect(eff).toBe("0000000000000000");
    const nnp = /^NoNewPrivs:\s*(\d)/m.exec(st)?.[1];
    expect(nnp).toBe("1");
  });

  test("disposable snapshot is the only source tree (positive + writable scratch)", () => {
    expect(existsSync("/s/snapshot-manifest.txt")).toBe(true);
    expect(existsSync("/s/src/server.ts")).toBe(true);
    expect(existsSync("/s/src/probe.ts")).toBe(true);
    writeFileSync("/w/tmp/.preflight", "ok");
    unlinkSync("/w/tmp/.preflight");
  });
});
