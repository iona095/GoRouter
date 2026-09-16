import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Tool-root resolution that works in source mode (bun src/cli.ts) and in the
 * compiled companion (bun build --compile), where import.meta.dir is a
 * virtual embedded path ($bunfs) with no filesystem meaning.
 *
 * - source mode: the real tools/wire-inspector directory; outputs and state
 *   stay contained beneath it (fail closed otherwise).
 * - compiled mode: no filesystem tool root exists; the caller-supplied
 *   --out directory (absolute in proofs, cwd-relative otherwise) is the
 *   isolation root and every containment check anchors to it.
 */

/** Real filesystem tool root, or null inside the compiled executable. */
export function toolRoot(): string | null {
  const dir = import.meta.dir;
  if (dir.includes("$bunfs")) return null;
  const root = resolve(dir, "..");
  try {
    if (existsSync(join(root, "src", "cli.ts"))) return root;
  } catch { /* fall through */ }
  return null;
}

/** True when running as the compiled standalone executable. */
export function isCompiledExe(): boolean {
  return toolRoot() === null;
}

/**
 * Resolve the output base. Relative --out resolves against the tool root in
 * source mode and against the process cwd in compiled mode.
 */
export function resolveOutBase(outDir: string | undefined): string {
  const root = toolRoot();
  if (outDir && outDir.trim().length > 0) {
    const v = outDir.trim();
    if (resolve(v) === v || /^[A-Za-z]:\\/.test(v) || v.startsWith("\\\\")) return resolve(v);
    return resolve(root ?? process.cwd(), v);
  }
  return join(root ?? process.cwd(), "output");
}

/**
 * Fail closed on a hostile GOROUTER_STATE_DIR. In source mode it must stay
 * inside the tool root; in compiled mode (no tool root) it must stay inside
 * the resolved output base. Unset is always fine (the tool never reads
 * production state; it builds explicit isolated Paths).
 */
export function assertSafeStateEnv(outBase: string): void {
  const v = process.env.GOROUTER_STATE_DIR;
  if (!v || v.trim().length === 0) return;
  const root = toolRoot();
  const anchor = root ?? outBase;
  const resolved = resolve(v.trim());
  const anchorName = root ? "WireInspector isolated root" : "output base";
  if (!resolved.toLowerCase().startsWith(anchor.toLowerCase())) {
    throw new Error(
      "WI refuses to run with GOROUTER_STATE_DIR='" + v + "' (outside " + anchorName + " '" + anchor + "').",
    );
  }
}

/** Every state dir must live beneath the resolved output base. */
export function assertStateUnderOut(stateDir: string, outBase: string): void {
  if (!resolve(stateDir).toLowerCase().startsWith(resolve(outBase).toLowerCase())) {
    throw new Error("WI state dir escaped output base (refusing)");
  }
}
