/**
 * GoRouter V1.5 — fake router for desktop control-service tests (shared
 * between slice B and slice E).
 *
 * Usage: bun test/fake-router.ts <port> [--die-after-ms N] [--marker <file>]
 *   - serves 127.0.0.1:<port>
 *   - GET /healthz -> {"status":"ok","version":"1.0.0-fake"}
 *   - any other path -> 404
 *   - --die-after-ms N: exits with code 1 after N ms (crash simulation)
 *   - --marker <file>: appends one line per process start (spawn-count proof)
 * Writes nothing except the marker file when requested.
 */
import { appendFileSync } from 'node:fs'

const port = Number(Bun.argv[2] ?? NaN)
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  console.error('usage: bun test/fake-router.ts <port> [--die-after-ms N] [--marker <file>]')
  process.exit(2)
}

let dieAfterMs = 0
let marker: string | null = null
const rest = Bun.argv.slice(3)
for (let i = 0; i < rest.length; i++) {
  const arg = rest[i]
  if (arg === '--die-after-ms') {
    dieAfterMs = Number(rest[i + 1] ?? 0)
    i++
  } else if (arg === '--marker') {
    marker = rest[i + 1] ?? null
    i++
  }
}

if (marker) {
  try {
    appendFileSync(marker, `start ${process.pid} ${new Date().toISOString()}\n`)
  } catch {
    /* marker is best-effort */
  }
}

Bun.serve({
  hostname: '127.0.0.1',
  port,
  fetch: (req) => {
    const url = new URL(req.url)
    if (url.pathname === '/healthz') {
      return Response.json({ status: 'ok', version: '1.0.0-fake' })
    }
    return new Response('not found', { status: 404 })
  },
})

if (dieAfterMs > 0) {
  setTimeout(() => process.exit(1), dieAfterMs)
}
