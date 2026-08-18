import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { renderMcpConnection, renderConnectConnection } from "./lib/mcp-template.js";
import { appendConnectionEntry, renderEntry } from "./config-file.js";
import { CONFIG_FILE, editConfig } from "./add.js";
import { isValidConnectionName, connectionNameError } from "./lib/ids.js";

/**
 * Run `fn` with an `ask(question, fallback)` helper. Buffers stdin lines so it
 * works for both interactive and piped (`printf … | …`) input, falling back to
 * each prompt's default when input runs out.
 */
async function withPrompts<T>(
  fn: (ask: (q: string, fallback?: string) => Promise<string>) => Promise<T>,
): Promise<T> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const buffered: string[] = [];
  const waiting: Array<(line: string | null) => void> = [];
  let closed = false;
  rl.on("line", (line) => {
    const next = waiting.shift();
    if (next) next(line);
    else buffered.push(line);
  });
  rl.on("close", () => {
    closed = true;
    for (const next of waiting.splice(0)) next(null);
  });
  const nextLine = (): Promise<string | null> => {
    if (buffered.length) return Promise.resolve(buffered.shift() ?? null);
    if (closed) return Promise.resolve(null);
    return new Promise((resolve) => waiting.push(resolve));
  };
  const ask = async (q: string, fallback?: string) => {
    process.stdout.write(fallback ? `${q} [${fallback}]: ` : `${q}: `);
    const a = ((await nextLine()) ?? "").trim();
    return a || fallback || "";
  };
  try {
    return await fn(ask);
  } finally {
    rl.close();
  }
}

/**
 * Scaffold an app-scoped OAuth (Vercel Connect) MCP connection: write
 * `./connections/<name>.ts` and append a `{ kind:"mcp", connect, service }` entry
 * to `./deskmate.config.ts`. Never clobbers an existing connection file.
 */
export function scaffoldConnectConnection(
  spec: { name: string; connector: string; service: string; url: string; description: string; tools: string[] },
  cwd: string,
): void {
  const file = join(cwd, "connections", `${spec.name}.ts`);
  if (existsSync(file)) {
    console.log(`• ${spec.name}: connections/${spec.name}.ts already exists, skipping (edit it directly, or remove it first)`);
    return;
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, renderConnectConnection(spec));
  console.log(`✓ created connections/${spec.name}.ts`);

  const entry = { kind: "mcp", connect: spec.connector, service: spec.service || undefined };
  editConfig(
    cwd,
    spec.name,
    (s) => appendConnectionEntry(s, spec.name, entry),
    renderEntry(spec.name, entry),
    `${spec.name}: already in connections`,
  );
  console.log(`  provision it with \`deskmate connect ${spec.name}\`.`);
  console.log("  the generated file imports @vercel/connect — install it in this app if it isn't already: `pnpm add @vercel/connect`.");
}

/**
 * Scaffold a read-only, env-token MCP connection: write `./connections/<name>.ts`
 * and append a `{ kind:"mcp", env }` entry to `./deskmate.config.ts`. Never clobbers
 * an existing connection file. `scheme`/`headerName` pick how the token becomes a
 * header (bearer/basic/custom-header); they only affect the rendered file.
 */
export function scaffoldTokenConnection(
  spec: {
    name: string;
    urlEnv: string;
    tokenEnv: string;
    description: string;
    tools: string[];
    scheme?: "bearer" | "basic" | "custom-header" | "github-app";
    headerName?: string;
  },
  cwd: string,
): void {
  const { name, urlEnv, tokenEnv, description, tools, scheme, headerName } = spec;
  const file = join(cwd, "connections", `${name}.ts`);
  // Never clobber an existing connection — a consumer may have hand-edited its
  // auth/URL/tool-allow-list. Skip (and don't touch the config) if it's there.
  if (existsSync(file)) {
    console.log(
      `• ${name}: connections/${name}.ts already exists, skipping (edit it directly, or remove it first)`,
    );
    return;
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, renderMcpConnection({ name, urlEnv, tokenEnv, description, tools, scheme, headerName }));
  console.log(`✓ created connections/${name}.ts`);

  // The config connection entry: kind:"mcp" + the env prefix. The prefix is only
  // well-defined when the two env var names have the `<PREFIX>_MCP_URL` /
  // `<PREFIX>_MCP_TOKEN` shape and share one prefix; otherwise deriving it would
  // silently emit a wrong `env`, so skip the config entry and say so.
  const urlPrefix = urlEnv.endsWith("_MCP_URL") ? urlEnv.slice(0, -"_MCP_URL".length) : null;
  const tokenPrefix = tokenEnv.endsWith("_MCP_TOKEN") ? tokenEnv.slice(0, -"_MCP_TOKEN".length) : null;
  if (!urlPrefix || !tokenPrefix || urlPrefix !== tokenPrefix) {
    console.error(
      `✗ env var names must be <PREFIX>_MCP_URL + <PREFIX>_MCP_TOKEN sharing one prefix ` +
        `(got ${urlEnv} + ${tokenEnv}). Skipped the connections.${name} config entry — ` +
        `add it to ${CONFIG_FILE} by hand once the names line up.`,
    );
    process.exitCode = 1;
    return;
  }
  const entry = { kind: "mcp", env: urlPrefix };
  editConfig(
    cwd,
    name,
    (s) => appendConnectionEntry(s, name, entry),
    renderEntry(name, entry),
    `${name}: already in connections`,
  );
  console.log(`  set ${urlEnv} + ${tokenEnv} in your env, then run \`deskmate sync\`.`);
}

/**
 * `deskmate mcp-add <name>`: scaffold a read-only, env-token MCP connection into
 * the consumer-local `./connections/<name>.ts`, and append a `connections.<name>`
 * entry to `./deskmate.config.ts` (or print it if the config can't be edited).
 */
export async function mcpAdd(args: string[], cwd: string = process.cwd()): Promise<void> {
  const name = args[0];
  if (!name) throw new Error("usage: deskmate mcp-add <name>");
  // Connection names must satisfy BOTH deskmate's snake_case rule AND eve's kebab-case
  // connection-filename rule — i.e. a single lowercase word (no dashes, no underscores).
  // Reject anything else here with a message that names the eve conflict, so a name like
  // `github-write`/`github_write` fails at add time instead of silently at `eve build`.
  if (!isValidConnectionName(name)) {
    throw new Error(connectionNameError(name));
  }
  const upper = name.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  await withPrompts(async (ask) => {
    const mode = (await ask("Auth [token/oauth]", "token")).toLowerCase();
    if (mode === "oauth") {
      const url = await ask("MCP URL", `https://mcp.${name}.com`);
      let serviceDefault = "";
      try { serviceDefault = new URL(url).host; } catch { serviceDefault = ""; }
      const service = await ask("Connect service id", serviceDefault);
      // The connector UID is `<service>/<name>` — the shape `vercel connect create
      // <service> --name <name>` mints. Deriving it from `service` keeps the config,
      // the generated connection file, and `deskmate connect` in agreement.
      const connector = await ask("Connector UID", service ? `${service}/deskmate` : `${name}/deskmate`);
      const description = await ask("Description (for the model)", `${name} (OAuth MCP).`);
      const toolsRaw = await ask("Read tools (comma-separated)", "");
      const tools = toolsRaw.split(",").map((t) => t.trim()).filter(Boolean);
      scaffoldConnectConnection({ name, connector, service, url, description, tools }, cwd);
      return;
    }
    // ── token path ─────────────────────────────────────────────────────────
    const urlEnv = await ask("URL env var", `${upper}_MCP_URL`);
    // Ask the scheme before the token env: `github-app` has no <PREFIX>_MCP_TOKEN to
    // prompt for (it mints an installation token from GITHUB_APP_* at call time).
    const rawScheme = (await ask("Token scheme [bearer/basic/custom-header/github-app]", "bearer")).toLowerCase();
    const scheme =
      rawScheme === "basic" || rawScheme === "custom-header" || rawScheme === "github-app"
        ? rawScheme
        : "bearer";
    // github-app: skip the token-env prompt. The <PREFIX> is still derived from the
    // URL env's default so the { kind:"mcp", env } config entry stays well-formed; the
    // value never appears in the generated github-app file.
    const tokenEnv =
      scheme === "github-app" ? `${upper}_MCP_TOKEN` : await ask("Token env var", `${upper}_MCP_TOKEN`);
    const description = await ask("Description (for the model)", `Read-only ${name} MCP.`);
    const toolsRaw = await ask("Read tools (comma-separated)", "");
    const tools = toolsRaw.split(",").map((t) => t.trim()).filter(Boolean);
    const headerName = scheme === "custom-header" ? await ask("Header name", "X-Api-Key") : undefined;
    if (scheme === "basic") {
      console.log(`  basic auth: set ${tokenEnv} to plaintext "publicKey:secretKey" (it gets base64-encoded).`);
    }
    if (scheme === "github-app") {
      console.log(`  github-app auth: set GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY / GITHUB_APP_ORG (no ${tokenEnv} needed).`);
    }
    scaffoldTokenConnection({ name, urlEnv, tokenEnv, description, tools, scheme, headerName }, cwd);
  });
}
