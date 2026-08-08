/**
 * GoRouter V1.5 — desktop evidence mini-coherence scenario (slice E).
 *
 * Runs the REAL control service (dev mode) against a fresh temp state dir,
 * performs a CLI route switch, and captures the full evidence trail into a
 * JSON artifact:
 *
 *   - CLI outputs (setup / account add / route zen) with the local
 *     credential redacted
 *   - the GUI snapshot before and after the CLI mutation (proves the
 *     service's state-mtime watch pushed the change)
 *   - journal.recent rows (UI data path)
 *   - service stdout/stderr tails and exit code
 *
 * Usage: bun scripts/desktop-evidence-scenario.ts --out <evidence.json>
 *
 * Cleanup is mandatory: app.exit with stopRouter, then a hard tree kill of
 * the service if it did not exit. Never touches the real %LOCALAPPDATA%
 * state or port 8787.
 */
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomBytes } from "node:crypto"
import { spawnSync } from "node:child_process"
import { ControlClient, readAdminToken } from "../test/control-client.ts"

const REPO_ROOT = join(import.meta.dir, "..")
const BUN = process.execPath
const CLI = "src/cli.ts"
const SERVICE = join(REPO_ROOT, "src", "desktop", "control-service.ts")
const FAKE_ROUTER = join(REPO_ROOT, "test", "fake-router.ts")
const LOCAL_KEY_RE = /^[A-Za-z0-9_-]{40,}$/

function arg(name: string): string {
  const i = process.argv.indexOf(name)
  if (i < 0 || !process.argv[i + 1]) throw new Error(`missing required argument ${name}`)
  return process.argv[i + 1]!
}

interface CliResult {
  status: number
  stdout: string
  stderr: string
}

function runCli(stateDir: string, args: string[], input?: string): Promise<CliResult> {
  return new Promise((resolve) => {
    const proc = Bun.spawn([BUN, CLI, ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, GOROUTER_STATE_DIR: stateDir },
      stdin: input === undefined ? "inherit" : "pipe",
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    })
    const out: Uint8Array[] = []
    const err: Uint8Array[] = []
    ;(async () => {
      if (input !== undefined && proc.stdin) {
        proc.stdin.write(input)
        proc.stdin.end()
      }
    })()
    ;(async () => {
      for await (const chunk of proc.stdout) out.push(chunk as Uint8Array)
    })()
    ;(async () => {
      for await (const chunk of proc.stderr) err.push(chunk as Uint8Array)
    })()
    proc.exited.then((status) =>
      resolve({
        status,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      }),
    )
  })
}

async function freePort(): Promise<number> {
  const srv = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("", { status: 503 }) })
  const p = srv.port
  srv.stop(true)
  return p ?? 0
}

function redact(text: string, secrets: string[]): string {
  let out = text
  for (const s of secrets) out = out.split(s).join("[REDACTED]")
  return out
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function main(): Promise<number> {
  const outPath = arg("--out")
  const dir = mkdtempSync(join(tmpdir(), "gorouter-evidence-"))
  const port = await freePort()
  const pipePath = `\\\\.\\pipe\\gorouter-evidence-${randomBytes(6).toString("hex")}`
  const secretsToRedact: string[] = []
  let service: ReturnType<typeof Bun.spawn> | null = null
  let client: ControlClient | null = null
  const evidence: Record<string, unknown> = {
    scenario: "cli-route-switch-coherence",
    generatedAtUtc: new Date().toISOString(),
    stateDir: dir,
    pipe: pipePath,
    port,
  }
  const outChunks: Uint8Array[] = []
  const errChunks: Uint8Array[] = []

  try {
    // --- CLI setup of a fresh temp state (real DPAPI) --------------------
    const setup = await runCli(dir, ["setup"])
    if (setup.status !== 0) throw new Error(`setup failed: ${setup.stderr}`)
    const credLine = setup.stdout.split("\n").find((l) => LOCAL_KEY_RE.test(l.trim()))
    if (!credLine) throw new Error("setup did not print a local credential")
    secretsToRedact.push(credLine.trim())
    const add = await runCli(dir, ["account", "add", "alpha"], "sk-evidence-account-0123456789")
    if (add.status !== 0) throw new Error(`account add failed: ${add.stderr}`)
    const setPort = await runCli(dir, ["config", "set", "port", String(port)])
    if (setPort.status !== 0) throw new Error(`config set port failed: ${setPort.stderr}`)
    const routeGo = await runCli(dir, ["route", "go", "alpha"])
    if (routeGo.status !== 0) throw new Error(`route go failed: ${routeGo.stderr}`)
    evidence.cli = {
      setup: { status: setup.status, stdout: redact(setup.stdout, secretsToRedact), stderr: redact(setup.stderr, secretsToRedact) },
      accountAddAlpha: { status: add.status, stdout: redact(add.stdout, secretsToRedact), stderr: redact(add.stderr, secretsToRedact) },
      configSetPort: { status: setPort.status, stdout: redact(setPort.stdout, secretsToRedact), stderr: redact(setPort.stderr, secretsToRedact) },
      routeGoAlpha: { status: routeGo.status, stdout: redact(routeGo.stdout, secretsToRedact), stderr: redact(routeGo.stderr, secretsToRedact) },
    }

    // --- start the REAL control service (dev mode, fake managed router) --
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      GOROUTER_STATE_DIR: dir,
      GOROUTER_DESKTOP_PIPE: pipePath,
      GOROUTER_DESKTOP_ROUTER_CMD_JSON: JSON.stringify([BUN, FAKE_ROUTER, "<port>"]),
      GOROUTER_LOG_LEVEL: "error",
    }
    service = Bun.spawn([BUN, SERVICE], { cwd: REPO_ROOT, env, stdout: "pipe", stderr: "pipe", windowsHide: true })
    evidence.servicePid = service.pid
    const svcStdout = service.stdout as ReadableStream<Uint8Array>
    const svcStderr = service.stderr as ReadableStream<Uint8Array>
    ;(async () => {
      for await (const chunk of svcStdout) outChunks.push(chunk as Uint8Array)
    })()
    ;(async () => {
      for await (const chunk of svcStderr) errChunks.push(chunk as Uint8Array)
    })()

    // --- connect: wait for the admin token blob, hello, initial snapshot --
    const blob = join(dir, "secrets", "sec_desktop_admin.bin")
    const deadline = Date.now() + 10_000
    while (!existsSync(blob)) {
      if (service.exitCode !== null) throw new Error("service exited before creating the admin token")
      if (Date.now() >= deadline) throw new Error(`admin token blob never appeared: ${blob}`)
      await Bun.sleep(100)
    }
    client = new ControlClient(pipePath, readAdminToken(dir))
    await client.connect(10_000)
    evidence.snapshotBefore = client.latest

    // --- CLI route switch while the service watches ----------------------
    const routeZen = await runCli(dir, ["route", "zen", "alpha"])
    if (routeZen.status !== 0) throw new Error(`route zen failed: ${routeZen.stderr}`)
    evidence.cli = {
      ...(evidence.cli as Record<string, unknown>),
      routeZenAlpha: {
        status: routeZen.status,
        stdout: redact(routeZen.stdout, secretsToRedact),
        stderr: redact(routeZen.stderr, secretsToRedact),
      },
    }
    const after = await client.waitSnapshot((s) => s.routes.zen.alias === "alpha", 5_000)
    evidence.snapshotAfter = after
    const jr = await client.request("journal.recent", { limit: 200 })
    evidence.journalRecent = jr

    // --- graceful shutdown -------------------------------------------------
    try {
      await client.request("app.exit", { stopRouter: true }, 4_000)
    } catch { /* killed below */ }
    client.close()
    client = null
    if (service.exitCode === null) {
      const exited = await Promise.race([service.exited.then(() => true), Bun.sleep(5_000).then(() => false)])
      if (!exited) service.kill()
      try { await service.exited } catch { /* already gone */ }
    }
    evidence.serviceExitCode = service.exitCode
    evidence.serviceStdoutTail = Buffer.concat(outChunks).toString("utf8").split("\n").slice(-40).join("\n")
    evidence.serviceStderrTail = Buffer.concat(errChunks).toString("utf8").split("\n").slice(-40).join("\n")

    await Bun.write(outPath, JSON.stringify(evidence, null, 2))
    console.log(`scenario ok: ${outPath}`)
    return 0
  } catch (e) {
    evidence.error = e instanceof Error ? e.message : String(e)
    if (client) {
      try { client.close() } catch { /* ignore */ }
    }
    if (service && service.exitCode === null) {
      evidence.serviceExitCode = null
      try { service.kill() } catch { /* ignore */ }
      try { await service.exited } catch { /* ignore */ }
      // tree kill: managed router child of the service must not survive
      if (service.pid !== undefined) {
        const r = spawnSync("taskkill", ["/PID", String(service.pid), "/T", "/F"], { windowsHide: true })
        void r
      }
    }
    evidence.serviceStdoutTail = Buffer.concat(outChunks).toString("utf8").split("\n").slice(-40).join("\n")
    evidence.serviceStderrTail = Buffer.concat(errChunks).toString("utf8").split("\n").slice(-40).join("\n")
    try { await Bun.write(outPath, JSON.stringify(evidence, null, 2)) } catch { /* evidence write is best-effort */ }
    console.error(`scenario failed: ${evidence.error}`)
    return 1
  } finally {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* temp dir cleanup is best-effort */ }
  }
}

process.exit(await main())
