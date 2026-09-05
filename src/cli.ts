/**
 * GoRouter V1 — CLI.
 *
 * Grammar:  gorouter <command> [args]
 *
 * Commands:
 *   setup                         initialize state + local credential (prints it once)
 *   local-cred                    print the local client credential (for OMP config)
 *   rotate-local-cred             rotate the local client credential
 *   account add <alias>           enroll an account (secret via stdin, never argv)
 *   account update <alias>        replace an account secret (via stdin)
 *   account list                  list aliases (no secrets)
 *   account rename <old> <new>    rename an account
 *   account remove <alias>        remove an account (refused while routed; --force clears)
 *   account test <alias>          live-probe an account (--lane go|zen, default both)
 *   route                         show lane -> account selection
 *   route go <alias>              select the Go account (independent of Zen)
 *   route zen <alias>             select the Zen account (independent of Go)
 *   route clear <go|zen>          clear a lane selection
 *   status                        full router status (routes, journal health)
 *   journal stats                 journal retention/health
 *   config show                   effective settings (no secrets)
 *   config set <key> <value>      change a setting (port/host/upstreams/retention)
 *   serve                         run the router in the foreground
 *   reset --yes                   remove accounts, secrets and the local credential
 *   models status [--json]          registry state (age, TTL, attempts, retry, counts, diff summary)
 *   models list <go|zen> [--json]   list models for a lane (also: --lane go|zen, or no lane for both)
 *   models refresh [--json]         forced refresh (bypass TTL, non-zero on failure)
 *   models diff [--json]            last meaningful model changes
 *
 * Secrets never appear on argv, in shell history or in output.
 *
 * Command bodies delegate to src/domain.ts — the one authoritative set of
 * domain operations shared with the desktop control service (V1.5).
 */
import { resolvePaths, ensureStateDirs } from "./paths.ts";
import { createSecretStore } from "./secret-store.ts";
import { createDomain } from "./domain.ts";
import { createJournal } from "./journal.ts";
import { createServer } from "./server.ts";
import { createStateStore, validateUpstreamUrl, isValidPort, LANES, type Lane } from "./state.ts";
import { log, redact } from "./util.ts";

const USAGE = `Usage: gorouter <command> [args]
Commands:
  setup | local-cred | rotate-local-cred
  account add|update|list|rename|remove|test ...
  route [go|zen <alias>] | route clear <go|zen>
  status | journal stats | config show | config set <key> <value> | serve | reset --yes
  models status|list|refresh|diff [--json]  (list: gorouter models list <go|zen> [--json] or --lane)
  models approvals status|list [--json]
  models approvals approve|revoke --lane <go|zen> <model-id> [--json]
  models approvals migrate [--json]          (preview; apply: migrate --apply --proposal <id>)`;

async function readSecretFromStdin(): Promise<string> {
  const text = await Bun.stdin.text();
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) throw new Error("no secret provided on stdin");
  const secret = lines[0]!.trim();
  if (secret.length === 0 || secret.length > 1024) throw new Error("invalid secret on stdin");
  return secret;
}

function requireNoExtra(args: string[], usage: string): void {
  if (args.length > 0) throw new Error(usage);
}

function printStatus(state: { routes: Record<Lane, { accountId: string | null }>; accounts: Array<{ id: string; alias: string }> }): void {
  const goId = state.routes.go.accountId;
  const zenId = state.routes.zen.accountId;
  const aliasOf = (id: string | null): string => {
    if (!id) return "(none)";
    const a = state.accounts.find((x) => x.id === id);
    return a ? a.alias : `(missing: ${id})`;
  };
  console.log("GoRouter V1 status");
  console.log(`  GO  -> ${aliasOf(goId)}`);
  console.log(`  ZEN -> ${aliasOf(zenId)}`);
  console.log("  Automatic account rotation: DISABLED by design");
  console.log("  Router-initiated lane fallback: DISABLED by design");
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...args] = argv;
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(USAGE);
    return cmd ? 0 : 1;
  }

  const paths = resolvePaths();
  const secrets = createSecretStore(paths.secretsDir);
  const domain = createDomain(paths, secrets);

  switch (cmd) {
    case "setup": {
      const { created, credential } = domain.setup();
      if (created) {
        console.log("GoRouter state initialized.");
        console.log("Local client credential (print once; used by OMP provider config):");
        console.log(credential);
        console.log("WARNING: treat this like a password. OMP sends it only to 127.0.0.1:8787.");
      } else {
        console.log("GoRouter state already initialized (state dir: " + paths.state + ").");
        console.log("Use `gorouter local-cred` to view the local client credential.");
      }
      return 0;
    }
    case "local-cred": {
      try {
        console.log(domain.localCredential());
      } catch (e) {
        console.error(e instanceof Error ? e.message : String(e));
        return 1;
      }
      return 0;
    }
    case "rotate-local-cred": {
      const credential = domain.rotateLocalCredential();
      console.log("Local client credential rotated. Update OMP provider configuration now:");
      console.log(credential);
      return 0;
    }
    case "account": {
      const sub = args[0];
      const rest = args.slice(1);
      switch (sub) {
        case "add": {
          if (rest.length !== 1) throw new Error("usage: gorouter account add <alias>");
          const secret = await readSecretFromStdin();
          const account = domain.accountAdd(rest[0]!, secret);
          console.log(`account '${account.alias}' added (secret stored via DPAPI)`);
          return 0;
        }
        case "update": {
          if (rest.length !== 1) throw new Error("usage: gorouter account update <alias>");
          const secret = await readSecretFromStdin();
          const account = domain.accountUpdate(rest[0]!, secret);
          console.log(`account '${account.alias}' credential updated`);
          return 0;
        }
        case "list": {
          const accounts = domain.accountList();
          if (accounts.length === 0) {
            console.log("no accounts configured");
          }
          for (const a of accounts) {
            const routed = a.usedBy.join(",");
            console.log(`${a.alias}\tid=${a.id}\tsecret=DPAPI:${a.secretRef.slice(0, 12)}…${routed ? `\troutes=${routed}` : ""}`);
          }
          return 0;
        }
        case "rename": {
          if (rest.length !== 2) throw new Error("usage: gorouter account rename <old> <new>");
          const { renamed, previousAlias } = domain.accountRename(rest[0]!, rest[1]!);
          console.log(`account renamed '${previousAlias}' -> '${renamed.alias}' (stable id preserved)`);
          return 0;
        }
        case "remove": {
          const force = rest.includes("--force");
          const name = rest.find((x) => x !== "--force");
          if (!name) throw new Error("usage: gorouter account remove <alias> [--force]");
          const { removed, secretDeleted } = domain.accountRemove(name, force);
          // F-26: never claim "secret blob deleted" when nothing was there.
          console.log(`account '${removed.alias}' removed` + (secretDeleted ? " (secret blob deleted)" : " (no secret blob was present — nothing left behind)"));
          return 0;
        }
        case "test": {
          const laneArg = rest.indexOf("--lane");
          let lanes: Lane[] = ["go", "zen"];
          if (laneArg >= 0) {
            const v = rest[laneArg + 1]?.toLowerCase();
            if (v !== "go" && v !== "zen") throw new Error("--lane must be go or zen");
            lanes = [v];
          }
          // alias is the first arg that is not part of --lane <value>
          const name = rest.find((x, i) => {
            if (x === "--lane") return false;
            if (laneArg >= 0 && i === laneArg + 1) return false;
            return true;
          });
          if (!name) throw new Error("usage: gorouter account test <alias> [--lane go|zen]");
          const results = await domain.accountTest(name, lanes);
          for (const r of results) {
            const brief = r.errorMessageBrief !== null ? ` (${redact(r.errorMessageBrief)})` : "";
            console.log(
              `account '${name}' lane=${r.lane} model=${r.model} => ${r.verdict} http=${r.httpStatus ?? "network-error"}${brief} ${r.tookMs}ms`,
            );
            if (r.verdict === "AUTH_FAIL") {
              console.log(`  NOTE: credential rejected by the ${r.lane.toUpperCase()} lane (401 AuthError)`);
            } else if (r.verdict === "AUTH_PASS_QUOTA_STATE") {
              console.log(`  NOTE: authentication accepted; quota state: ${r.errorType !== null ? redact(r.errorType) : ""}${r.workspaceHint !== null ? ` workspace=${redact(r.workspaceHint)}` : ""}`);
            } else if (r.verdict === "AUTH_PASS_UPSTREAM_STATE") {
              console.log(`  NOTE: authentication accepted; upstream state: ${r.errorType !== null ? redact(r.errorType) : ""}`);
            } else if (r.verdict === "UNKNOWN") {
              console.log(`  NOTE: ambiguous result; cannot prove authentication`);
            }
          }
          return 0;
        }
        default:
          throw new Error("usage: gorouter account add|update|list|rename|remove|test ...");
      }
    }
    case "route": {
      if (args.length === 0) {
        const st = domain.status();
        printStatus({ routes: Object.fromEntries(st.routes.map((r) => [r.lane, { accountId: r.accountId }])) as Record<Lane, { accountId: string | null }>, accounts: st.accounts });
        return 0;
      }
      if (args[0] === "clear") {
        const lane = args[1]?.toLowerCase();
        if (lane !== "go" && lane !== "zen") throw new Error("usage: gorouter route clear <go|zen>");
        domain.routeClear(lane);
        console.log(`route ${lane.toUpperCase()} cleared`);
        return 0;
      }
      const lane = args[0]?.toLowerCase();
      const alias = args[1];
      if ((lane !== "go" && lane !== "zen") || !alias) {
        throw new Error("usage: gorouter route <go|zen> <alias>");
      }
      domain.routeSet(lane, alias);
      const st = domain.status();
      printStatus({ routes: Object.fromEntries(st.routes.map((r) => [r.lane, { accountId: r.accountId }])) as Record<Lane, { accountId: string | null }>, accounts: st.accounts });
      return 0;
    }
    case "status": {
      const st = domain.status();
      printStatus({ routes: Object.fromEntries(st.routes.map((r) => [r.lane, { accountId: r.accountId }])) as Record<Lane, { accountId: string | null }>, accounts: st.accounts });
      // status is read-only: don't create journal DB if absent
      if (!st.journalExists) {
        console.log("  Journal: schema v1, records=0 (no journal yet)");
      } else {
        const journal = createJournal(paths.journalDb, st.settings.journalRetentionDays, st.settings.journalMaxRecords);
        console.log("  Journal: schema v" + journal.stats().schemaVersion + ", records=" + journal.stats().records +
          (journal.stats().degraded ? ", DEGRADED" : "") +
          (journal.stats().lastError ? `, lastError=${journal.stats().lastError}` : ""));
        journal.close();
      }
      console.log("  State dir: " + paths.state);
      return 0;
    }
    case "journal":
      if (args[0] !== "stats") throw new Error("usage: gorouter journal stats");
      {
        const st = domain.journalStats();
        console.log(JSON.stringify(st, null, 2));
        return 0;
      }
    case "config":
      if (args[0] === "show" || args.length === 0) {
        const s = domain.configShow();
        console.log(JSON.stringify(s, null, 2));
        return 0;
      }
      if (args[0] === "set") {
        const key = args[1];
        const value = args[2];
        if (!key || value === undefined) throw new Error("usage: gorouter config set <key> <value>");
        domain.configSet(key, value);
        console.log(`setting '${key}' updated`);
        return 0;
      }
      throw new Error("usage: gorouter config show|set");
    case "serve": {
      const portArg = args.indexOf("--port");
      const hostArg = args.indexOf("--host");
      const port = portArg >= 0 ? Number(args[portArg + 1]) : undefined;
      const host = hostArg >= 0 ? args[hostArg + 1] : undefined;
      const state = createStateStore(paths, secrets);
      ensureStateDirs(paths);
      // --host/--port apply to this process only (never persisted), so a bare
      // `serve` always comes back to the persisted loopback default.
      const s0 = state.read();
      if (host !== undefined) {
        const loopback = host === "127.0.0.1" || host === "localhost" || host === "::1";
        if (!loopback) {
          console.error("non-loopback serve host requires an explicit documented approval; refusing");
          return 1;
        }
        s0.settings.host = host;
      }
      if (port !== undefined) {
        const pv = Number(port);
        // CURRENT-012: --port shares the integer invariant (no silent truncation).
        if (!isValidPort(pv)) {
          console.error(`invalid --port value '${port}': must be an integer 1..65535`);
          return 1;
        }
        s0.settings.port = pv;
      }
      const s = s0;
      if (s.localCredentialRef === null) {
        console.error("not initialized: run `gorouter setup` first");
        return 1;
      }
      // fail closed on any upstream authority that could carry credentials
      // away from the intended OpenCode lane
      for (const [lane, value] of [["go", s.settings.upstreamGo], ["zen", s.settings.upstreamZen]] as const) {
        const v = validateUpstreamUrl(value);
        if (!v.ok) {
          console.error(`refusing to serve: ${v.reason}`);
          return 1;
        }
      }
      // Pre-warm the secret cache so request serving never needs a runtime
      // DPAPI spawn (removes a whole class of transient-spawn exposure).
      try {
        state.localCredential();
        for (const a of s.accounts) {
          try { secrets.get(a.secretRef); } catch (e) {
            log.warn(`account '${a.alias}' secret unavailable at startup: ${e instanceof Error ? e.message : e}`);
          }
        }
      } catch (e) {
        console.error(`local credential unavailable: ${e instanceof Error ? e.message : e}`);
        return 1;
      }
      const journal = createJournal(paths.journalDb, s.settings.journalRetentionDays, s.settings.journalMaxRecords);
      const server = createServer({ state, journal, paths });
      server.serve();
      // A long-running proxy must survive runtime-level async faults: log
      // them and keep serving; each request is already isolated by its own
      // error handling. (Bun's default is to exit on unhandled rejections.)
      process.on("unhandledRejection", (reason) => {
        log.error(`unhandled rejection (routing continues): ${reason instanceof Error ? reason.message : String(reason)}`);
      });
      process.on("uncaughtException", (err) => {
        log.error(`uncaught exception (routing continues): ${err.message}`);
      });
      const shutdown = () => {
        server.stop();
        journal.close();
        process.exit(0);
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
      await new Promise(() => {});
      return 0;
    }
    case "reset": {
      if (!args.includes("--yes")) throw new Error("usage: gorouter reset --yes");
      domain.reset();
      console.log("router state reset (secrets deleted); journal db left in place");
      return 0;
    }
    case "models": {
      const sub = args[0];
      const rest = args.slice(1);
      const wantJson = args.includes("--json");
      const cleanRest = rest.filter((x) => x !== "--json");
      switch (sub) {
        case "status": {
          if (cleanRest.length > 0) throw new Error("usage: gorouter models status [--json]");
          const s = domain.modelsStatus();
          if (wantJson) {
            const payload: Record<string, unknown> = {
              exists: s.exists,
              corrupt: (s as unknown as { corrupt?: boolean }).corrupt ?? false,
              schemaVersion: s.registry?.schemaVersion ?? null,
              updatedAtUtc: s.registry?.updatedAtUtc ?? null,
              ageMs: s.ageMs,
              ageHuman: s.ageHuman,
              ttlMs: s.ttlMs,
              cooldownMs: s.cooldownMs,
              isFresh: s.isFresh,
              isCooldown: s.isCooldown,
              cooldownRemainingMs: s.cooldownRemainingMs,
              retryEligible: s.retryEligible,
              counts: s.counts,
              diffSummary: s.diffSummary,
              lastAttempt: s.lastAttempt,
              isStale: s.exists && !((s as unknown as { corrupt?: boolean }).corrupt) ? !s.isFresh : null,
              dshSync: s.dshSync ?? null,
            };
            console.log(JSON.stringify(payload, null, 2));
          } else {
            if (!s.exists) {
              const isCorrupt = (s as unknown as { corrupt?: boolean }).corrupt;
              if (isCorrupt) {
                console.log("GoRouter Models \u2014 registry corrupt");
                console.log("  Registry file is corrupt (schema invalid or unreadable) \u2014 treating as absent.");
                console.log("  TTL: " + (s.ttlMs / 3600000) + "h  Cooldown: " + (s.cooldownMs / 60000) + "m");
                console.log("  Run `gorouter models refresh` to refetch and repair.");
              } else {
                console.log("GoRouter Models \u2014 registry missing");
                console.log("  No registry file yet (no successful refresh).");
                console.log("  TTL: " + (s.ttlMs / 3600000) + "h  Cooldown: " + (s.cooldownMs / 60000) + "m");
                console.log("  Run `gorouter models refresh` to fetch the upstream catalogs.");
              }
            } else if ((s as unknown as { corrupt?: boolean }).corrupt) {
              console.log("GoRouter Models \u2014 registry corrupt");
              console.log("  Registry file is corrupt (schema invalid or unreadable) \u2014 treating as absent.");
              console.log("  TTL: " + (s.ttlMs / 3600000) + "h  Cooldown: " + (s.cooldownMs / 60000) + "m");
              console.log("  Run `gorouter models refresh` to refetch and repair.");
            } else {
              const freshLabel = s.isFresh ? "fresh" : "stale";
              console.log("GoRouter Models \u2014 registry present (" + freshLabel + ")");
              console.log("  Schema: v" + (s.registry!.schemaVersion) + "  Updated: " + s.registry!.updatedAtUtc + "  Age: " + (s.ageHuman ?? s.ageMs + "ms") + " / TTL: " + (s.ttlMs / 3600000) + "h  Threshold: " + new Date(Date.parse(s.registry!.updatedAtUtc) + s.ttlMs).toISOString());
              if (s.isCooldown) {
                const secs = Math.ceil(s.cooldownRemainingMs / 1000);
                console.log("  Cooldown: active (" + secs + "s remaining) \u2014 retry not yet eligible");
              } else {
                console.log("  Cooldown: none \u2014 retry eligible: " + (s.retryEligible ? "yes" : "no"));
              }
              for (const lane of ["go", "zen"] as const) {
                const snap = lane === "go" ? s.registry!.go : s.registry!.zen;
                const att = s.lastAttempt ? (lane === "go" ? s.lastAttempt.go : s.lastAttempt.zen) : null;
                const count = s.counts[lane];
                const fetchedAt = snap?.fetchedAtUtc ?? "(never)";
                const expiresAt = snap ? new Date(Date.parse(snap.fetchedAtUtc) + s.ttlMs).toISOString() : "(n/a)";
                console.log("  " + lane.toUpperCase() + ": " + count + " models  fetchedAt=" + fetchedAt + "  expiresAt=" + expiresAt);
                if (att) {
                  const okLabel = att.success ? "success" : "FAIL";
                  const errPart = att.error ? " error=" + redact(att.error) : "";
                  const statusPart = att.httpStatus !== null ? " http=" + att.httpStatus : "";
                  console.log("    last attempt: " + att.atUtc + " " + okLabel + statusPart + errPart + " (" + att.durationMs + "ms)");
                } else {
                  console.log("    last attempt: none");
                }
                console.log("    retry eligible: " + (!s.isCooldown ? "yes" : "no"));
              }
              const ds = s.diffSummary;
              if (ds.total === 0) {
                console.log("  Diff: no changes (lastDiff empty)");
              } else {
                console.log("  Diff: +" + ds.added + " added, -" + ds.removed + " removed, ~" + ds.changed + " changed (total " + ds.total + ", last at " + (ds.lastDiffAtUtc ?? s.registry!.updatedAtUtc) + ")");
              }
              // Slice B: DSH sync observability
              const dsh = s.dshSync;
              if (dsh) {
                console.log("  DSH sync: enabled=" + dsh.enabled + " reachable=" + dsh.reachable + " outcome=" + dsh.outcome + " mutation=" + dsh.mutationPerformed);
                if (dsh.lastAttemptAt) console.log("    lastAttempt: " + dsh.lastAttemptAt + (dsh.lastSuccessAt ? " lastSuccess: " + dsh.lastSuccessAt : ""));
                if (dsh.activeGoCount !== null || dsh.activeZenCount !== null) console.log("    active: go=" + (dsh.activeGoCount ?? "?") + " zen=" + (dsh.activeZenCount ?? "?"));
                if (dsh.withheldGoCount !== null || dsh.withheldZenCount !== null) console.log("    withheld: go=" + (dsh.withheldGoCount ?? "?") + " zen=" + (dsh.withheldZenCount ?? "?"));
                if (dsh.observedRevision !== null || dsh.committedRevision !== null) console.log("    revision: observed=" + dsh.observedRevision + " committed=" + dsh.committedRevision);
                if (dsh.lastError) console.log("    lastError: " + redact(dsh.lastError));
              } else {
                console.log("  DSH sync: no status yet (no reconciliation attempted)");
              }
            }
          }
          return 0;
        }
        case "list": {
          // Accept: `models list <go|zen>`, `models list --lane go|zen`, or `models list` (=both lanes).
          const laneFlagIdx = cleanRest.indexOf("--lane");
          let lane: string | null = null;
          let remaining: string[] = [];
          if (laneFlagIdx >= 0) {
            lane = cleanRest[laneFlagIdx + 1]?.toLowerCase() ?? null;
            remaining = cleanRest.filter((_, i) => i !== laneFlagIdx && i !== laneFlagIdx + 1);
          } else {
            lane = cleanRest[0]?.toLowerCase() ?? null;
            remaining = cleanRest.slice(lane ? 1 : 0);
          }
          if (remaining.length > 0) throw new Error("usage: gorouter models list [go|zen|--lane go|zen] [--json]");
          if (lane !== null && lane !== "go" && lane !== "zen") throw new Error("usage: gorouter models list [go|zen|--lane go|zen] [--json]");
          if (lane === null) {
            // No lane filter: show both lanes (spec's optional lane).
            const go = domain.modelsList("go");
            const zen = domain.modelsList("zen");
            if (wantJson) {
              console.log(JSON.stringify({ go, zen }, null, 2));
            } else {
              for (const v of [go, zen] as const) {
                console.log("Models lane=" + v.lane + " (" + v.count + " entries" + (v.fetchedAtUtc ? ", fetched " + v.fetchedAtUtc : ", never fetched") + ")");
                if (v.models.length === 0) console.log("  (no models)");
                else for (const m of v.models) {
                  const extra: string[] = [];
                  if (typeof m.object === "string") extra.push("object=" + m.object);
                  if (typeof m.owned_by === "string") extra.push("owned_by=" + m.owned_by);
                  if (typeof m.created === "number") extra.push("created=" + m.created);
                  console.log("  " + m.id + (extra.length ? "  " + extra.join("  ") : ""));
                }
              }
            }
            return 0;
          }
          const v = domain.modelsList(lane as "go" | "zen");
          if (wantJson) {
            console.log(JSON.stringify(v, null, 2));
          } else {
            console.log("Models lane=" + v.lane + " (" + v.count + " entries" + (v.fetchedAtUtc ? ", fetched " + v.fetchedAtUtc : ", never fetched") + ")");
            if (v.models.length === 0) {
              console.log("  (no models)");
            } else {
              for (const m of v.models) {
                const extra: string[] = [];
                if (typeof m.object === "string") extra.push("object=" + m.object);
                if (typeof m.owned_by === "string") extra.push("owned_by=" + m.owned_by);
                if (typeof m.created === "number") extra.push("created=" + m.created);
                console.log("  " + m.id + (extra.length ? "  " + extra.join("  ") : ""));
              }
            }
          }
          return 0;
        }
        case "refresh": {
          if (cleanRest.length > 0) throw new Error("usage: gorouter models refresh [--json]");
          const result = await domain.modelsRefresh();
          if (wantJson) {
            const payload = {
              success: result.success,
              error: result.error,
              fromCache: result.fromCache,
              diff: result.diff,
              registry: result.registry,
            };
            console.log(JSON.stringify(payload, null, 2));
          } else {
            if (result.success) {
              const goCount = result.registry?.go?.models.length ?? 0;
              const zenCount = result.registry?.zen?.models.length ?? 0;
              console.log("models refreshed: go=" + goCount + " zen=" + zenCount);
              if (result.diff.length > 0) {
                console.log("  diff: +" + result.diff.filter((d) => d.kind === "MODEL_ADDED").length + " added, -" + result.diff.filter((d) => d.kind === "MODEL_REMOVED").length + " removed, ~" + result.diff.filter((d) => d.kind === "MODEL_CHANGED").length + " changed");
              }
            } else {
              console.error("models refresh failed: " + redact(result.error ?? "unknown error"));
            }
          }
          return result.success ? 0 : 1;
        }
        case "diff": {
          if (cleanRest.length > 0) throw new Error("usage: gorouter models diff [--json]");
          const entries = domain.modelsDiff();
          if (wantJson) {
            const reg = domain.modelsStatus().registry;
            console.log(JSON.stringify({ entries, generatedAtUtc: new Date().toISOString(), lastDiffAtUtc: reg?.updatedAtUtc ?? null }, null, 2));
          } else {
            if (entries.length === 0) {
              console.log("no changes (no diff since last successful publish)");
            } else {
              const reg = domain.modelsStatus().registry;
              console.log("Model changes (since " + (reg?.updatedAtUtc ?? "first publish") + ", " + entries.length + " entries):");
              for (const e of entries) {
                const sym = e.kind === "MODEL_ADDED" ? "+" : e.kind === "MODEL_REMOVED" ? "-" : "~";
                console.log("  " + sym + " " + e.lane.toUpperCase() + " " + e.kind + " " + e.id);
              }
            }
          }
          return 0;
        }
        case "approvals": {
          const sub = rest[0];
          const a = rest.slice(1);
          const wantAJson = a.includes("--json");
          const cleanA = a.filter((x) => x !== "--json" && x !== "--apply" && x !== "--lane" && x !== "--proposal");
          const laneFlagIdx = a.indexOf("--lane");
          const laneValue = laneFlagIdx >= 0 ? a[laneFlagIdx + 1]?.toLowerCase() : undefined;
          const proposalIdx = a.indexOf("--proposal");
          const proposalValue = proposalIdx >= 0 ? a[proposalIdx + 1] : undefined;
          const applyFlag = a.includes("--apply");
          const positional = cleanA.filter((x, i) => x !== laneValue && x !== proposalValue);
          switch (sub) {
            case "status": {
              if (cleanA.length > 0) throw new Error("usage: gorouter models approvals status [--json]");
              const s = await domain.approvalsStatus();
              if (wantAJson) {
                console.log(JSON.stringify(s, null, 2));
              } else {
                console.log("GoRouter DSH Catalog Approvals");
                console.log("  Store: " + s.storeState + (s.initializedAtUtc ? " (initialized " + s.initializedAtUtc + ")" : "") + (s.corruptReason ? " (" + s.corruptReason + ")" : ""));
                console.log("  Migration required: " + (s.migrationRequired ? "YES (legacy DSH state not yet ratified; owned arrays preserved)" : "no"));
                if (s.migrationCandidateCount !== null) console.log("  Migration candidates: " + s.migrationCandidateCount);
                console.log("  Approvals: go=" + s.countsByLane.go + " zen=" + s.countsByLane.zen);
                for (const ap of s.approvals) {
                  console.log("    [" + ap.lane + "] " + ap.dshProviderId + " / " + ap.apiProtocol + " / " + ap.modelId + " (" + ap.source + ", " + ap.approvedAtUtc + ")");
                }
                if (s.binding) {
                  console.log("  Owned provider binding: " + (s.binding.valid ? "valid" : "INVALID"));
                  for (const b of [s.binding.go, s.binding.zen]) {
                    console.log("    " + b.lane + ": " + (b.valid ? "ok (" + (b.api ?? "?") + " -> " + (b.baseURL ?? "?") + ")" : "invalid: " + b.reason));
                  }
                } else {
                  console.log("  Owned provider binding: unknown (DSH settings not readable)");
                }
                if (s.activeCounts) console.log("  Active (approved + in registry): go=" + s.activeCounts.go + " zen=" + s.activeCounts.zen);
                if (s.withheldCounts) console.log("  Withheld/unapproved (in registry): go=" + s.withheldCounts.go + " zen=" + s.withheldCounts.zen);
                if (s.approvedAbsentCounts) console.log("  Approved-absent (inactive): go=" + s.approvedAbsentCounts.go + " zen=" + s.approvedAbsentCounts.zen);
                const d = s.dshSync;
                if (d) {
                  console.log("  DSH sync: outcome=" + d.outcome + " mutation=" + d.mutationPerformed + (d.lastSuccessAt ? " lastSuccess=" + d.lastSuccessAt : "") + (d.lastError ? " lastError=" + redact(d.lastError) : ""));
                } else {
                  console.log("  DSH sync: no status yet");
                }
              }
              return 0;
            }
            case "list": {
              if (cleanA.length > 0) throw new Error("usage: gorouter models approvals list [--json]");
              const s = await domain.approvalsStatus();
              if (wantAJson) {
                console.log(JSON.stringify({ storeState: s.storeState, approvals: s.approvals, countsByLane: s.countsByLane }, null, 2));
              } else {
                if (s.approvals.length === 0) {
                  console.log(s.storeState === "initialized" ? "no approvals (initialized empty authority set)" : "no approvals (store " + s.storeState + ")");
                } else {
                  for (const ap of s.approvals) {
                    console.log("[" + ap.lane + "] " + ap.modelId + "\tprovider=" + ap.dshProviderId + "\tapi=" + ap.apiProtocol + "\tsource=" + ap.source);
                  }
                }
              }
              return 0;
            }
            case "approve": {
              const modelId = positional.find((x) => x !== "approve");
              if (!modelId || !laneValue) throw new Error("usage: gorouter models approvals approve --lane <go|zen> <model-id> [--json]");
              if (laneValue !== "go" && laneValue !== "zen") throw new Error("--lane must be go or zen");
              const r = await domain.approvalsApprove(laneValue, modelId);
              const dupLabel = r.duplicate ? " (already approved; idempotent)" : "";
              console.log("approved [" + r.tuple.lane + "] " + r.tuple.modelId + " provider=" + r.tuple.dshProviderId + " api=" + r.tuple.apiProtocol + dupLabel);
              if (r.dshSync) console.log("dsh sync: outcome=" + r.dshSync.outcome + " mutation=" + r.dshSync.mutationPerformed + (r.dshSync.lastError ? " lastError=" + redact(r.dshSync.lastError) : ""));
              return 0;
            }
            case "revoke": {
              const modelId = positional.find((x) => x !== "revoke");
              if (!modelId || !laneValue) throw new Error("usage: gorouter models approvals revoke --lane <go|zen> <model-id> [--json]");
              if (laneValue !== "go" && laneValue !== "zen") throw new Error("--lane must be go or zen");
              const r = await domain.approvalsRevoke(laneValue, modelId);
              // F-21: never print bare success when nothing was revoked or the
              // change never reached DSH (the model may still be live there).
              if (r.removed === 0) {
                console.error(`not approved [${laneValue}] ${modelId} — nothing to revoke`);
                return 1;
              }
              console.log("revoked [" + laneValue + "] " + modelId + " (entries removed: " + r.removed + ")");
              if (r.dshSync) console.log("dsh sync: outcome=" + r.dshSync.outcome + " mutation=" + r.dshSync.mutationPerformed + (r.dshSync.lastError ? " lastError=" + redact(r.dshSync.lastError) : ""));
              if (r.dshSync && (r.dshSync.outcome === "error" || r.dshSync.reachable === false)) {
                console.error(`revoke incomplete: DSH sync ${r.dshSync.outcome} (${redact(r.dshSync.lastError ?? "DSH unreachable")}) — the model may still be active in DSH; re-run sync when DSH is reachable`);
                return 1;
              }
              return 0;
            }
            case "migrate": {
              if (applyFlag) {
                if (!proposalValue) throw new Error("usage: gorouter models approvals migrate --apply --proposal <id> [--json]");
                const r = await domain.approvalsMigrateApply(proposalValue);
                if (wantAJson) {
                  console.log(JSON.stringify(r, null, 2));
                } else {
                  console.log("migration ratified and applied: proposal=" + r.proposalId.slice(0, 16) + "…");
                  for (const c of r.candidates) {
                    console.log("  imported [" + c.lane + "] " + c.modelId + " provider=" + c.dshProviderId + " api=" + c.apiProtocol);
                  }
                  if (r.dshSync) console.log("dsh sync: outcome=" + r.dshSync.outcome + " mutation=" + r.dshSync.mutationPerformed + (r.dshSync.lastError ? " lastError=" + redact(r.dshSync.lastError) : ""));
                }
                return 0;
              }
              if (cleanA.length > 0) throw new Error("usage: gorouter models approvals migrate [--json] | migrate --apply --proposal <id>");
              const p = await domain.approvalsMigratePreview();
              if (wantAJson) {
                console.log(JSON.stringify(p, null, 2));
              } else {
                console.log("DSH Legacy Migration Preview (read-only)");
                console.log("  Bindings: " + (p.bindingsValid ? "valid" : "INVALID — apply will fail closed until fixed"));
                console.log("  DSH revision observed: " + p.revision);
                console.log("  Proposal id: " + p.proposalId);
                console.log("  Candidates (" + p.candidates.length + "):");
                for (const c of p.candidates) {
                  console.log("    [" + c.lane + "] " + c.modelId + "\tprovider=" + c.dshProviderId + "\tapi=" + c.apiProtocol);
                }
                console.log("  Ratify with: gorouter models approvals migrate --apply --proposal " + p.proposalId);
              }
              return 0;
            }
            default:
              throw new Error("usage: gorouter models approvals <status|list|approve|revoke|migrate> ...");
          }
        }
        default:
          throw new Error("usage: gorouter models <status|list|refresh|diff> [--json]");
      }
    }
    default:
      throw new Error(`unknown command '${cmd}'\n${USAGE}`);
  }
}

/**
 * Serve-time state store (ephemeral --port/--host overrides) and upstream
 * validation are router-entry concerns, not domain mutations; keep them
 * local to the CLI entrypoint with the same V1 semantics.
 */
main(Bun.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
