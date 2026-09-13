/**
 * GoRouter W2 — Web Control browser application composition (C06 §3.1).
 *
 * The finished browser app is assembled here from small UI-only source modules
 * and served as the single fixed `/assets/app.js` entry of the frozen W1 asset
 * map. There is no bundler, no package, no runtime dependency, no CDN, no
 * remote font/icon/image, and no published source map: `APP_JS_SOURCE` is a
 * compile-time constant string built by concatenation.
 *
 * All modules share one function scope, so the CSRF capability, the reviewed
 * snapshot and the in-flight flag exist only as closure variables of a single
 * IIFE and are never reachable from `window`.
 */
import { JS_CORE } from './core.ts'
import { JS_NET } from './net.ts'
import { JS_RENDER } from './render.ts'
import { JS_FORMS } from './forms.ts'
import { JS_BOOT } from './boot.ts'
import { APP_CSS_SOURCE } from './css.ts'

/** Finished W2 browser application (post-bootstrap presentation layer). */
export const APP_JS_SOURCE: string = [
  '"use strict";',
  '(function () {',
  JS_CORE,
  JS_NET,
  JS_RENDER,
  JS_FORMS,
  JS_BOOT,
  '})();',
  '',
].join('\n')

/** Finished W2 stylesheet. */
export const APP_CSS_BUNDLE: string = APP_CSS_SOURCE
