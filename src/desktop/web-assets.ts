/**
 * GoRouter Web Control assets (W1 frozen boundary + W2 presentation layer).
 *
 * W1 security properties (C05 §6.4/§8.5/§8.6) are FROZEN and unchanged by W2:
 * - GET / returns HTML with ZERO pre-cleanup external asset references; the sole
 *   pre-cleanup executable content is BOOTSTRAP_SHIM_JS, authorized by the exact
 *   CSP sha256 hash emitted in the Content-Security-Policy header.
 * - The shim copies location.hash -> memory, calls history.replaceState cleanup,
 *   and only then injects the same-origin app.js/app.css and lets app.js POST.
 * - BOOTSTRAP_SHIM_JS, renderIndexHtml(), bootstrapDocumentCsp() and strictCsp()
 *   are byte-frozen; C06 verification re-evaluates all four for exact equality.
 *
 * W2 (C06) replaces only the post-bootstrap presentation/application layer. The
 * finished client still uses text-safe DOM sinks only and touches no browser
 * persistence, no service worker, no source maps and no remote/CDN content, and
 * the fixed two-entry asset map below is unchanged, so no new browser route,
 * capability or authority exists.
 */
import { createHash } from 'node:crypto'
import { APP_JS_SOURCE, APP_CSS_BUNDLE } from './web-ui/index.ts'

/** Exact inline bootstrap shim bytes (the ONLY pre-cleanup executable content). */
export const BOOTSTRAP_SHIM_JS =
  '(function(){try{var m=/^#bootstrap=([A-Za-z0-9_-]{43,64})$/.exec(location.hash||"");' +
  'window.__gorouterBootstrap=m?m[1]:null;}catch(e){window.__gorouterBootstrap=null;}' +
  'try{history.replaceState(null,"",location.pathname+location.search);}catch(e){}' +
  'var l=document.createElement("link");l.rel="stylesheet";l.href="./assets/app.css";' +
  'document.head.appendChild(l);' +
  'var s=document.createElement("script");s.src="./assets/app.js";document.head.appendChild(s);})();'

/** Base64 sha256 of the exact shim bytes (CSP authorizer). */
export const BOOTSTRAP_SHIM_SHA256_BASE64: string = createHash('sha256')
  .update(BOOTSTRAP_SHIM_JS, 'utf8')
  .digest('base64')

/** Full CSP header value for the bootstrap document (no unsafe-inline, no remotes). */
export function bootstrapDocumentCsp(): string {
  return (
    "default-src 'self'; " +
    "script-src 'self' 'sha256-" + BOOTSTRAP_SHIM_SHA256_BASE64 + "'; " +
    "style-src 'self'; " +
    "connect-src 'self'; " +
    "object-src 'none'; " +
    "base-uri 'none'; " +
    "frame-ancestors 'none'; " +
    "form-action 'self'"
  )
}

/** CSP header value for same-origin assets/API (no inline at all). */
export function strictCsp(): string {
  return (
    "default-src 'self'; " +
    "script-src 'self'; " +
    "style-src 'self'; " +
    "connect-src 'self'; " +
    "object-src 'none'; " +
    "base-uri 'none'; " +
    "frame-ancestors 'none'; " +
    "form-action 'self'"
  )
}

/** Minimal proving document: no link/script/img/asset tags before the shim. */
export function renderIndexHtml(): string {
  return (
    '<!doctype html>\n' +
    '<html lang="en">\n' +
    '<head>\n' +
    '<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    '<title>GoRouter Web Control</title>\n' +
    '</head>\n' +
    '<body>\n' +
    '<div id="app"><p>Loading GoRouter Web Control\u2026</p></div>\n' +
    '<script>' + BOOTSTRAP_SHIM_JS + '</scr' + 'ipt>\n' +
    '</body>\n' +
    '</html>\n'
  )
}

/**
 * Finished W2 browser application (C06 §§3.1, 4-13).
 *
 * The post-bootstrap presentation/application layer is composed from the UI-only
 * modules beneath ./web-ui/ and served verbatim as the two fixed asset entries
 * below. The bootstrap shim, the pre-cleanup index document and both CSP values
 * above are the frozen W1 security boundary and are unchanged by W2.
 */
export const APP_JS: string = APP_JS_SOURCE

export const APP_CSS: string = APP_CSS_BUNDLE

/** Fixed asset map: the ONLY static files served beneath the live scope. */
export function assetMap(): Record<string, { contentType: string; body: string }> {
  return {
    '/assets/app.js': { contentType: 'text/javascript; charset=utf-8', body: APP_JS },
    '/assets/app.css': { contentType: 'text/css; charset=utf-8', body: APP_CSS },
  }
}
