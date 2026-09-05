import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadTeam as realLoadTeam } from "./lib/load-config.js";
import { probeMcp } from "./lib/mcp-probe.js";
import { getInstallationToken, readGithubAppEnv } from "@deskmate/core/coding";
import type { TeamConfig } from "@deskmate/core";
import type { ProbeResult } from "./lib/mcp-probe.js";

export type ResolvedConn =
  | { kind: "not-found" }
  | { kind: "unconfigured"; url: string }
  | { kind: "error"; message: string } // the authored file couldn't be imported (syntax error, bad definition, …)
  | { kind: "ready"; url: string; headers: Record<string, string>; allow: string[] };

export interface DoctorDeps {
  loadTeam: (cwd: string) => Promise<TeamConfig>;
  resolveConnection: (name: string, cwd: string) => Promise<ResolvedConn>;
  probe: (url: string, headers: Record<string, string>) => Promise<ProbeResult>;
  /** Load the pulled Vercel env into process.env; returns the file loaded, or null. */
  loadEnv: (cwd: string) => string | null;
  /**
   * Best-effort: verify the GitHub App can mint an install token for a coding org,
   * scoped to `repositoryNames` when given (matches the repo-scoped token the sandbox
   * / PR tool mint at runtime, so a repo-selective install that can't reach an exact
   * allowlisted repo is caught here rather than at runtime).
   */
  checkCodingAuth: (org: string, repositoryNames?: string[]) => Promise<{ ok: boolean; error?: string }>;
}

/**
 * Best-effort: load the pulled Vercel env into `process.env` so doctor checks the REAL
 * production env. `vercel env pull` only WRITES `.vercel/.env.production.local`; a fresh
 * `deskmate doctor` process wouldn't otherwise see it, so every connection would read as
 * `example.invalid` and the gate would pass green having probed nothing. Loads the first
 * file that exists (production first). An already-set shell var wins over the file (Node's
 * `loadEnvFile` doesn't override), so exports still take precedence. Returns the file it
 * loaded, or null. No-op if none exist or the runtime lacks `process.loadEnvFile`.
 */
export function loadLocalEnv(cwd: string): string | null {
  const load = (process as { loadEnvFile?: (p: string) => void }).loadEnvFile;
  if (typeof load !== "function") return null;
  const candidates = [
    join(cwd, ".vercel", ".env.production.local"),
    join(cwd, ".env.local"),
    join(cwd, ".env"),
  ];
  for (const f of candidates) {
    if (existsSync(f)) {
      try {
        load(f);
        return f;
      } catch (err) {
        // A malformed env file would otherwise silently leave doctor checking an
        // unloaded env — say which file failed and why, then fall through to the next
        // candidate (a bad .vercel/.env.production.local shouldn't block a valid .env).
        console.warn(`⚠ could not load env from ${f}: ${err instanceof Error ? err.message : String(err)} — trying the next candidate.`);
      }
    }
  }
  return null;
}

/**
 * The env keys a pulled Vercel env file wrote EMPTY, which means Vercel could not give
 * us the value rather than that no value exists.
 *
 * Vercel env vars typed `sensitive` are write-only: `vercel env pull` lists the key and
 * writes `KEY=""`. Doctor then loads that file, reads an empty string, and would report
 * a perfectly healthy production variable as unset. Treat these as "cannot check from
 * here" instead, the same way an OAuth connection whose credential resolves at runtime
 * is reported.
 *
 * A key the user really did set to an empty string lands here too. The outcome is the
 * same either way: this machine cannot verify it.
 */
export function sensitiveEnvKeys(file: string | null): Set<string> {
  const keys = new Set<string>();
  // ONLY the Vercel pulled file carries the write-only signature. In a hand-authored
  // `.env` or `.env.local` an empty value means the author left it empty, which is a
  // real misconfiguration and must keep failing.
  if (!file || basename(file) !== ".env.production.local" || basename(dirname(file)) !== ".vercel") return keys;
  if (!existsSync(file)) return keys;
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return keys; // unreadable env file is already reported by loadLocalEnv
  }
  for (const line of raw.split(/\r?\n/u)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u.exec(line);
    if (!m) continue;
    const value = m[2]!.trim().replace(/^(["'])(.*)\1$/u, "$2");
    if (value === "") keys.add(m[1]!);
  }
  return keys;
}

/**
 * Locate the authored connection file with the SAME precedence `deskmate sync` uses
 * (see sync/plan.ts): deskmate-local `roles/<role>/connections/<name>.ts` FIRST, then
 * shared `connections/<name>.ts`. Matching the order matters — when a role-local file
 * shadows a shared one of the same name, sync deploys the role-local file, so doctor
 * must probe that same file or it validates something the deploy never runs.
 *
 * Known limitation: doctor validates ONE authored file per connection *name*. `sync`
 * resolves per deskmate's role, so if the same name resolves to different files for
 * different deskmates (a shared file for some, a role-local override for others, or
 * distinct overrides across roles) only the first — role-local, then alphabetical — is
 * probed; the other deployed variants aren't verified. The one-file-per-name catalog
 * layout doesn't hit this; full per-deskmate coverage is a possible follow-up.
 */
export function findConnectionFile(name: string, cwd: string): string | null {
  const rolesDir = join(cwd, "roles");
  if (existsSync(rolesDir)) {
    // Sort for a deterministic pick when >1 role has a same-named connection file —
    // raw readdir order varies by filesystem/platform.
    for (const id of readdirSync(rolesDir).sort()) {
      const p = join(rolesDir, id, "connections", `${name}.ts`);
      if (existsSync(p)) return p;
    }
  }
  const shared = join(cwd, "connections", `${name}.ts`);
  if (existsSync(shared)) return shared;
  return null;
}

/** Import the authored file and resolve URL + outgoing headers as the runtime would. */
async function resolveConnectionReal(name: string, cwd: string): Promise<ResolvedConn> {
  const file = findConnectionFile(name, cwd);
  if (!file) return { kind: "not-found" };
  // A broken connection file (syntax error, a definition eve rejects at import) is
  // itself a misconfig doctor should surface — catch it so one bad file becomes a
  // reported failure for THIS connection, not an uncaught reject that aborts the run
  // (mirrors loadTeam's guarded import). Needs Node ≥23.6 type-stripping either way.
  let def: any;
  try {
    const mod = (await import(pathToFileURL(file).href)) as { default?: any };
    def = mod.default ?? {};
  } catch (err) {
    return { kind: "error", message: err instanceof Error ? err.message : String(err) };
  }

  const url: string = typeof def.url === "string" ? def.url : "";
  const allow: string[] = Array.isArray(def.tools?.allow) ? def.tools.allow : [];

  const headers: Record<string, string> = {};
  if (def.headers && typeof def.headers === "object" && typeof def.headers !== "function") {
    for (const [k, v] of Object.entries(def.headers)) {
      if (typeof v === "string") headers[k] = v;
      else if (v && typeof (v as any).then === "function") headers[k] = String(await v);
      // function-valued headers need a session ctx — skip; the probe reports the gap.
    }
  }
  if (def.auth && typeof def.auth.getToken === "function") {
    try {
      const { token } = await def.auth.getToken();
      if (token) headers["Authorization"] = `Bearer ${token}`;
    } catch {
      // getToken that needs a runtime ctx (e.g. connect()) — leave unauthenticated.
    }
  }

  if (!url || url.includes("example.invalid")) return { kind: "unconfigured", url: url || "(none)" };
  return { kind: "ready", url, headers, allow };
}

/**
 * Best-effort GitHub App readiness for a coding org: env present, then actually mint
 * an installation token (which also proves the App is installed on the org and the
 * private key parses). Never throws — a failure is reported, not fatal.
 */
async function checkCodingAuthReal(org: string, repositoryNames?: string[]): Promise<{ ok: boolean; error?: string }> {
  const env = readGithubAppEnv();
  if (!env.present) return { ok: false, error: "set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY" };
  try {
    // Request the SAME write permissions the PR tool uses at runtime — GitHub errors
    // when you request permissions the installation wasn't granted, so a read-only App
    // install fails here rather than on the first approved PR.
    await getInstallationToken({
      appId: env.appId,
      privateKey: env.privateKey,
      org,
      repositoryNames,
      permissions: { contents: "write", pull_requests: "write" },
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

const defaultDeps: DoctorDeps = {
  loadTeam: realLoadTeam,
  resolveConnection: resolveConnectionReal,
  probe: (url, headers) => probeMcp(url, headers),
  loadEnv: loadLocalEnv,
  checkCodingAuth: checkCodingAuthReal,
};

const ok = (s: string) => console.log(`  ✓ ${s}`);
const warn = (s: string) => console.log(`  ⚠ ${s}`);
const bad = (s: string) => console.log(`  ✗ ${s}`);

/**
 * `deskmate doctor` (alias `check`): validate every configured MCP connection against
 * its real server before deploy. Run after `vercel env pull` so the local env matches
 * production. Exit 1 if any token connection is broken (unreachable / auth fail /
 * an allowed tool the server doesn't expose). not-found / unconfigured / oauth are
 * warnings — a scaffolded-but-not-yet-wired connection is a normal state.
 */
export async function doctor(_args: string[] = [], cwd: string = process.cwd(), deps: DoctorDeps = defaultDeps): Promise<number> {
  // Load the pulled prod env BEFORE importing any connection file (their headers/tokens
  // read process.env at import/getToken time). Without this, doctor's own documented
  // `vercel env pull` → `deskmate doctor` flow would check an empty env and no-op.
  const envFile = deps.loadEnv(cwd);
  if (envFile) console.log(`Checking against env from ${envFile}`);
  // Vercel `sensitive` vars pull as empty. Reporting them as unset is a false failure,
  // so every check below downgrades them to a warning rather than counting them.
  const unreadable = sensitiveEnvKeys(envFile);
  // A key is only unverifiable when the pull could not give us a value AND nothing in
  // the shell supplies one. `loadLocalEnv` never overrides an exported var, so an
  // export is the effective credential and a failure against it is a real failure.
  const unverifiable = (key: string): boolean => !process.env[key] && unreadable.has(key);

  const team = await deps.loadTeam(cwd);
  const names = Object.keys(team.connections);
  let failures = 0;

  if (names.length === 0) {
    console.log("No connections configured.");
  }
  for (const name of names) {
    const conn = team.connections[name]!;
    console.log(`\n${name}:`);

    if (conn.connect) {
      warn(`oauth (Vercel Connect: ${conn.connect}) — credential resolved at runtime; not checked here.`);
      continue;
    }

    // The env prefix for guidance messages. `env` is always set for token connections
    // the CLI writes; fall back to the mcp-add default derivation so a hand-authored
    // `{ kind:"mcp" }` with neither `env` nor `connect` never prints `undefined_MCP_URL`.
    const prefix = conn.env ?? name.toUpperCase().replace(/[^A-Z0-9]/g, "_");

    // A thrown resolveConnection (e.g. a custom dep) must not abort the whole run.
    let resolved: ResolvedConn;
    try {
      resolved = await deps.resolveConnection(name, cwd);
    } catch (err) {
      bad(`could not read the connection file: ${err instanceof Error ? err.message : String(err)}`);
      failures++;
      continue;
    }
    if (resolved.kind === "not-found") {
      warn(`no authored connection file — run \`deskmate mcp-add ${name}\`.`);
      continue;
    }
    if (resolved.kind === "error") {
      bad(`connection file failed to load: ${resolved.message}`);
      failures++;
      continue;
    }
    if (resolved.kind === "unconfigured") {
      warn(`not configured (${resolved.url}) — set ${prefix}_MCP_URL / ${prefix}_MCP_TOKEN.`);
      continue;
    }

    // The connection file is resolved and valid by here, so only the credential-dependent
    // probe is skipped. A broken or missing file is still diagnosed above.
    if (unverifiable(`${prefix}_MCP_TOKEN`)) {
      warn(`${prefix}_MCP_TOKEN is a Vercel sensitive variable, so it pulls empty and cannot be checked here. Verify in production.`);
      continue;
    }

    const r = await deps.probe(resolved.url, resolved.headers);
    if (!r.reachable) {
      bad(`unreachable: ${r.error ?? "no response"}`);
      failures++;
      continue;
    }
    if (!r.authOk) {
      bad(`auth failed${r.status ? ` (HTTP ${r.status})` : ""} — check ${prefix}_MCP_TOKEN.`);
      failures++;
      continue;
    }
    // Authed but tools/list errored or truncated (HTTP/parse/transport, or the page
    // cap) — the tool set is unreliable, so the allow-list diff below can't be trusted.
    // Fail rather than pass green on an unverified connection.
    if (r.error) {
      bad(`authed, but listing tools failed (${r.error}) — can't verify the allow-list.`);
      failures++;
      continue;
    }
    ok(`reachable + authed (${r.tools?.length ?? 0} tools on server)`);

    const missing = resolved.allow.filter((t) => !(r.tools ?? []).includes(t));
    if (resolved.allow.length === 0) {
      warn("no tools.allow set — the model sees every server tool.");
    } else if (missing.length) {
      bad(`allow-list names tools the server does not expose: ${missing.join(", ")}`);
      failures++;
    } else {
      ok(`all ${resolved.allow.length} allowed tool(s) exist on the server.`);
    }
  }

  // GitHub App readiness — validate whenever the App is used: a coding deskmate OR the
  // root GitHub channel (a channel-only team has no coding deskmate but still needs the
  // App + webhook secret). Runs regardless of connections.
  const codingDeskmates = Object.entries(team.deskmates).filter(([, d]) => d.coding);
  const usesGithub = codingDeskmates.length > 0 || team.github?.channel === true;
  if (usesGithub) {
    console.log(`\nCoding / GitHub App:`);
    if (!team.github) {
      // defineTeam guarantees github when coding is set; defensive for a hand-built team.
      bad("coding is enabled but no `github` block is configured.");
      failures++;
    } else {
      // Check the SAME repo-scoped token the runtime mints (exact allowlist entries),
      // so a repo-selective App install that can't reach an allowlisted repo fails here
      // rather than at clone/PR time. Owner-glob entries stay org-level.
      const exactRepos = codingDeskmates
        .flatMap(([, d]) => d.coding!.repos)
        .filter((r) => !r.includes("*"))
        .map((r) => r.split("/")[1])
        .filter((n): n is string => Boolean(n));
      // Minting a token needs BOTH credentials, so either one being unreadable makes the
      // check impossible. Probing with a credential we know is empty only manufactures a
      // failure, so skip the call rather than reporting its guaranteed error.
      const appCreds = ["GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY"];
      const appUnverifiable = appCreds.filter(unverifiable);
      const res = appUnverifiable.length
        ? null
        : await deps.checkCodingAuth(team.github.org, exactRepos.length ? exactRepos : undefined);

      if (res === null) {
        warn(`${appUnverifiable.join(" and ")} ${appUnverifiable.length > 1 ? "are Vercel sensitive variables" : "is a Vercel sensitive variable"}, so the installation token cannot be checked here. Verify in production.`);
      } else if (res.ok) {
        ok(`GitHub App ready — can mint an installation token for ${team.github.org}.`);
        for (const [id, d] of codingDeskmates) {
          const repos = d.coding!.repos.length ? d.coding!.repos.join(", ") : `${team.github.org}/*`;
          ok(`${id}: coding enabled (repos: ${repos}).`);
        }
      } else {
        bad(`GitHub App not ready for ${team.github.org}: ${res.error}`);
        failures++;
      }

      // The channel variables are independent of the installation token: a missing slug
      // means every @mention is ignored, and a missing secret means every delivery fails
      // its signature check. Neither may hide behind an App credential we cannot read.
      if (team.github.channel) {
        if (process.env.GITHUB_WEBHOOK_SECRET) {
          ok("GitHub channel: webhook secret set.");
        } else if (unverifiable("GITHUB_WEBHOOK_SECRET")) {
          warn("GitHub channel: GITHUB_WEBHOOK_SECRET is a Vercel sensitive variable and cannot be checked here.");
        } else {
          bad("GitHub channel enabled but GITHUB_WEBHOOK_SECRET is not set — webhook deliveries will fail signature checks.");
          failures++;
        }
        if (process.env.GITHUB_APP_SLUG) {
          ok("GitHub channel: app slug set (mention dispatch).");
        } else if (unverifiable("GITHUB_APP_SLUG")) {
          warn("GitHub channel: GITHUB_APP_SLUG is a Vercel sensitive variable and cannot be checked here.");
        } else {
          bad("GitHub channel enabled but GITHUB_APP_SLUG is not set — the channel will ignore all @mentions.");
          failures++;
        }
      }
      if (res?.ok && codingDeskmates.length > 0) {
        warn("pushing needs the Vercel backend (local Docker can't broker the token); protect your default branch.");
      }
    }
  }

  console.log(failures ? `\n✗ ${failures} check(s) need attention.` : "\n✓ all checks healthy.");
  return failures ? 1 : 0;
}
