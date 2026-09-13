/**
 * C06 W2 — static assertions on the finished browser assets
 * (contract §§2.1, 2.3, 8, 9, 13 and §16.2-§16.4, §16.13-§16.24, §16.35-§16.37,
 * §16.43, §16.47, §16.59, §16.60, §16.65, §16.68, §16.71).
 *
 * These read the exact production asset bytes the browser is served.
 */
import { test, expect, describe } from 'bun:test'
import { assetMap } from '../src/desktop/web-assets.ts'
import { ALIAS_RE, validateAlias } from '../src/state.ts'

const JS = assetMap()['/assets/app.js']!.body
const CSS = assetMap()['/assets/app.css']!.body

describe('C06 W2 browser asset — persistence and background work', () => {
  test('no browser persistence API is referenced', () => {
    for (const token of [
      'localStorage', 'sessionStorage', 'IndexedDB', 'indexedDB', 'openDatabase',
      'caches', 'CacheStorage', 'document.cookie', 'cookieStore',
    ]) {
      expect(JS.indexOf(token)).toBe(-1)
    }
  })

  test('no service worker, socket, stream or background scheduler', () => {
    for (const token of [
      'serviceWorker', 'ServiceWorker', 'WebSocket', 'EventSource', 'SharedWorker',
      'new Worker', 'setInterval', 'requestIdleCallback', 'navigator.sendBeacon',
    ]) {
      expect(JS.indexOf(token)).toBe(-1)
    }
  })

  test('no timer-driven retry or poll loop exists', () => {
    expect(JS.indexOf('setTimeout')).toBe(-1)
    expect(JS.indexOf('setInterval')).toBe(-1)
    // No request helper is ever re-invoked from a settled-failure handler.
    expect(/catch[\s\S]{0,200}request\(/.test(JS)).toBe(false)
  })

  test('no source map is published', () => {
    for (const token of ['sourceMappingURL', 'sourceMap']) {
      expect(JS.indexOf(token)).toBe(-1)
      expect(CSS.indexOf(token)).toBe(-1)
    }
  })
})

describe('C06 W2 browser asset — DOM and XSS sinks', () => {
  test('no markup or code-execution sink is used', () => {
    for (const sink of [
      'innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write',
      'new Function', 'setHTMLUnsafe', 'srcdoc',
    ]) {
      expect(JS.indexOf(sink)).toBe(-1)
    }
    expect(/[^A-Za-z]eval\s*\(/.test(JS)).toBe(false)
    expect(JS.indexOf('textContent')).not.toBe(-1)
    expect(JS.indexOf('createTextNode')).not.toBe(-1)
  })

  test('no inline event handler attribute is assigned', () => {
    expect(/setAttribute\(\s*['"]on[a-z]+['"]/.test(JS)).toBe(false)
    expect(/\.on(click|error|load|submit)\s*=/.test(JS)).toBe(false)
  })

  test('no runtime style injection and no inline style attribute', () => {
    expect(JS.indexOf("createElement('style')")).toBe(-1)
    expect(JS.indexOf('createElement("style")')).toBe(-1)
    expect(JS.indexOf('insertRule')).toBe(-1)
    expect(JS.indexOf('cssText')).toBe(-1)
    expect(/setAttribute\(\s*['"]style['"]/.test(JS)).toBe(false)
    expect(/\.style\./.test(JS)).toBe(false)
  })
})

describe('C06 W2 browser asset — request discipline', () => {
  test('only same-scope relative W1 API v1 paths are constructed', () => {
    expect(JS.indexOf('http://')).toBe(-1)
    expect(JS.indexOf('https://')).toBe(-1)
    const paths = (JS.match(/'\.\/api\/v1\/[a-z/]*'/g) ?? []).map((s) => s.slice(1, -1))
    expect([...new Set(paths)].sort()).toEqual([
      './api/v1/', './api/v1/bootstrap', './api/v1/logout', './api/v1/session', './api/v1/snapshot',
    ])
    for (const p of paths) expect(p.indexOf('?')).toBe(-1)
    // Mutation paths are appended to the same relative prefix.
    expect(JS.indexOf("'./api/v1/' + spec.path")).not.toBe(-1)
    const mutationPaths = (JS.match(/path: '(routes|accounts)\/[a-z]+'/g) ?? [])
      .map((s) => s.slice("path: '".length, -1))
    expect([...new Set(mutationPaths)].sort()).toEqual([
      'accounts/add', 'accounts/remove', 'accounts/rename', 'accounts/update',
      'routes/clear', 'routes/set',
    ])
  })

  test('no alternate auth transport is constructed', () => {
    expect(JS.toLowerCase().indexOf('authorization')).toBe(-1)
    expect(JS.toLowerCase().indexOf('bearer')).toBe(-1)
    expect(JS.indexOf('URLSearchParams')).toBe(-1)
    expect(JS.indexOf('location.search')).toBe(-1)
    expect(JS.indexOf('location.hash')).toBe(-1)
    // The only header names the client ever sets.
    const headerNames = (JS.match(/headers\['[^']+'\]/g) ?? []).map((s) => s.slice(9, -2))
    expect([...new Set(headerNames)].sort()).toEqual(['Content-Type', 'x-gorouter-csrf'])
  })

  test('the CSRF capability header is the exact W1 header name', () => {
    expect(JS.indexOf("'x-gorouter-csrf'")).not.toBe(-1)
    expect(JS.indexOf("opts.withCsrf === true")).not.toBe(-1)
  })
})

describe('C06 W2 browser asset — authority surface', () => {
  test('no unauthorised control operation appears anywhere in the client', () => {
    for (const op of [
      'router.start', 'router.stop', 'router.restart', 'account.test', 'localCred',
      'app.exit', 'models', 'probe', 'settings.', 'config.', 'force', 'admin', 'pipe',
      'api/v1/router', 'api/v1/models', 'api/v1/settings', 'api/v1/config',
    ]) {
      expect(JS.indexOf(op)).toBe(-1)
    }
    // router.* appears only as the two read-only snapshot fields.
    const routerRefs = (JS.match(/router\.[a-zA-Z]+/g) ?? [])
    expect([...new Set(routerRefs)].sort()).toEqual(['router.mode', 'router.state'])
  })

  test('no unavailable-feature control is rendered', () => {
    for (const label of [
      'Start Router', 'Stop Router', 'Restart', 'Test Account', 'Refresh Models',
      'Settings', 'Force', 'Show API key', 'Copy credential', 'Quota', 'Usage',
    ]) {
      expect(JS.indexOf(label)).toBe(-1)
    }
  })

  test('no reveal-credential control exists', () => {
    expect(JS.indexOf('reveal')).toBe(-1)
    expect(JS.indexOf('Show password')).toBe(-1)
    expect(JS.indexOf('Show API key')).toBe(-1)
    // Four type assignments exist in total: two button kinds, one text field
    // builder and one password field builder. Nothing ever flips a password
    // input to text.
    const typeAssignments = (JS.match(/\.type = '[a-z]+'/g) ?? [])
    expect(typeAssignments.sort()).toEqual([
      ".type = 'button'", ".type = 'password'", ".type = 'submit'", ".type = 'text'",
    ])
  })

  test('no mutation-capable debug global is published', () => {
    const globals = JS.match(/window\.__[A-Za-z]+/g) ?? []
    expect([...new Set(globals)]).toEqual(['window.__gorouterBootstrap'])
    expect(JS.indexOf('__gorouterApi')).toBe(-1)
    expect(JS.indexOf('__gorouterRefresh')).toBe(-1)
  })

  test('no routine console instrumentation is shipped', () => {
    expect(JS.indexOf('console.')).toBe(-1)
    expect(JS.indexOf('debugger')).toBe(-1)
  })
})

describe('C06 W2 browser asset — secret handling', () => {
  test('the credential field is a password input with autofill discouraged', () => {
    expect(JS.indexOf("input.type = 'password'")).not.toBe(-1)
    expect(JS.indexOf("input.autocomplete = 'new-password'")).not.toBe(-1)
    expect(JS.indexOf("form.autocomplete = 'off'")).not.toBe(-1)
    expect(JS.indexOf('input.spellcheck = false')).not.toBe(-1)
    expect(JS.indexOf("'autocapitalize', 'off'")).not.toBe(-1)
  })

  test('secrets are scrubbed on every exit path', () => {
    expect(JS.indexOf('function scrubSecrets()')).not.toBe(-1)
    expect(JS.indexOf("querySelectorAll('input[type=password]')")).not.toBe(-1)
    expect(JS.indexOf("addEventListener('pagehide'")).not.toBe(-1)
    // scrubSecrets is reached from close, authority loss and logout.
    expect((JS.match(/scrubSecrets\(\)/g) ?? []).length).toBeGreaterThanOrEqual(4)
  })

  test('the serialised payload is released immediately after the request starts', () => {
    expect(JS.indexOf('secret = \'\';')).not.toBe(-1)
    expect(JS.indexOf('spec.payload = null;')).not.toBe(-1)
    expect(JS.indexOf('payload = null;')).not.toBe(-1)
  })
})

describe('C06 W2 browser asset — W0 concurrency semantics', () => {
  test('route set sends exactly the five reviewed fields', () => {
    const block = JS.slice(JS.indexOf('function submitRouteSet'), JS.indexOf('function submitRouteClear'))
    for (const f of ['stateGeneration', 'lane', 'accountId', 'expectedRouteVersion', 'expectedTargetAccountVersion']) {
      expect(block.indexOf(f + ':')).not.toBe(-1)
    }
    expect(block.indexOf('force')).toBe(-1)
    expect(block.indexOf('secret:')).toBe(-1)
    const body = block.slice(block.indexOf('JSON.stringify({'), block.indexOf('});'))
    expect((body.match(/^\s+[a-zA-Z]+:/gm) ?? []).length).toBe(5)
  })

  test('route clear sends exactly the three reviewed fields', () => {
    const block = JS.slice(JS.indexOf('function submitRouteClear'))
    const body = block.slice(block.indexOf('JSON.stringify({'), block.indexOf('});'))
    expect(body.indexOf('stateGeneration')).not.toBe(-1)
    expect(body.indexOf('lane')).not.toBe(-1)
    expect(body.indexOf('expectedRouteVersion')).not.toBe(-1)
    expect(body.indexOf('accountId')).toBe(-1)
  })

  test('account forms freeze the reviewed generation and version at open', () => {
    expect(JS.indexOf('gen: snapshot.stateGeneration')).not.toBe(-1)
    expect(JS.indexOf('accountVersion: spec.accountVersion')).not.toBe(-1)
    expect(JS.indexOf('stateGeneration: st.gen')).not.toBe(-1)
    expect(JS.indexOf('expectedAccountVersion: st.accountVersion')).not.toBe(-1)
  })

  test('committing a new snapshot invalidates an open form', () => {
    const block = JS.slice(JS.indexOf('function commitSnapshot'), JS.indexOf('function endAuthority'))
    expect(block.indexOf("closeDialog('refreshed')")).not.toBe(-1)
  })

  test('force removal is impossible from the browser', () => {
    expect(JS.toLowerCase().indexOf('force')).toBe(-1)
    const block = JS.slice(JS.indexOf('function openRemoveDialog'), JS.indexOf('function submitRouteSet'))
    expect(block.indexOf('usedBy.length > 0')).not.toBe(-1)
  })

  test('only one mutation may be in flight and nothing is queued', () => {
    const block = JS.slice(JS.indexOf('function sendMutation'), JS.indexOf('function settleMutation'))
    expect(block.indexOf('if (inFlight) return Promise.resolve();')).not.toBe(-1)
    expect(block.indexOf('if (!canMutate()) return Promise.resolve();')).not.toBe(-1)
    // No pending-request collection of any kind exists.
    expect(/pending(Requests|Queue|Mutations)/.test(JS)).toBe(false)
    expect(JS.indexOf('Promise.all')).toBe(-1)
    expect(JS.indexOf('Promise.race')).toBe(-1)
  })

  test('mutation controls require a valid capability and a reviewed snapshot', () => {
    const block = JS.slice(JS.indexOf('function canMutate'), JS.indexOf('// ---- snapshot read'))
    expect(block.indexOf('isValidCsrf(csrf)')).not.toBe(-1)
    expect(block.indexOf('snapshot !== null')).not.toBe(-1)
    expect(block.indexOf("phase === 'ready'")).not.toBe(-1)
    expect(block.indexOf('!mutationsLocked')).not.toBe(-1)
  })
})

describe('C06 W2 browser asset — validation mirrors the authoritative rule', () => {
  test('the client alias rule is the execution-time W0 rule', () => {
    expect(ALIAS_RE.source).toBe('^[A-Za-z0-9._-]{1,64}$')
    expect(JS.indexOf('var ALIAS_RE = /^[A-Za-z0-9._-]{1,64}$/;')).not.toBe(-1)
  })

  test('client and server agree on a representative sample', () => {
    const clientRe = /^[A-Za-z0-9._-]{1,64}$/
    const samples = [
      '', 'a', 'A.b_c-9', 'x'.repeat(64), 'x'.repeat(65), ' lead', 'trail ',
      'has space', 'sl/ash', 'co:lon', '<b>', 'quote"', 'dollar$', 'perc%',
    ]
    for (const s of samples) {
      expect(clientRe.test(s)).toBe(validateAlias(s) === null)
    }
  })

  test('the submitted alias is never trimmed or case-folded', () => {
    expect(JS.indexOf('.trim()')).toBe(-1)
    // toLowerCase appears only for display ordering and lane labels, never on a
    // value that is placed into a request payload.
    const payloadBlocks = JS.split('JSON.stringify({').slice(1)
    for (const b of payloadBlocks) {
      const body = b.slice(0, b.indexOf('})'))
      expect(body.indexOf('toLowerCase')).toBe(-1)
      expect(body.indexOf('trim')).toBe(-1)
    }
  })

  test('the capability shape check matches the W1 bootstrap/CSRF charset', () => {
    expect(JS.indexOf('var CSRF_RE = /^[A-Za-z0-9_-]{43,64}$/;')).not.toBe(-1)
  })
})

describe('C06 W2 stylesheet', () => {
  test('no remote asset, font or icon is referenced', () => {
    expect(CSS.indexOf('http://')).toBe(-1)
    expect(CSS.indexOf('https://')).toBe(-1)
    expect(CSS.indexOf('@import')).toBe(-1)
    expect(CSS.indexOf('url(')).toBe(-1)
    expect(CSS.indexOf('@font-face')).toBe(-1)
  })

  test('light and dark token sets are both declared', () => {
    expect(CSS.indexOf('color-scheme: light dark;')).not.toBe(-1)
    expect(CSS.indexOf('@media (prefers-color-scheme: dark)')).not.toBe(-1)
    for (const token of ['--bg', '--surface', '--fg', '--fg-muted', '--border', '--accent-bg', '--danger-bg', '--focus']) {
      const occurrences = (CSS.match(new RegExp('\\' + token + ':', 'g')) ?? []).length
      expect(occurrences).toBeGreaterThanOrEqual(2)
    }
  })

  test('motion is optional and reduced motion is honoured', () => {
    expect(CSS.indexOf('@media (prefers-reduced-motion: reduce)')).not.toBe(-1)
    expect(CSS.indexOf('transition-duration: 0ms !important;')).not.toBe(-1)
  })

  test('a visible focus indicator is defined', () => {
    expect(CSS.indexOf(':focus-visible')).not.toBe(-1)
    expect(CSS.indexOf('outline: 3px solid var(--focus)')).not.toBe(-1)
  })
})

describe('C06 W2 browser asset — resolvable references', () => {
  test('every bare function call resolves to a local declaration or an allowed global', () => {
    const KEYWORDS = new Set([
      'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'function',
      'new', 'else', 'do', 'try', 'throw', 'case', 'in', 'of', 'var',
    ])
    const GLOBALS = new Set([
      'fetch', 'String', 'Number', 'Boolean', 'Array', 'Object', 'JSON', 'Math',
      'Date', 'Intl', 'Promise', 'isFinite', 'isNaN', 'parseInt', 'parseFloat',
      'Error', 'RegExp', 'Set', 'Map', 'Symbol',
    ])
    // Strip line comments and string literals: only executable text is scanned.
    const CODE = JS
      .split('\n')
      .map((line) => {
        const i = line.indexOf('//')
        return i === -1 ? line : line.slice(0, i)
      })
      .join('\n')
      .replace(/'(?:[^'\\]|\\.)*'/g, "''")
      .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    const declared = new Set<string>()
    for (const m of JS.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(/g)) declared.add(m[1] as string)
    for (const m of JS.matchAll(/var\s+([A-Za-z_$][\w$]*)\s*=/g)) declared.add(m[1] as string)
    for (const m of JS.matchAll(/(?:var|function)?\s*([A-Za-z_$][\w$]*)\s*=\s*function\s*\(/g)) declared.add(m[1] as string)
    const unresolved = new Set<string>()
    for (const m of CODE.matchAll(/(^|[^.\w$'"])([a-z_$][\w$]*)\s*\(/gm)) {
      const name = m[2] as string
      if (KEYWORDS.has(name) || GLOBALS.has(name) || declared.has(name)) continue
      unresolved.add(name)
    }
    expect([...unresolved].sort()).toEqual([])
  })

  test('a settled local failure can never strand the in-flight flag', () => {
    const block = JS.slice(JS.indexOf('function sendMutation'), JS.indexOf('function settleMutation'))
    expect(block.indexOf('.then(null, function ()')).not.toBe(-1)
    expect(block.indexOf('inFlight = false;')).not.toBe(-1)
  })
})
