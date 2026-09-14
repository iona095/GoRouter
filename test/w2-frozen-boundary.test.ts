/**
 * C06 W2 — pure-presentation byte boundary (contract §3.4, §16.1-§16.5, §19.3).
 *
 * W2 is a presentation layer over the frozen W1 API v1. These tests fail closed
 * if any protected W0/W1/package byte changed, if either CSP output or the
 * pre-cleanup index document drifted, or if the browser surface gained a route,
 * an asset entry or an operation that W1 did not already expose.
 */
import { test, expect, describe } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  BOOTSTRAP_SHIM_JS,
  BOOTSTRAP_SHIM_SHA256_BASE64,
  bootstrapDocumentCsp,
  strictCsp,
  renderIndexHtml,
  assetMap,
} from '../src/desktop/web-assets.ts'

const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex')
const fileSha = (rel: string): string =>
  createHash('sha256').update(readFileSync(fileURLToPath(new URL('../' + rel, import.meta.url)))).digest('hex')
const fileText = (rel: string): string =>
  readFileSync(fileURLToPath(new URL('../' + rel, import.meta.url)), 'utf8')

/** Pre-W2 baseline captured before the first C06 edit (C06 baseline manifest). */
const FROZEN_OUTPUTS = {
  BOOTSTRAP_SHIM_JS: '396aeec58dc06a75afe2436bcb2fe796553a02fc0206faf2cccc4c1765c74921',
  bootstrapDocumentCsp: 'b7b7acab3a4d6bf4d15c17d415bbe2790d31c51b96e8ff16ffdeeabb4fcdc5df',
  strictCsp: '11fb0d301c09c757da272728ce597d855eda5efd85da6df35429970e97592b26',
  renderIndexHtml: '4875b2bd82a3b4b58ac2f9a0d553d8b4b0f408c0cfcbce9af4ebe4ae0160bd39',
}

const PROTECTED_FILES: Record<string, string> = {
  'src/desktop/web-bridge.ts': '0e7124571e1c198cf643c0fa76d2e7a5c4b9222ec4920af2435b2059fdc86fe6',
  'src/desktop/web-launch.ts': 'f70c5139e74bf3b18f92839618cb62921dd0c0fdbcea0596b6ac883c4e5fb7e9',
  'src/desktop/control-service.ts': 'c93a2723d69f564ac256d3309733ba0dfc1b312ae01262275c74291bcd9466f4',
  'src/desktop/control-core.ts': '1cc38cb5aa1290b0d3c2d77c5ae52e14c1a0bbcd3222124e1501267f2d93cc09',
  'src/desktop/protocol.ts': '44885141af183aa8490abdc5a84770585ede034e4b9de403d68cd0b179d38db5',
  'src/domain.ts': '4e7d8222f2a43b2196af7eee178cdcb965c77d21d887f0b6847c4a4988660d55',
  'src/state.ts': '7af62441746eef1a9f669a578dd1689f9d7972bce4438e484cea4dd02c4b3624',
  'package.json': '6f93f2c147bb8c31d05588ffc07525e3c044aae86d67333e3dc42cdc8c06a8f2',
  'bun.lock': '9edd3609efeb65bc95bf81451e22ba29d6777acc7a88d80bbb522071305da596',
  'tsconfig.json': '404cea2e67e7c82a836748d7ccd8697bf81f8a62daaf8b932460b9d9f7ae3f6c',
}

describe('C06 §3.4 pure-presentation byte boundary', () => {
  test('W1: the four frozen asset outputs are byte-identical', () => {
    expect(sha(BOOTSTRAP_SHIM_JS)).toBe(FROZEN_OUTPUTS.BOOTSTRAP_SHIM_JS)
    expect(sha(bootstrapDocumentCsp())).toBe(FROZEN_OUTPUTS.bootstrapDocumentCsp)
    expect(sha(strictCsp())).toBe(FROZEN_OUTPUTS.strictCsp)
    expect(sha(renderIndexHtml())).toBe(FROZEN_OUTPUTS.renderIndexHtml)
  })

  test('W1: the CSP hash still authorises the exact shim bytes', () => {
    const expected = createHash('sha256').update(BOOTSTRAP_SHIM_JS, 'utf8').digest('base64')
    expect(BOOTSTRAP_SHIM_SHA256_BASE64).toBe(expected)
    expect(bootstrapDocumentCsp().indexOf("'sha256-" + expected + "'")).not.toBe(-1)
  })

  test('W0/W1/package protected files are byte-identical', () => {
    const bad: string[] = []
    for (const [rel, want] of Object.entries(PROTECTED_FILES)) {
      const got = fileSha(rel)
      if (got !== want) bad.push(rel + ' ' + got)
    }
    expect(bad).toEqual([])
  })

  test('W2 adds no static asset entry and no API route', () => {
    const map = assetMap()
    expect(Object.keys(map).sort()).toEqual(['/assets/app.css', '/assets/app.js'])
    expect(map['/assets/app.js']!.contentType).toBe('text/javascript; charset=utf-8')
    expect(map['/assets/app.css']!.contentType).toBe('text/css; charset=utf-8')
    // The bridge's asset arm is a fixed two-path comparison; adding a third
    // entry would be unreachable without editing a protected file.
    const bridge = fileText('src/desktop/web-bridge.ts')
    expect(bridge.indexOf("rest === 'assets/app.js' || rest === 'assets/app.css'")).not.toBe(-1)
  })

  test('W1 browser endpoint set is unchanged', () => {
    const bridge = fileText('src/desktop/web-bridge.ts')
    const routes = (bridge.match(/rest === 'api\/v1\/[a-z/]+'/g) ?? [])
      .map((s) => s.slice("rest === '".length, -1))
    expect([...new Set(routes)].sort()).toEqual([
      'api/v1/accounts/add',
      'api/v1/accounts/remove',
      'api/v1/accounts/rename',
      'api/v1/accounts/update',
      'api/v1/bootstrap',
      'api/v1/logout',
      'api/v1/routes/clear',
      'api/v1/routes/set',
      'api/v1/session',
      'api/v1/snapshot',
    ])
  })

  test('the pre-cleanup index document still fetches nothing before cleanup', () => {
    const html = renderIndexHtml()
    for (const token of ['<script src', '<link', '<img', 'fetch(', 'XMLHttpRequest', 'sendBeacon']) {
      expect(html.indexOf(token)).toBe(-1)
    }
    const cleanupAt = html.indexOf('history.replaceState')
    expect(cleanupAt).not.toBe(-1)
    expect(cleanupAt < html.indexOf('app.js')).toBe(true)
    expect(html.indexOf('http://')).toBe(-1)
    expect(html.indexOf('https://')).toBe(-1)
  })

  test('the bootstrap handoff global is the only W1 global the app may touch', () => {
    expect(BOOTSTRAP_SHIM_JS.indexOf('window.__gorouterBootstrap')).not.toBe(-1)
    const js = assetMap()['/assets/app.js']!.body
    const globals = js.match(/window\.__gorouter[A-Za-z]*/g) ?? []
    expect([...new Set(globals)]).toEqual(['window.__gorouterBootstrap'])
  })
})
