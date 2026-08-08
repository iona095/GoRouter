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
 *
 * Secrets never appear on argv, in shell history or in output.
 */
import { resolvePaths, ensureStateDirs } from "./paths.ts";
import { createSecretStore, generateLocalCredential, newRef } from "./secret-store.ts";
import {
  createStateStore,
  defaultState,
  findAccount,
  accountUsedByRoute,
  makeAccount,
  validateAlias,
  validateUpstreamUrl,
  LANES,
  DEFAULT_UPSTREAM_GO,
  DEFAULT_UPSTREAM_ZEN,
  type StateFile,
  type Lane,
} from "./state.ts";
import { createJournal } from "./journal.ts";
import { createServer } from "./server.ts";
import { probeAccountKey } from "./probe.ts";
import { log } from "./util.ts";

const USAGE = `Usage: gorouter <command> [args]
Commands:
  setup | local-cred | rotate-local-cred
  account add|update|list|rename|remove|test ...
  route [go|zen <alias>] | route clear <go|zen>
  status | journal stats | config show | config set <key> <value> | serve | reset --yes`;

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

function printStatus(state: StateFile): void {
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

  switch (cmd) {
    case "setup": {
      ensureStateDirs(paths);
      const state = createStateStore(paths, secrets);
      let cred: string;
      let created = false;
      try {
        cred = state.localCredential();
      } catch {
        cred = generateLocalCredential();
        const ref = newRef();
        secrets.put(ref, cred);
        state.mutate((s) => {
          s.localCredentialRef = ref;
        });
        created = true;
      }
      if (created) {
        console.log("GoRouter state initialized.");
        console.log("Local client credential (print once; used by OMP provider config):");
        console.log(cred);
        console.log("WARNING: treat this like a password. OMP sends it only to 127.0.0.1:8787.");
      } else {
        console.log("GoRouter state already initialized (state dir: " + paths.state + ").");
        console.log("Use `gorouter local-cred` to view the local client credential.");
      }
      return 0;
    }
    case "local-cred": {
      const state = createStateStore(paths, secrets);
      try {
        console.log(state.localCredential());
      } catch (e) {
        console.error(e instanceof Error ? e.message : String(e));
        return 1;
      }
      return 0;
    }
    case "rotate-local-cred": {
      const state = createStateStore(paths, secrets);
      const oldRef = state.read().localCredentialRef;
      const cred = generateLocalCredential();
      const ref = newRef();
      secrets.put(ref, cred);
      state.mutate((s) => {
        s.localCredentialRef = ref;
      });
      if (oldRef) secrets.delete(oldRef);
      console.log("Local client credential rotated. Update OMP provider configuration now:");
      console.log(cred);
      return 0;
    }
    case "account": {
      const sub = args[0];
      const rest = args.slice(1);
      const state = createStateStore(paths, secrets);
      switch (sub) {
        case "add": {
          if (rest.length !== 1) throw new Error("usage: gorouter account add <alias>");
          const alias = rest[0]!;
          const aliasErr = validateAlias(alias);
          if (aliasErr) throw new Error(aliasErr);
          if (findAccount(state.read(), alias)) throw new Error(`account '${alias}' already exists`);
          const secret = await readSecretFromStdin();
          const ref = newRef();
          secrets.put(ref, secret);
          state.mutate((s) => {
            s.accounts.push(makeAccount(alias, ref));
          });
          console.log(`account '${alias}' added (secret stored via DPAPI)`);
          return 0;
        }
        case "update": {
          if (rest.length !== 1) throw new Error("usage: gorouter account update <alias>");
          const account = findAccount(state.read(), rest[0]!);
          if (!account) throw new Error(`account '${rest[0]}' not found`);
          const secret = await readSecretFromStdin();
          secrets.put(account.secretRef, secret);
          state.mutate((s) => {
            const a = s.accounts.find((x) => x.id === account.id)!;
            a.updatedAtUtc = new Date().toISOString();
          });
          console.log(`account '${account.alias}' credential updated`);
          return 0;
        }
        case "list": {
          const s = state.read();
          if (s.accounts.length === 0) {
            console.log("no accounts configured");
          }
          for (const a of s.accounts) {
            const routed = LANES.filter((l) => s.routes[l].accountId === a.id).join(",");
            console.log(`${a.alias}\tid=${a.id}\tsecret=DPAPI:${a.secretRef.slice(0, 12)}…${routed ? `\troutes=${routed}` : ""}`);
          }
          return 0;
        }
        case "rename": {
          if (rest.length !== 2) throw new Error("usage: gorouter account rename <old> <new>");
          const account = findAccount(state.read(), rest[0]!);
          if (!account) throw new Error(`account '${rest[0]}' not found`);
          const newAlias = rest[1]!;
          const aliasErr = validateAlias(newAlias);
          if (aliasErr) throw new Error(aliasErr);
          if (findAccount(state.read(), newAlias)) throw new Error(`account '${newAlias}' already exists`);
          state.mutate((s) => {
            const a = s.accounts.find((x) => x.id === account.id)!;
            a.alias = newAlias;
            a.updatedAtUtc = new Date().toISOString();
          });
          console.log(`account renamed '${account.alias}' -> '${newAlias}' (stable id preserved)`);
          return 0;
        }
        case "remove": {
          const force = rest.includes("--force");
          const name = rest.find((x) => x !== "--force");
          if (!name) throw new Error("usage: gorouter account remove <alias> [--force]");
          const account = findAccount(state.read(), name);
          if (!account) throw new Error(`account '${name}' not found`);
          const lane = accountUsedByRoute(state.read(), account.id);
          if (lane && !force) {
            throw new Error(
              `account '${account.alias}' is the selected ${lane.toUpperCase()} account; remove with --force to clear the selection`,
            );
          }
          state.mutate((s) => {
            s.accounts = s.accounts.filter((x) => x.id !== account.id);
            if (force) {
              for (const l of LANES) {
                if (s.routes[l].accountId === account.id) s.routes[l].accountId = null;
              }
            }
          });
          secrets.delete(account.secretRef);
          console.log(`account '${account.alias}' removed (secret blob deleted)`);
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
          const s = state.read();
          const account = findAccount(s, name);
          if (!account) throw new Error(`account '${name}' not found`);
          const secret = secrets.get(account.secretRef);
          for (const lane of lanes) {
            const base = lane === "go" ? s.settings.upstreamGo : s.settings.upstreamZen;
            const r = await probeAccountKey(lane, secret, base);
            const brief = r.errorMessageBrief ? ` (${r.errorMessageBrief})` : "";
            console.log(
              `account '${account.alias}' lane=${lane} model=${r.model} => ${r.verdict} http=${r.httpStatus ?? "network-error"}${brief} ${r.tookMs}ms`,
            );
            if (r.verdict === "AUTH_FAIL") {
              console.log(`  NOTE: credential rejected by the ${lane.toUpperCase()} lane (401 AuthError)`);
            } else if (r.verdict === "AUTH_PASS_QUOTA_STATE") {
              console.log(`  NOTE: authentication accepted; quota state: ${r.errorType}${r.workspaceHint ? ` workspace=${r.workspaceHint}` : ""}`);
            } else if (r.verdict === "AUTH_PASS_UPSTREAM_STATE") {
              console.log(`  NOTE: authentication accepted; upstream state: ${r.errorType}`);
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
      const state = createStateStore(paths, secrets);
      if (args.length === 0) {
        printStatus(state.read());
        return 0;
      }
      if (args[0] === "clear") {
        const lane = args[1]?.toLowerCase();
        if (lane !== "go" && lane !== "zen") throw new Error("usage: gorouter route clear <go|zen>");
        state.mutate((s) => {
          s.routes[lane].accountId = null;
        });
        console.log(`route ${lane.toUpperCase()} cleared`);
        return 0;
      }
      const lane = args[0]?.toLowerCase();
      const alias = args[1];
      if ((lane !== "go" && lane !== "zen") || !alias) {
        throw new Error("usage: gorouter route <go|zen> <alias>");
      }
      const account = findAccount(state.read(), alias);
      if (!account) throw new Error(`account '${alias}' not found`);
      state.mutate((s) => {
        s.routes[lane].accountId = account.id;
      });
      printStatus(state.read());
      return 0;
    }
    case "status": {
      const state = createStateStore(paths, secrets);
      const s = state.read();
      printStatus(s);
      // status is read-only: don't create journal DB if absent
      const journalExists = require("node:fs").existsSync(paths.journalDb);
      if (!journalExists) {
        console.log("  Journal: schema v1, records=0 (no journal yet)");
      } else {
        const journal = createJournal(paths.journalDb, s.settings.journalRetentionDays, s.settings.journalMaxRecords);
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
        const s = createStateStore(paths, secrets).read();
        const journal = createJournal(paths.journalDb, s.settings.journalRetentionDays, s.settings.journalMaxRecords);
        const st = journal.stats();
        console.log(JSON.stringify(st, null, 2));
        journal.close();
        return 0;
      }
    case "config":
      if (args[0] === "show" || args.length === 0) {
        const s = createStateStore(paths, secrets).read();
        console.log(JSON.stringify(s.settings, null, 2));
        return 0;
      }
      if (args[0] === "set") {
        const key = args[1];
        const value = args[2];
        if (!key || value === undefined) throw new Error("usage: gorouter config set <key> <value>");
        const state = createStateStore(paths, secrets);
        const s = state.read();
        const settings = s.settings as unknown as Record<string, unknown>;
        if (!(key in settings)) {
          throw new Error(`unknown setting '${key}'; known: ${Object.keys(settings).join(", ")}`);
        }
        let parsed: unknown = value;
        if (key === "port" || key === "journalRetentionDays" || key === "journalMaxRecords") {
          parsed = Number(value);
          if (!Number.isFinite(parsed) || (parsed as number) <= 0) throw new Error(`invalid numeric value '${value}'`);
          if (key === "port" && (parsed as number) > 65535) throw new Error("port out of range");
        }
        if (key === "upstreamGo" || key === "upstreamZen") {
          const v = validateUpstreamUrl(value);
          if (!v.ok) throw new Error(v.reason);
          parsed = v.url.toString().replace(/\/+$/, "");
        }
        if (key === "host" && value !== "127.0.0.1" && value !== "localhost" && value !== "::1") {
          throw new Error("non-loopback binding requires explicit --host at serve time; refusing to persist");
        }
        state.mutate((s) => {
          (s.settings as unknown as Record<string, unknown>)[key] = parsed;
        });
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
        if (!Number.isFinite(pv) || pv <= 0 || pv > 65535) {
          console.error(`invalid --port value '${port}'`);
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
      const server = createServer({ state, journal });
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
      const state = createStateStore(paths, secrets);
      const s = state.read();
      for (const a of s.accounts) secrets.delete(a.secretRef);
      if (s.localCredentialRef) secrets.delete(s.localCredentialRef);
      state.mutate((x) => {
        const fresh = defaultState();
        x.accounts = fresh.accounts;
        x.routes = fresh.routes;
        x.localCredentialRef = null;
      });
      console.log("router state reset (secrets deleted); journal db left in place");
      return 0;
    }
    default:
      throw new Error(`unknown command '${cmd}'\n${USAGE}`);
  }
}

main(Bun.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
