/**
 * GoRouter V1.5 — desktop settings (<state>/desktop.json, runtime, outside
 * the repo). Shell-facing preferences only; the shell owns the HKCU Run
 * start-at-login entry, the service records the desired state here.
 *
 * Tolerant parse: a corrupt/missing file reads as defaults (all false/null),
 * writes are atomic (util.atomicWriteJson).
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteJson } from '../util.ts'

export const DESKTOP_SETTINGS_SCHEMA_VERSION = 1
export const DESKTOP_SETTINGS_FILE = 'desktop.json'

export interface DesktopSettingsFile {
  schemaVersion: number
  startAtLogin: boolean
  minimizeToTray: boolean
  /** Shell color theme. Absent/unknown reads as light (no surprise re-skin). */
  theme: 'light' | 'dark'
  firstRunDoneAtUtc: string | null
  /** Set when the service created the runtime state (fresh state marker);
   * adopted V1 state never has it. Drives persistent first-run arming. */
  freshStateCreatedAtUtc: string | null
}

export interface DesktopSettings {
  read(): DesktopSettingsFile
  write(file: DesktopSettingsFile): void
  /** True when the file exists but could not be parsed (corrupt). */
  corrupt(): boolean
}

export function loadDesktopSettings(stateDir: string): DesktopSettings {
  const file = join(stateDir, DESKTOP_SETTINGS_FILE)
  let corrupt = false
  // last-good cache: a corrupt overwrite must not lose persisted fields
  // (e.g. the fresh-state marker) — STATE-03
  let lastGood: DesktopSettingsFile | null = null

  function read(): DesktopSettingsFile {
    const defaults: DesktopSettingsFile = {
      schemaVersion: DESKTOP_SETTINGS_SCHEMA_VERSION,
      startAtLogin: false,
      minimizeToTray: false,
      theme: 'light',
      firstRunDoneAtUtc: null,
      freshStateCreatedAtUtc: null,
    }
    if (!existsSync(file)) {
      corrupt = false
      return { ...defaults }
    }
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      corrupt = true
      return lastGood !== null ? { ...lastGood } : { ...defaults }
    }
    if (typeof raw !== 'object' || raw === null) {
      corrupt = true
      return lastGood !== null ? { ...lastGood } : { ...defaults }
    }
    const parsed = raw as Record<string, unknown>
    const next: DesktopSettingsFile = {
      schemaVersion: DESKTOP_SETTINGS_SCHEMA_VERSION,
      startAtLogin: typeof parsed.startAtLogin === 'boolean' ? parsed.startAtLogin : false,
      minimizeToTray: typeof parsed.minimizeToTray === 'boolean' ? parsed.minimizeToTray : false,
      theme: parsed.theme === 'dark' ? 'dark' : 'light',
      firstRunDoneAtUtc: typeof parsed.firstRunDoneAtUtc === 'string' ? parsed.firstRunDoneAtUtc : null,
      freshStateCreatedAtUtc: typeof parsed.freshStateCreatedAtUtc === 'string' ? parsed.freshStateCreatedAtUtc : null,
    }
    corrupt = false
    lastGood = { ...next }
    return next
  }

  function write(next: DesktopSettingsFile): void {
    atomicWriteJson(file, next)
    corrupt = false
    lastGood = { ...next }
  }

  return { read, write, corrupt: () => corrupt }
}
