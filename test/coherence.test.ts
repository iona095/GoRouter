/**
 * GoRouter V1.5 — integration coherence suite (slice E).
 *
 * Drives the REAL control service (src/desktop/control-service.ts) as a
 * subprocess in dev mode against temp state dirs, together with the REAL
 * CLI (src/cli.ts) and the REAL router, to prove cross-process coherence:
 *
 *   a. CLI -> service mutation visibility (route switch) + event push
 *   b. account rename coherence (stable id, route alias follows)
 *   c. managed router end-to-end (auto-start, fake + real router, real
 *      proxied request, journal.recent safe-field UI data path)
 *   d. supervisor attach (external router adopted, never spawned)
 *   e. port conflict classification
 *   f. crash backoff (bounded restarts, then failed)
 *   g. concurrent mutations across two pipe clients + one CLI (lost-update
 *      proof under the cross-process mutation lock)
 *   h. journal degradation without blocking routing
 *
 * Windows-only by construction (named pipe + DPAPI). Never touches the real
 * %LOCALAPPDATA%\GoRouter state or port 8787: every process gets a temp
 * GOROUTER_STATE_DIR and every service spawn overrides the pipe and router
 * command.
 */
import { describe, test, expect, afterEach, afterAll } from "bun:test"
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomBytes } from "node:crypto"
import { spawnSync } from "node:child_process"
import { startMockUpstream } from "./harness.ts"
import { ControlClient, readAdminToken, type SnapshotData, type JournalRow } from "./control-client.ts"

const BUN = process.execPath
const REPO_ROOT = join(import.meta.dir, "..")
const SERVICE = join(REPO_ROOT, "src", "desktop", "control-service.ts")
const CLI = "src/cli.ts"
const FAKE_ROUTER = join(import.meta.dir, "fake-router.ts")
const LOCAL_KEY_RE = /^[A-Za-z0-9_-]{40,}$/

interface ServiceHandle {
  dir: string
  pipePath: string
  proc: ReturnType<typeof Bun.spawn>
  client: ControlClient | null
  lastRouterPid: number | null
  outChunks: Uint8Array[]
  errChunks: Uint8Array[]
}

const stateDirs: string[] = []
const services: ServiceHandle[] = []
const extraProcs: ReturnType<typeof Bun.spawn>[] = []
const servers: { stop: () => void }[] = []

afterEach(async () => {
  for (const s of services.splice(0)) await stopService(s)
  for (const p of extraProcs.splice(0)) {
    try { p.kill() } catch { /* already gone */ }
  }
  for (const s of servers.splice(0)) {
    try { s.stop() } catch { /* already stopped */ }
  }
  for (const d of stateDirs.splice(0)) {
    // WAL -shm/-wal handles release asynchronously on Windows under load
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        rmSync(d, { recursive: true, force: true })
        break
      } catch {
        await Bun.sleep(300 * (attempt + 1))
      }
    }
  }
})

afterAll(async () => {
  for (const s of services.splice(0)) await stopService(s)
  for (const p of extraProcs.splice(0)) {
    try { p.kill() } catch { /* already gone */ }
  }
  for (const s of servers.splice(0)) {
    try { s.stop() } catch { /* already stopped */ }
  }
})

function freshStateDir(): string {
  const d = mkdtempSync(join(tmpdir(), "gorouter-coherence-"))
  stateDirs.push(d)
  return d
}

function serviceLogs(h: ServiceHandle): string {
  const out = Buffer.concat(h.outChunks).toString("utf8")
  const err = Buffer.concat(h.errChunks).toString("utf8")
  return `--- service stdout ---\n${out}\n--- service stderr ---\n${err}`
}

function runCli(
  stateDir: string,
  args: string[],
  input?: string,
): Promise<{ status: number; stdout: string; stderr: string }> {
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
    proc.exited.then((status) => {
      resolve({
        status,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      })
    })
  })
}

/** CLI setup + one account + port (and optional upstream/route) via the REAL CLI. */
async function initState(
  dir: string,
  opts: { port: number; upstream?: string; accountSecret?: string; routeGo?: boolean },
): Promise<{ localCredential: string; accountId: string }> {
  const setup = await runCli(dir, ["setup"])
  expect(setup.status).toBe(0)
  const credLine = setup.stdout.split("\n").find((l) => LOCAL_KEY_RE.test(l.trim()))
  expect(credLine, `setup must print a local credential\n${setup.stdout}`).toBeTruthy()
  const secret = opts.accountSecret ?? "sk-coherence-alpha-0123456789"
  const add = await runCli(dir, ["account", "add", "alpha"], secret)
  expect(add.status, add.stderr).toBe(0)
  expect(add.stdout).not.toContain(secret)
  const port = await runCli(dir, ["config", "set", "port", String(opts.port)])
  expect(port.status, port.stderr).toBe(0)
  if (opts.upstream) {
    const ug = await runCli(dir, ["config", "set", "upstreamGo", opts.upstream])
    expect(ug.status, ug.stderr).toBe(0)
    const uz = await runCli(dir, ["config", "set", "upstreamZen", opts.upstream])
    expect(uz.status, uz.stderr).toBe(0)
  }
  if (opts.routeGo) {
    const r = await runCli(dir, ["route", "go", "alpha"])
    expect(r.status, r.stderr).toBe(0)
  }
  const list = await runCli(dir, ["account", "list"])
  const idMatch = list.stdout.match(/alpha\tid=(acct_[0-9a-f-]+)/)
  expect(idMatch, `account list must show alpha with id\n${list.stdout}`).toBeTruthy()
  return { localCredential: credLine!.trim(), accountId: idMatch![1]! }
}

async function freePort(): Promise<number> {
  const srv = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("", { status: 503 }) })
  const p = srv.port
  srv.stop(true)
  return p ?? 0
}

function spawnService(
  dir: string,
  opts: { pipePath: string; routerCmdJson?: string[] },
): ServiceHandle {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    GOROUTER_STATE_DIR: dir,
    GOROUTER_DESKTOP_PIPE: opts.pipePath,
    GOROUTER_LOG_LEVEL: "error",
  }
  if (opts.routerCmdJson) {
    env.GOROUTER_DESKTOP_ROUTER_CMD_JSON = JSON.stringify(opts.routerCmdJson)
  }
  const proc = Bun.spawn([BUN, SERVICE], {
    cwd: REPO_ROOT,
    env,
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  })
  const h: ServiceHandle = { dir, pipePath: opts.pipePath, proc, client: null, lastRouterPid: null, outChunks: [], errChunks: [] }
  ;(async () => {
    for await (const chunk of proc.stdout) h.outChunks.push(chunk as Uint8Array)
  })()
  ;(async () => {
    for await (const chunk of proc.stderr) h.errChunks.push(chunk as Uint8Array)
  })()
  services.push(h)
  return h
}

function assertServiceAlive(h: ServiceHandle): void {
  if (h.proc.exitCode !== null) {
    throw new Error(`control service exited early (code ${h.proc.exitCode})\n${serviceLogs(h)}`)
  }
}

/** Wait for the service-created admin token blob, then connect + hello + initial snapshot. */
async function connectClient(h: ServiceHandle, timeoutMs = 10_000): Promise<ControlClient> {
  const blob = join(h.dir, "secrets", "sec_desktop_admin.bin")
  const deadline = Date.now() + timeoutMs
  while (!existsSync(blob)) {
    assertServiceAlive(h)
    if (Date.now() >= deadline) throw new Error(`admin token blob never appeared at ${blob}\n${serviceLogs(h)}`)
    await Bun.sleep(100)
  }
  let token: string
  try {
    token = readAdminToken(h.dir)
  } catch (e) {
    throw new Error(`admin token unprotect failed: ${e instanceof Error ? e.message : String(e)}`)
  }
  const client = new ControlClient(h.pipePath, token)
  try {
    await client.connect(timeoutMs)
  } catch (e) {
    client.close()
    throw new Error(`pipe connect failed (${h.pipePath}): ${e instanceof Error ? e.message : String(e)}\n${serviceLogs(h)}`)
  }
  h.client = client
  h.lastRouterPid = client.latest?.router?.pid ?? null
  return client
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function stopService(h: ServiceHandle): Promise<void> {
  if (h.client) {
    // capture the latest managed-child pid so the orphan backstop can find it
    try {
      const s = await h.client.snapshot(4_000)
      if (s.router.pid !== null && s.router.pid !== undefined) h.lastRouterPid = s.router.pid
    } catch { /* service may already be gone */ }
    try {
      await h.client.request("app.exit", { stopRouter: true }, 4_000)
    } catch { /* fall through to hard stop */ }
    h.client.close()
    h.client = null
  }
  if (h.proc.exitCode === null) {
    const exited = await Promise.race([
      h.proc.exited.then(() => true),
      Bun.sleep(5_000).then(() => false),
    ])
    if (!exited) {
      try { h.proc.kill() } catch { /* already gone */ }
      try { await h.proc.exited } catch { /* already gone */ }
    }
  }
  // Orphan backstop: if a managed child was left behind (service killed
  // before app.exit), terminate its tree. Attached external routers are
  // never killed here (their owners stop them).
  if (h.lastRouterPid !== null && isAlive(h.lastRouterPid)) {
    const r = spawnSync("taskkill", ["/PID", String(h.lastRouterPid), "/T", "/F"], { windowsHide: true })
    if (r.status !== 0 && isAlive(h.lastRouterPid)) {
      // last resort: direct kill
      try { process.kill(h.lastRouterPid, "SIGKILL") } catch { /* already gone */ }
    }
  }
}

function waitForHealthz(port: number, timeoutMs = 8_000): Promise<Response> {
  const deadline = Date.now() + timeoutMs
  return (async () => {
    for (;;) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/healthz`)
        if (res.status === 200) return res
      } catch { /* not up yet */ }
      if (Date.now() >= deadline) throw new Error(`healthz on ${port} not OK within ${timeoutMs}ms`)
      await Bun.sleep(200)
    }
  })()
}

function routerRunning(s: SnapshotData): boolean {
  return s.router.state === "running" && s.router.mode === "managed"
}

describe("GoRouter V1.5 desktop coherence (real control service)", () => {
  test("a: CLI route switch appears in GUI snapshot + event push; GUI route.set visible to CLI", async () => {
    const dir = freshStateDir()
    const port = await freePort()
    await initState(dir, { port })
    const pipePath = `\\\\.\\pipe\\gorouter-ctrl-test-${randomBytes(6).toString("hex")}`
    const h = spawnService(dir, {
      pipePath,
      routerCmdJson: [BUN, FAKE_ROUTER, "<port>"],
    })
    const client = await connectClient(h)
    expect(client.latest!.firstRun).toBe(false)
    expect(client.latest!.initialized).toBe(true)
    expect(client.latest!.routes.go.alias).toBeNull()

    // CLI mutation -> pushed event + polled snapshot coherence
    const eventsBefore = client.events.length
    const r = await runCli(dir, ["route", "go", "alpha"])
    expect(r.status, r.stderr).toBe(0)
    const snap = await client.waitEvent((s) => s.routes.go.alias === "alpha", 5_000)
    expect(snap.data.routes.go.alias).toBe("alpha")
    expect(client.events.length).toBeGreaterThan(eventsBefore)

    // GUI mutation -> CLI visibility
    const alphaId = client.latest!.accounts.find((a) => a.alias === "alpha")!.id
    const set = await client.request("route.set", { lane: "zen", accountId: alphaId })
    expect(set.ok, JSON.stringify(set.error)).toBe(true)
    await client.waitSnapshot((s) => s.routes.zen.alias === "alpha", 5_000)
    const status = await runCli(dir, ["status"])
    expect(status.status).toBe(0)
    expect(status.stdout).toContain("GO  -> alpha")
    expect(status.stdout).toContain("ZEN -> alpha")
  }, 90_000)

  test("b: CLI account rename updates GUI snapshot with stable id", async () => {
    const dir = freshStateDir()
    const port = await freePort()
    await initState(dir, { port, routeGo: true })
    const pipePath = `\\\\.\\pipe\\gorouter-ctrl-test-${randomBytes(6).toString("hex")}`
    const h = spawnService(dir, { pipePath, routerCmdJson: [BUN, FAKE_ROUTER, "<port>"] })
    const client = await connectClient(h)
    const idBefore = client.latest!.accounts.find((a) => a.alias === "alpha")!.id
    expect(client.latest!.routes.go.alias).toBe("alpha")

    const ren = await runCli(dir, ["account", "rename", "alpha", "beta"])
    expect(ren.status, ren.stderr).toBe(0)

    const snap = await client.waitSnapshot(
      (s) => s.accounts.some((a) => a.alias === "beta") && !s.accounts.some((a) => a.alias === "alpha"),
      5_000,
    )
    const beta = snap.accounts.find((a) => a.alias === "beta")!
    expect(beta.id).toBe(idBefore)
    // route alias follows the renamed account (route keeps the account id)
    expect(snap.routes.go.accountId).toBe(idBefore)
    expect(snap.routes.go.alias).toBe("beta")
  }, 60_000)

  test("c: managed router auto-start (fake) + real router proxied request + journal UI data path", async () => {
    // Part 1: auto-start spawns the configured (fake) router -> managed/running
    const dir1 = freshStateDir()
    const port1 = await freePort()
    const upstream1 = await startMockUpstream()
    servers.push({ stop: () => upstream1.stop() })
    // GR-005: the managed fake must prove identity (challenge HMAC over the
    // seeded local credential) or supervision never reaches running.
    const { localCredential: cred1 } = await initState(dir1, { port: port1, upstream: upstream1.baseUrl, routeGo: true })
    const pipe1 = `\\\\.\\pipe\\gorouter-ctrl-test-${randomBytes(6).toString("hex")}`
    const h1 = spawnService(dir1, { pipePath: pipe1, routerCmdJson: [BUN, FAKE_ROUTER, "<port>", "--secret", cred1] })
    const c1 = await connectClient(h1)
    await c1.waitSnapshot((s) => routerRunning(s) && s.router.port === port1, 15_000)
    const hz = await fetch(`http://127.0.0.1:${port1}/healthz`)
    expect(hz.status).toBe(200)
    const hzJson = (await hz.json()) as { status: string }
    expect(hzJson.status).toBe("ok")
    await stopService(h1)

    // Part 2: managed REAL router (bun src/cli.ts serve) with mock upstream;
    // a real proxied request must return 200 and journal.recent must expose
    // the safe UI fields (never the body or any secret).
    const dir2 = freshStateDir()
    const port2 = await freePort()
    const upstream2 = await startMockUpstream()
    servers.push({ stop: () => upstream2.stop() })
    const secret = "sk-coherence-real-0123456789abcdef"
    const { localCredential } = await initState(dir2, {
      port: port2,
      upstream: upstream2.baseUrl,
      accountSecret: secret,
      routeGo: true,
    })
    const pipe2 = `\\\\.\\pipe\\gorouter-ctrl-test-${randomBytes(6).toString("hex")}`
    const h2 = spawnService(dir2, {
      pipePath: pipe2,
      routerCmdJson: [BUN, join(REPO_ROOT, "src", "cli.ts"), "serve"],
    })
    const c2 = await connectClient(h2)
    await c2.waitSnapshot((s) => routerRunning(s) && s.router.port === port2, 20_000)

    const body = JSON.stringify({
      model: "gpt-4o",
      messages: [{ role: "user", content: "ping-int-e2e-marker-body" }],
    })
    const res = await fetch(`http://127.0.0.1:${port2}/go/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${localCredential}`,
        "content-type": "application/json",
        "x-gorouter-correlation-id": "int-e2e-correlation-1",
      },
      body,
    })
    expect(res.status).toBe(200)

    const deadline = Date.now() + 10_000
    let rows: JournalRow[] = []
    for (;;) {
      const jr = await c2.request("journal.recent", { limit: 200 })
      expect(jr.ok, JSON.stringify(jr.error)).toBe(true)
      rows = (jr.data as { rows: JournalRow[] }).rows
      if (rows.length >= 1 || Date.now() >= deadline) break
      await Bun.sleep(300)
    }
    expect(rows.length).toBeGreaterThanOrEqual(1)
    const row = rows.find((x) => x.lane === "go" && x.endpointFamily === "chat/completions")
    expect(row, `journal row for the proxied request missing in ${JSON.stringify(rows).slice(0, 600)}`).toBeTruthy()
    expect(row!.httpStatus).toBe(200)
    expect(row!.terminalOutcome).toBe("ok")
    expect(row!.selectedAccountAliasSnapshot).toBe("alpha")
    expect(row!.clientCorrelationId).toBe("int-e2e-correlation-1")
    // safe fields only: never the request body, never any secret
    const serialized = JSON.stringify(rows)
    expect(serialized).not.toContain("ping-int-e2e-marker-body")
    expect(serialized).not.toContain(secret)
    expect(serialized).not.toContain(localCredential)
  }, 120_000)

  test("d: supervisor attaches to an already-running external router and never spawns", async () => {
    const dir = freshStateDir()
    const port = await freePort()
    const { localCredential } = await initState(dir, { port })
    const markerExt = join(dir, "marker-ext.txt")
    const markerSvc = join(dir, "marker-svc.txt")
    const ext = Bun.spawn([BUN, FAKE_ROUTER, String(port), "--marker", markerExt, "--secret", localCredential], {
      cwd: REPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    })
    extraProcs.push(ext)
    await waitForHealthz(port)
    expect(readFileSync(markerExt, "utf8").trim().split("\n").length).toBe(1)
    const extPid = ext.pid

    const pipePath = `\\\\.\\pipe\\gorouter-ctrl-test-${randomBytes(6).toString("hex")}`
    const h = spawnService(dir, {
      pipePath,
      routerCmdJson: [BUN, FAKE_ROUTER, "<port>", "--marker", markerSvc, "--secret", localCredential],
    })
    const client = await connectClient(h)
    const snap = await client.waitSnapshot(
      (s) => s.router.mode === "attached" && s.router.state === "running",
      10_000,
    )
    expect(snap.router.mode).toBe("attached")
    // the service must never have spawned its own child (no second process)
    expect(existsSync(markerSvc)).toBe(false)
    expect(readFileSync(markerExt, "utf8").trim().split("\n").length).toBe(1)

    // graceful exit must not stop the attached external router
    await stopService(h)
    expect(isAlive(extPid)).toBe(true)
    ext.kill()
    const idx = extraProcs.indexOf(ext)
    if (idx >= 0) extraProcs.splice(idx, 1)
  }, 60_000)

  test("e: occupied port with non-router healthz -> port_conflict", async () => {
    const dir = freshStateDir()
    const port = await freePort()
    await initState(dir, { port })
    const occupier = Bun.serve({
      hostname: "127.0.0.1",
      port,
      fetch: () => new Response("not the router", { status: 404 }),
    })
    servers.push({ stop: () => occupier.stop(true) })

    const markerSvc = join(dir, "marker-svc.txt")
    const pipePath = `\\\\.\\pipe\\gorouter-ctrl-test-${randomBytes(6).toString("hex")}`
    const h = spawnService(dir, {
      pipePath,
      routerCmdJson: [BUN, FAKE_ROUTER, "<port>", "--marker", markerSvc],
    })
    const client = await connectClient(h)
    const snap = await client.waitSnapshot((s) => s.router.state === "port_conflict", 5_000)
    expect(snap.router.port).toBe(port)
    // probe-first supervision: the configured child must never have been spawned
    expect(existsSync(markerSvc)).toBe(false)
  }, 45_000)

  test("f: crash backoff is bounded and ends in failed", async () => {
    const dir = freshStateDir()
    const port = await freePort()
    await initState(dir, { port })
    const marker = join(dir, "marker-crash.txt")
    const pipePath = `\\\\.\\pipe\\gorouter-ctrl-test-${randomBytes(6).toString("hex")}`
    const h = spawnService(dir, {
      pipePath,
      routerCmdJson: [BUN, FAKE_ROUTER, "<port>", "--die-after-ms", "400", "--marker", marker],
    })
    const client = await connectClient(h)

    // the child crashes 400ms after each start: degraded with a restart count
    const degraded = await client.waitSnapshot(
      (s) => s.router.state === "degraded" && s.router.restartCount >= 1,
      20_000,
    )
    expect(degraded.router.restartCount).toBeGreaterThanOrEqual(1)

    // backoff exhausts after the bounded retry sequence -> failed
    // (1s+0.4 + 2s+0.4 + 4s+0.4 + 8s+0.4 + 16s+0.4 of restarts)
    const failed = await client.waitSnapshot((s) => s.router.state === "failed", 45_000)
    // 1s,2s,4s,8s,16s => at most 5 restarts (initial spawn + restarts <= 6)
    expect(failed.router.restartCount).toBeLessThanOrEqual(6)
    const spawns = readFileSync(marker, "utf8").trim().split("\n").filter((l) => l.length > 0).length
    expect(spawns).toBeLessThanOrEqual(6)
    expect(spawns).toBeGreaterThanOrEqual(2)
  }, 150_000)

  test("f2b: dev-mode app.exit stopRouter:true actually terminates the managed child", async () => {
    const dir = freshStateDir()
    const port = await freePort()
    const { localCredential: credStop } = await initState(dir, { port })
    const marker = join(dir, "marker-stop.txt")
    const pipePath = `\\\\.\\pipe\\gorouter-ctrl-test-${randomBytes(6).toString("hex")}`
    const h = spawnService(dir, {
      pipePath,
      routerCmdJson: [BUN, FAKE_ROUTER, "<port>", "--marker", marker, "--secret", credStop],
    })
    const client = await connectClient(h)
    const running = await client.waitSnapshot((s) => routerRunning(s), 20_000)
    const pid = running.router.pid
    expect(pid).toBeTruthy()

    // STATE-01 regression: the managed child must actually die on a full exit
    // (bun.exe resolved directly — the bun.cmd shim would orphan it)
    const exit = await client.request("app.exit", { stopRouter: true })
    expect(exit.ok, JSON.stringify(exit.error)).toBe(true)
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline && isAlive(pid!)) {
      await Bun.sleep(200)
    }
    expect(isAlive(pid!)).toBe(false)
    await Promise.race([h.proc.exited, Bun.sleep(8_000)])
    expect(h.proc.exitCode).not.toBeNull()
    // detach the handle so afterEach does not re-kill a settled service
    h.client = null
    const idx = services.indexOf(h)
    if (idx >= 0) services.splice(idx, 1)
  }, 60_000)

  test("m: service death with stopRouter:false recovers — a fresh service start brings routing back", async () => {
    const dir = freshStateDir()
    const port = await freePort()
    const { localCredential: credRecover } = await initState(dir, { port })
    const marker = join(dir, "marker-recover.txt")
    const pipePath = `\\\\.\\pipe\\gorouter-ctrl-test-${randomBytes(6).toString("hex")}`
    const h = spawnService(dir, {
      pipePath,
      routerCmdJson: [BUN, FAKE_ROUTER, "<port>", "--marker", marker, "--secret", credRecover],
    })
    const client = await connectClient(h)
    await client.waitSnapshot((s) => s.router.state === "running", 20_000)

    // stopRouter:false: the service exits. On Windows the managed child is
    // terminated with it (Bun job object KILL_ON_JOB_CLOSE) — the recovery
    // contract is that a fresh service start restores routing on the port.
    const exit = await client.request("app.exit", { stopRouter: false })
    expect(exit.ok, JSON.stringify(exit.error)).toBe(true)
    h.client = null
    const exited = await Promise.race([
      h.proc.exited.then(() => true),
      Bun.sleep(8_000).then(() => false),
    ])
    expect(exited, "control service must exit after app.exit").toBe(true)
    expect(h.proc.exitCode).not.toBeNull()

    // fresh service on the same pipe + state dir
    const h2 = spawnService(dir, {
      pipePath,
      routerCmdJson: [BUN, FAKE_ROUTER, "<port>", "--marker", marker, "--secret", credRecover],
    })
    const client2 = await connectClient(h2)
    const running2 = await client2.waitSnapshot((s) => s.router.state === "running", 20_000)
    expect(running2.router.state).toBe("running")
    // routing is back on the configured port. The supervisor may first
    // adopt a lingering old child (attached/running) and then respawn its
    // own after the old child dies (job object) — wait for the durable
    // managed-running state rather than the transient adoption.
    await waitForHealthz(port)
    const recovered = await client2.waitSnapshot(
      (s) => s.router.state === "running" && s.router.mode === "managed",
      15_000,
    )
    expect(recovered.router.state).toBe("running")
    expect(recovered.router.mode).toBe("managed")
  }, 90_000)

  test("g: concurrent pipe-client + CLI mutations all commit (lost-update proof)", async () => {
    const dir = freshStateDir()
    const port = await freePort()
    await initState(dir, { port })
    const pipePath = `\\\\.\\pipe\\gorouter-ctrl-test-${randomBytes(6).toString("hex")}`
    const h = spawnService(dir, { pipePath, routerCmdJson: [BUN, FAKE_ROUTER, "<port>"] })
    const a = await connectClient(h)
    const b = new ControlClient(pipePath, readAdminToken(dir))
    await b.connect(10_000)
    const alphaId = a.latest!.accounts.find((x) => x.alias === "alpha")!.id

    // three independent writers race: two pipe clients + one CLI subprocess
    const [ra, rb, cliRes] = await Promise.all([
      a.request("route.set", { lane: "go", accountId: alphaId }),
      b.request("account.add", { alias: "beta", secret: "sk-race-beta-0123456789" }),
      runCli(dir, ["route", "zen", "alpha"]),
    ])
    expect(ra.ok, JSON.stringify(ra.error)).toBe(true)
    expect(rb.ok, JSON.stringify(rb.error)).toBe(true)
    expect(cliRes.status, cliRes.stderr).toBe(0)

    // every operation must be present in the GUI snapshot...
    const snap = await a.waitSnapshot(
      (s) =>
        s.accounts.some((x) => x.alias === "beta") &&
        s.routes.go.alias === "alpha" &&
        s.routes.zen.alias === "alpha",
      8_000,
    )
    expect(snap.routes.go.alias).toBe("alpha")
    expect(snap.routes.zen.alias).toBe("alpha")
    expect(snap.accounts.some((x) => x.alias === "beta")).toBe(true)

    // ...and in CLI-observable state
    const status = await runCli(dir, ["status"])
    expect(status.stdout).toContain("GO  -> alpha")
    expect(status.stdout).toContain("ZEN -> alpha")
    const list = await runCli(dir, ["account", "list"])
    expect(list.stdout).toContain("beta")
    b.close()
  }, 90_000)

  test("h: corrupted journal degrades journal.recent but routing keeps working", async () => {
    const dir = freshStateDir()
    const port = await freePort()
    const upstream = await startMockUpstream()
    servers.push({ stop: () => upstream.stop() })
    const secret = "sk-coherence-degraded-0123456789"
    const { localCredential } = await initState(dir, {
      port,
      upstream: upstream.baseUrl,
      accountSecret: secret,
      routeGo: true,
    })
    const pipePath = `\\\\.\\pipe\\gorouter-ctrl-test-${randomBytes(6).toString("hex")}`
    const h = spawnService(dir, {
      pipePath,
      routerCmdJson: [BUN, join(REPO_ROOT, "src", "cli.ts"), "serve"],
    })
    const client = await connectClient(h)
    await client.waitSnapshot((s) => routerRunning(s) && s.router.port === port, 20_000)

    // corrupt the journal while the router is running
    writeFileSync(join(dir, "journal.db"), Buffer.from(`GARBAGE-not-a-sqlite-db-${randomBytes(64).toString("hex")}`))

    // journal.recent must degrade gracefully (never block or error)
    const jr = await client.request("journal.recent", { limit: 200 })
    expect(jr.ok, JSON.stringify(jr.error)).toBe(true)
    const data = jr.data as { rows: unknown[]; degraded: boolean; error: string | null }
    expect(data.degraded).toBe(true)
    expect(data.rows).toEqual([])
    expect(typeof data.error).toBe("string")
    // the pushed snapshots reflect the degraded journal as well
    await client.waitSnapshot((s) => s.journal.degraded === true, 5_000)

    // routing still works: a proxied request and healthz both answer
    const res = await fetch(`http://127.0.0.1:${port}/go/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${localCredential}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "still-routing" }] }),
    })
    expect(res.status).toBe(200)
    const hz = await fetch(`http://127.0.0.1:${port}/healthz`)
    expect(hz.status).toBe(200)
    expect(((await hz.json()) as { status: string }).status).toBe("ok")
  }, 120_000)

  test("f2: router.start resumes supervision after backoff exhaustion (failed)", async () => {
    const dir = freshStateDir()
    const port = await freePort()
    await initState(dir, { port })
    const marker = join(dir, "marker-crash2.txt")
    const pipePath = `\\\\.\\pipe\\gorouter-ctrl-test-${randomBytes(6).toString("hex")}`
    const h = spawnService(dir, {
      pipePath,
      routerCmdJson: [BUN, FAKE_ROUTER, "<port>", "--die-after-ms", "400", "--marker", marker],
    })
    const client = await connectClient(h)
    await client.waitSnapshot((s) => s.router.state === "failed", 45_000)

    // the manual Start action must recover from failed (PS-01)
    const started = await client.request("router.start")
    expect(started.ok, JSON.stringify(started.error)).toBe(true)
    await client.waitSnapshot((s) => s.router.state !== "failed", 10_000)
    const spawnsAfter = readFileSync(marker, "utf8").trim().split("\n").filter((l) => l.length > 0).length
    expect(spawnsAfter).toBeGreaterThanOrEqual(2) // a fresh attempt was made
  }, 120_000)

  test("i: CLI-side port change recycles the managed router onto the new port", async () => {
    const dir = freshStateDir()
    const portA = await freePort()
    const { localCredential: credPort } = await initState(dir, { port: portA })
    const marker = join(dir, "marker-port.txt")
    const pipePath = `\\\\.\\pipe\\gorouter-ctrl-test-${randomBytes(6).toString("hex")}`
    const h = spawnService(dir, {
      pipePath,
      routerCmdJson: [BUN, FAKE_ROUTER, "<port>", "--marker", marker, "--secret", credPort],
    })
    const client = await connectClient(h)
    await client.waitSnapshot((s) => routerRunning(s) && s.router.port === portA, 20_000)

    // CLI mutates the port while the managed router is running (INV-04)
    const portB = await freePort()
    const set = await runCli(dir, ["config", "set", "port", String(portB)])
    expect(set.status, set.stderr).toBe(0)

    // within the grace window + backoff, the child is recycled onto port B
    await waitForHealthz(portB, 40_000)
    await client.waitSnapshot((s) => routerRunning(s) && s.router.port === portB, 10_000)
  }, 120_000)

  test("j: first-run onboarding persists across a control-service restart", async () => {
    const dir = freshStateDir()
    const port = await freePort()
    // deliberately NOT initState: a genuinely fresh state dir (state.json
    // must not exist before the first service start, or the state is adopted)
    const pipePath = `\\\\.\\pipe\\gorouter-ctrl-test-${randomBytes(6).toString("hex")}`
    const h = spawnService(dir, { pipePath, routerCmdJson: [BUN, FAKE_ROUTER, "<port>"] })
    const client = await connectClient(h)
    await client.waitSnapshot((s) => s.firstRun === true, 10_000)
    // router stays stopped while onboarding is pending
    expect(client.latest!.router.state).toBe("stopped")
    // move the (not-yet-started) supervisor onto a free port via the channel
    const setPort = await client.request("config.set", { key: "port", value: String(port) })
    expect(setPort.ok, JSON.stringify(setPort.error)).toBe(true)

    // localCred.once armed once, then consumed
    const once = await client.request("localCred.once")
    expect(once.ok, JSON.stringify(once.error)).toBe(true)
    const oncePayload = once.data as Record<string, unknown> | null
    expect(typeof oncePayload?.credential === "string" && LOCAL_KEY_RE.test(oncePayload.credential)).toBe(true)
    const again = await client.request("localCred.once")
    expect(again.ok).toBe(false)

    // restart the service: firstRun must survive (PS-05)
    await stopService(h)
    const h2 = spawnService(dir, { pipePath, routerCmdJson: [BUN, FAKE_ROUTER, "<port>"] })
    const client2 = await connectClient(h2)
    await client2.waitSnapshot((s) => s.firstRun === true, 10_000)
    const once2 = await client2.request("localCred.once")
    expect(once2.ok, JSON.stringify(once2.error)).toBe(true)

    // completing onboarding flips firstRun off permanently and un-arms the once
    const done = await client2.request("desktop.set", { firstRunDone: true })
    expect(done.ok, JSON.stringify(done.error)).toBe(true)
    await client2.waitSnapshot((s) => s.firstRun === false, 5_000)
    const once3 = await client2.request("localCred.once")
    expect(once3.ok).toBe(false)
  }, 120_000)

  test("k: adopted state with a missing local-credential blob is not silently rotated", async () => {
    const dir = freshStateDir()
    const port = await freePort()
    const { localCredential } = await initState(dir, { port })
    // delete the local credential blob while state.json still references it
    const stateBefore = JSON.parse(readFileSync(join(dir, "state.json"), "utf8")) as { localCredentialRef: string | null }
    expect(stateBefore.localCredentialRef).toBeTruthy()
    const blob = join(dir, "secrets", `${stateBefore.localCredentialRef}.bin`)
    rmSync(blob, { force: true })

    const pipePath = `\\\\.\\pipe\\gorouter-ctrl-test-${randomBytes(6).toString("hex")}`
    const h = spawnService(dir, { pipePath, routerCmdJson: [BUN, FAKE_ROUTER, "<port>"] })
    const client = await connectClient(h)
    await client.waitSnapshot((s) => s.initialized === true, 10_000)

    // INV-07: no silent rotation — the ref is unchanged and the GUI sees the
    // unavailable state (CLI `setup` is the documented repair path)
    const stateAfter = JSON.parse(readFileSync(join(dir, "state.json"), "utf8")) as { localCredentialRef: string | null }
    expect(stateAfter.localCredentialRef).toBe(stateBefore.localCredentialRef)
    const snap = await client.snapshot()
    expect(snap.localCredentialConfigured).toBe(false)
    expect(snap.firstRun).toBe(false) // adopted state never arms onboarding
    void localCredential
  }, 90_000)
})
