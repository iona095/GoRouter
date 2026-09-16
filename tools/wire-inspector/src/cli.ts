/**
 * wire-inspector CLI: capture | scenarios | run | matrix | diff
 *   + response-scenarios | response-run | response-matrix (WI03)
 * Usage:
 *   bun src/cli.ts capture [--port 0]
 *   bun src/cli.ts scenarios
 *   bun src/cli.ts run [--scenario <id>] [--out output]
 *   bun src/cli.ts matrix [--out output]
 *   bun src/cli.ts diff <inbound.sanitized.json> <outbound.sanitized.json>
 */
import { readFileSync } from "node:fs";
import { startCaptureServer } from "./capture-server.ts";
import { wireInspectorRun } from "./run.ts";
import { wireInspectorMatrix } from "./matrix.ts";
import { listScenarios } from "./scenarios.ts";
import { listResponseScenarios } from "./response-scenarios.ts";
import { wireResponseRun } from "./response-run.ts";
import { wireResponseMatrix } from "./response-matrix.ts";
import { buildDiff, renderDiffText } from "./diff.ts";

function usage(): string {
  return [
    "wire-inspector (WI synthetic, loopback only)",
    "  capture [--port N]                  start loopback capture endpoint (no proxy)",
    "  scenarios                           list registered executable scenarios",
    "  run [--scenario ID] [--out DIR]     run one scenario -> output/<run-id>/ (unknown ids fail closed)",
    "  matrix [--out DIR]                  run all WI02 scenarios -> output/matrix-<id>/",
    "  response-scenarios                  list registered WI03 response scenarios",
    "  response-run --scenario ID [--out DIR]  run one response scenario -> output/response-<id>/",
    "  response-matrix [--out DIR]         run all WI03 scenarios -> output/response-matrix-<id>/",
    "  diff <inbound.json> <outbound.json> semantic diff (sanitized inputs)",
  ].join("\n");
}

function argVal(args: string[], name: string): string | null {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1]! : null;
}

async function cmdCapture(args: string[]): Promise<number> {
  const portRaw = argVal(args, "--port");
  const port = portRaw ? Number(portRaw) : 0;
  const srv = await startCaptureServer({ port });
  const fixture = {
    syntheticUpstreamBase: srv.baseUrl,
    host: "127.0.0.1",
    port: srv.port,
    loopbackOnly: true,
    endpointOnly: true,
    proxy: false,
    connect: "refused",
    redirect: "none (answers 200 directly)",
    usage: "Set GoRouter upstreamGo/upstreamZen to this base via the accepted loopback seam (isolated synthetic state only).",
  };
  console.log(JSON.stringify(fixture, null, 2));
  console.log("capture listening on " + srv.baseUrl + " (Ctrl-C to stop; endpoint only, no proxy)");
  const stop = () => { try { srv.stop(); } catch {} process.exit(0); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  await new Promise(() => {});
  return 0;
}

async function cmdRun(args: string[]): Promise<number> {
  const scenario = argVal(args, "--scenario") ?? "chat-completions-stream";
  const out = argVal(args, "--out") ?? "output";
  const { resolve } = await import("node:path");
  const outDir = resolve(import.meta.dir, "..", out);
  const r = await wireInspectorRun({ outDir, scenario });
  console.log(r.summary);
  console.log("wrote " + r.outPath);
  return 0;
}

function cmdScenarios(): number {
  for (const s of listScenarios()) {
    console.log(s.id + " [" + s.lane + "] " + s.clientPath + " — " + s.description);
    console.log("    support: " + s.support + " | evidence: " + s.routeEvidence.slice(0, 160) + "…");
  }
  return 0;
}

async function cmdMatrix(args: string[]): Promise<number> {
  const out = argVal(args, "--out") ?? "output";
  const { resolve } = await import("node:path");
  const outDir = resolve(import.meta.dir, "..", out);
  const r = await wireInspectorMatrix({ outDir });
  console.log("matrix " + r.matrixId);
  console.log("scenarios: " + r.scenarioIds.join(", "));
  console.log("wrote " + r.matrixRoot);
  return 0;
}

function cmdResponseScenarios(): number {
  for (const s of listResponseScenarios()) {
    console.log(s.id + " [" + s.lane + " " + s.responseKind + " ->" + s.upstreamStatus + "] " + s.clientPath + " — " + s.description);
  }
  return 0;
}

async function cmdResponseRun(args: string[]): Promise<number> {
  const idx = args.indexOf("--scenario");
  const scenario = idx >= 0 && idx + 1 < args.length ? args[idx + 1]! : "chat-json-200";
  const outIdx = args.indexOf("--out");
  const out = outIdx >= 0 && outIdx + 1 < args.length ? args[outIdx + 1]! : "output";
  const { resolve } = await import("node:path");
  const outDir = resolve(import.meta.dir, "..", out);
  const r = await wireResponseRun({ outDir, scenario });
  console.log(r.summary);
  console.log("wrote " + r.outPath);
  return 0;
}

async function cmdResponseMatrix(args: string[]): Promise<number> {
  const out = argVal(args, "--out") ?? "output";
  const { resolve } = await import("node:path");
  const outDir = resolve(import.meta.dir, "..", out);
  const r = await wireResponseMatrix({ outDir });
  console.log("response-matrix " + r.matrixId);
  console.log("scenarios: " + r.scenarioIds.join(", "));
  console.log("wrote " + r.matrixRoot);
  return 0;
}

async function cmdDiff(args: string[]): Promise<number> {
  if (args.length < 2) {
    console.error("usage: wire-inspector diff <inbound.json> <outbound.json>");
    return 2;
  }
  const a = JSON.parse(readFileSync(args[0]!, "utf8")) as Record<string, unknown>;
  const b = JSON.parse(readFileSync(args[1]!, "utf8")) as Record<string, unknown>;
  const pickSide = (doc: Record<string, unknown>) => {
    const method = String((doc as { method?: unknown }).method ?? "POST");
    const path = String((doc as { path?: unknown }).path ?? "/");
    const query = String((doc as { query?: unknown }).query ?? "");
    const headers = ((doc as { headers?: unknown }).headers ?? {}) as Record<string, string>;
    const body = (doc as { body?: unknown }).body ?? {};
    return { method, path, query, headers, body };
  };
  const d = buildDiff(pickSide(a), pickSide(b));
  const text = renderDiffText(d);
  console.log(text);
  // Also emit sanitized JSON beside cwd? Contract wants human + JSON; print JSON to stdout after marker.
  console.log("--- diff.sanitized.json ---");
  console.log(JSON.stringify({
    method: d.method, path: d.path, query: d.query,
    session: d.session, userAgent: d.userAgent, authorization: d.authorization,
    headers: d.headers,
    body: { identical: d.body.identical, added: d.body.added, removed: d.body.removed, changed: d.body.changed, fields: d.body.fields },
  }, null, 2));
  return 0;
}

const [cmd, ...rest] = Bun.argv.slice(2);
if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") {
  console.log(usage());
  process.exit(0);
}
let code = 0;
try {
  if (cmd === "capture") code = await cmdCapture(rest);
  else if (cmd === "scenarios") code = cmdScenarios();
  else if (cmd === "run") code = await cmdRun(rest);
  else if (cmd === "matrix") code = await cmdMatrix(rest);
  else if (cmd === "response-scenarios") code = cmdResponseScenarios();
  else if (cmd === "response-run") code = await cmdResponseRun(rest);
  else if (cmd === "response-matrix") code = await cmdResponseMatrix(rest);
  else if (cmd === "diff") code = await cmdDiff(rest);
  else {
    console.error("unknown command '" + cmd + "'\n" + usage());
    code = 2;
  }
} catch (e) {
  console.error("wire-inspector " + cmd + " failed: " + (e instanceof Error ? e.message : String(e)));
  code = 1;
}
process.exit(code);
