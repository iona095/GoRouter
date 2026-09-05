/**
 * CURRENT-015 (conditional) — pause-before-unlink proof, TEMP-only.
 *
 * Question: does inserting a pause before journal-file unlink change any
 * observable outcome? Verdict: NO production change warranted.
 * (1) No production path unlinks an open journal — tryUnlink sites cover
 * only secret blobs, the models registry, and the approvals store (never
 * open at unlink time), and server stop closes journals before cleanup.
 * The current close-before-cleanup ordering already IS pause-before-unlink.
 * (2) A concurrent unlink attempt while open is fail-closed and
 * non-corrupting on every platform (Windows: sharing violation, file
 * survives; POSIX: the open handle keeps working on the unlinked inode).
 * (3) Incidental deterministic documentation for BL-001: bun:sqlite defers
 * physical handle release past db.close() (immediate post-close unlink
 * fails EBUSY; a short pause lets it succeed). That quirk affects only
 * cleanup timing, never production correctness — forwarded to Wave E.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJournal } from "../src/journal.ts";

const dirs: string[] = [];
afterEach(() => {
  // Fast best-effort cleanup (well under the hook budget): bun:sqlite
  // releases the file handle shortly after close (see BL-001). A lingering
  // lock only leaves a uniquely-named TEMP dir behind; it never fails
  // assertions and never affects other tests.
  for (const d of dirs.splice(0)) {
    for (let i = 0; i < 10; i++) {
      try { rmSync(d, { recursive: true, force: true }); break; }
      catch { if (i < 9) Bun.sleepSync(100); }
    }
  }
});

function beginRow(journal: ReturnType<typeof createJournal>, lane: string) {
  return journal.begin({
    lane, selectedAccountId: null, selectedAccountAliasSnapshot: null,
    method: "GET", endpointFamily: "models", terminalOutcome: "local_error",
    httpStatus: null, upstreamRequestIds: [], model: null, clientCorrelationId: null,
  });
}

describe("CURRENT-015 unlink-ordering proof", () => {
  test("open handle survives a concurrent unlink attempt with records intact", () => {
    const dir = mkdtempSync(join(tmpdir(), "gorouter-unlinkproof-"));
    dirs.push(dir);
    const dbPath = join(dir, "journal.db");
    const journal = createJournal(dbPath, 30, 100_000);
    expect(beginRow(journal, "go").routerRequestId).toBeTruthy();
    expect(existsSync(dbPath)).toBe(true);
    // A second server's cleanup racing this holder: fail-closed everywhere.
    try { unlinkSync(dbPath); } catch { /* Windows sharing violation: file survives */ }
    expect(beginRow(journal, "zen").routerRequestId).toBeTruthy();
    expect(journal.stats().records).toBeGreaterThanOrEqual(2);
    journal.close();
  });

  test("post-close unlink needs only a short pause (deferred handle release; BL-001 evidence)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gorouter-unlinkproof-"));
    dirs.push(dir);
    const dbPath = join(dir, "journal.db");
    const journal = createJournal(dbPath, 30, 100_000);
    beginRow(journal, "go");
    journal.close();
    // Immediate unlink may fail EBUSY (deferred release) — record, don't assert.
    let immediate = "ok";
    try { unlinkSync(dbPath); } catch (e) { immediate = (e as Error).message.split(",")[0] ?? "?"; }
    console.log(`post-close immediate unlink outcome: ${immediate}`);
    // A short pause always suffices: eventual removal is deterministic.
    let removed = !existsSync(dbPath);
    for (let i = 0; i < 50 && !removed; i++) {
      await Bun.sleep(100);
      try { unlinkSync(dbPath); } catch { /* not yet */ }
      removed = !existsSync(dbPath);
    }
    expect(removed).toBe(true);
  });
});
