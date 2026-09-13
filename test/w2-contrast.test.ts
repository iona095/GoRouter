/**
 * C06 W2 — mechanical light/dark contrast audit of the shipped design tokens
 * (contract §10.1, §10.5 and §16.33, §16.50).
 *
 * The tokens are parsed out of the production stylesheet bytes, so this cannot
 * drift from what the browser actually renders.
 */
import { test, expect, describe } from 'bun:test'
import { assetMap } from '../src/desktop/web-assets.ts'

const CSS = assetMap()['/assets/app.css']!.body

function parseTokens(block: string): Record<string, string> {
  const out: Record<string, string> = {}
  const re = /--([a-z0-9-]+):\s*([^;]+);/g
  let m: RegExpExecArray | null
  while ((m = re.exec(block)) !== null) out[m[1] as string] = (m[2] as string).trim()
  return out
}

const rootStart = CSS.indexOf(':root {')
const LIGHT = parseTokens(CSS.slice(rootStart, CSS.indexOf('}', rootStart)))
const darkStart = CSS.indexOf('@media (prefers-color-scheme: dark)')
const DARK = { ...LIGHT, ...parseTokens(CSS.slice(darkStart, CSS.indexOf('*, *::before'))) }

function luminance(hex: string): number {
  const h = hex.replace('#', '')
  const chan = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)))
  return 0.2126 * (chan[0] as number) + 0.7152 * (chan[1] as number) + 0.0722 * (chan[2] as number)
}

function ratio(a: string, b: string): number {
  const la = luminance(a)
  const lb = luminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/** Foreground/background pairs that render ordinary body text. */
const TEXT_PAIRS: [string, string][] = [
  ['fg', 'surface'], ['fg', 'bg'], ['fg', 'surface-2'],
  ['fg-muted', 'surface'], ['fg-muted', 'bg'], ['fg-muted', 'surface-2'],
  ['accent-fg', 'accent-bg'], ['accent-fg', 'accent-bg-hover'],
  ['danger-fg', 'danger-bg'], ['danger-fg', 'danger-bg-hover'],
  ['ok-fg', 'surface'], ['ok-fg', 'bg'],
  ['warn-fg', 'surface'], ['warn-fg', 'bg'],
  ['info-fg', 'surface'], ['info-fg', 'bg'],
  ['danger-bg', 'surface'], ['danger-bg', 'bg'],
  ['disabled-fg', 'disabled-bg'],
]

/** Control boundaries, focus rings and non-text status graphics. */
const UI_PAIRS: [string, string][] = [
  ['border', 'surface'], ['border', 'bg'], ['border', 'surface-2'], ['border', 'disabled-bg'],
  ['border-strong', 'surface'], ['border-strong', 'bg'], ['border-strong', 'surface-2'], ['border-strong', 'disabled-bg'],
  ['focus', 'surface'], ['focus', 'bg'], ['focus', 'surface-2'],
  ['accent-bg', 'surface'], ['accent-bg', 'bg'],
  ['ok-fg', 'surface'], ['warn-fg', 'surface'], ['info-fg', 'surface'],
]

describe('C06 §10.5 token contrast', () => {
  test('every token used by a pair is a 6-digit hex value', () => {
    const names = new Set<string>()
    for (const [a, b] of [...TEXT_PAIRS, ...UI_PAIRS]) { names.add(a); names.add(b) }
    for (const n of names) {
      expect(LIGHT[n]).toMatch(/^#[0-9a-f]{6}$/)
      expect(DARK[n]).toMatch(/^#[0-9a-f]{6}$/)
    }
  })

  for (const scheme of ['light', 'dark'] as const) {
    const tokens = scheme === 'light' ? LIGHT : DARK
    test(scheme + ': ordinary text meets 4.5:1', () => {
      const bad: string[] = []
      for (const [a, b] of TEXT_PAIRS) {
        const r = ratio(tokens[a] as string, tokens[b] as string)
        if (r < 4.5) bad.push(a + '/' + b + '=' + r.toFixed(2))
      }
      expect(bad).toEqual([])
    })

    test(scheme + ': control boundaries, focus and status graphics meet 3:1', () => {
      const bad: string[] = []
      for (const [a, b] of UI_PAIRS) {
        const r = ratio(tokens[a] as string, tokens[b] as string)
        if (r < 3) bad.push(a + '/' + b + '=' + r.toFixed(2))
      }
      expect(bad).toEqual([])
    })

    test(scheme + ': disabled controls stay distinguishable from enabled ones', () => {
      expect(tokens['disabled-bg']).not.toBe(tokens['surface-2'])
      expect(ratio(tokens['disabled-fg'] as string, tokens['fg'] as string)).toBeGreaterThan(1.2)
    })
  }

  test('status is never carried by colour alone', () => {
    const JS = assetMap()['/assets/app.js']!.body
    // Every status chip carries its own words, and route state is stated in text.
    expect(JS.indexOf("'Credential: Stored'")).not.toBe(-1)
    expect(JS.indexOf("'Credential: Missing'")).not.toBe(-1)
    expect(JS.indexOf("'Credential missing'")).not.toBe(-1)
    expect(JS.indexOf("'Route state: account selected'")).not.toBe(-1)
    expect(JS.indexOf("'Route state: no account selected'")).not.toBe(-1)
    expect(JS.indexOf("'Lane use: none'")).not.toBe(-1)
    // Disabled state is always accompanied by an explanatory sentence.
    expect(JS.indexOf("'Clear the ' + inUse + ' route before removing this account.'")).not.toBe(-1)
    expect(JS.indexOf("'Add an account with a stored credential before selecting this lane.'")).not.toBe(-1)
  })
})
