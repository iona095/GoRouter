/**
 * Slice B — DSH live catalog sync types and constants.
 *
 * Keeps DSH-specific logic isolated from the certified registry core.
 */

export const MAX_REVISION_RETRIES = 3;

export const DSH_NAMESPACE = "llm-pi-ai" as const;
export const DSH_GO_PATH: readonly string[] = ["providers", "gorouter-go", "models"] as const;
export const DSH_ZEN_PATH: readonly string[] = ["providers", "gorouter-zen", "models"] as const;

export type DshSyncOutcome = "current" | "no-op" | "pending" | "error";

export interface DshSyncStatus {
  enabled: boolean;
  reachable: boolean | null;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  outcome: DshSyncOutcome;
  mutationPerformed: boolean;
  observedRevision: number | null;
  committedRevision: number | null;
  activeGoCount: number | null;
  activeZenCount: number | null;
  withheldGoCount: number | null;
  withheldZenCount: number | null;
  lastError: string | null;
}

export function emptyDshSyncStatus(): DshSyncStatus {
  return {
    enabled: true,
    reachable: null,
    lastAttemptAt: null,
    lastSuccessAt: null,
    outcome: "pending",
    mutationPerformed: false,
    observedRevision: null,
    committedRevision: null,
    activeGoCount: null,
    activeZenCount: null,
    withheldGoCount: null,
    withheldZenCount: null,
    lastError: null,
  };
}

export interface DshSyncResult {
  status: DshSyncStatus;
  /** Whether caller should consider the registry publish still successful (always true for downstream failures). */
  registryPreserved: boolean;
}

export interface DshSyncConfig {
  /** Whether DSH sync is enabled (default true). */
  enabled?: boolean;
  /** Optional explicit DSH settings.yaml path (must be local file, not URL). Null = auto-discover. */
  settingsPath?: string | null;
  /** Optional explicit DSH_WEB_URL override (must be loopback). */
  dshWebUrl?: string | null;
}

export function normalizeDshSyncConfig(raw: unknown): DshSyncConfig {
  if (typeof raw !== "object" || raw === null) return { enabled: true };
  const o = raw as Record<string, unknown>;
  const out: DshSyncConfig = {};
  if (typeof o.enabled === "boolean") out.enabled = o.enabled;
  else out.enabled = true;
  if (typeof o.settingsPath === "string") out.settingsPath = o.settingsPath;
  else if (o.settingsPath === null) out.settingsPath = null;
  if (typeof o.dshWebUrl === "string") out.dshWebUrl = o.dshWebUrl;
  else if (o.dshWebUrl === null) out.dshWebUrl = null;
  return out;
}

/** Validate that a candidate path/URL is local-only (loopback or filesystem path). */
export function isLocalOnlyDshEndpoint(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  // Windows drive paths (C:\ or C:/) are local files — return early before URL parsing
  if (/^[A-Za-z]:[\\\/]/.test(trimmed)) return true;
  // UNC and protocol-relative remote shares are never local
  if (trimmed.startsWith("\\\\")) return false;
  if (trimmed.startsWith("//")) return false;
  // file:// URLs — hostname must be empty or localhost/loopback; reject remote hosts like evil.example
  if (trimmed.startsWith("file://")) {
    try {
      const u = new URL(trimmed);
      if (u.protocol !== "file:") return false;
      const host = u.hostname.toLowerCase();
      if (host === "") return true;
      if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]" || host.startsWith("127.")) return true;
      return false;
    } catch {
      return false;
    }
  }
  // URLs containing :// — only allow http/https loopback or file with empty/localhost host
  if (trimmed.includes("://")) {
    try {
      const u = new URL(trimmed);
      if (u.protocol === "http:" || u.protocol === "https:") {
        return isLoopbackHostname(u.hostname);
      }
      if (u.protocol === "file:") {
        const h = u.hostname.toLowerCase();
        if (h === "") return true;
        if (h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]" || h.startsWith("127.")) return true;
        return false;
      }
      return false;
    } catch {
      return false;
    }
  }
  // Try URL parse for edge cases (e.g., http://localhost without :// already handled) — only allow http/https/file loopback
  try {
    // If it parses as a URL with a scheme, enforce loopback/file rules; Windows drive already returned true
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) {
      const u = new URL(trimmed);
      if (u.protocol === "http:" || u.protocol === "https:") {
        return isLoopbackHostname(u.hostname);
      }
      if (u.protocol === "file:") {
        const h = u.hostname.toLowerCase();
        if (h === "") return true;
        if (h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]" || h.startsWith("127.")) return true;
        return false;
      }
      return false;
    }
  } catch {
    // Not a URL — fall through to filesystem handling
  }
  // Filesystem path handling — reject UNC already handled above, reject any :// already handled
  if (trimmed.includes("://")) return false;
  if (trimmed.startsWith("\\\\")) return false;
  if (trimmed.startsWith("//")) return false;
  // All remaining filesystem paths (absolute /tmp, relative ./foo, ~/ etc) are considered local
  return true;
}

/** Check if a hostname is loopback (for DSH_WEB_URL validation). */
export function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "[::1]" || h.startsWith("127.");
}
