import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scaffoldConnectConnection, scaffoldTokenConnection, mcpAdd } from "../src/mcp-add.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "deskmate-mcpadd-"));
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const spec = {
  name: "vercel",
  connector: "vercel/deskmate",
  service: "mcp.vercel.com",
  url: "https://mcp.vercel.com",
  description: "Vercel (read-only).",
  tools: ["list_deployments"],
};

describe("scaffoldConnectConnection", () => {
  it("writes an app-scoped connect() connection file", () => {
    scaffoldConnectConnection(spec, dir);
    const file = join(dir, "connections", "vercel.ts");
    expect(existsSync(file)).toBe(true);
    const src = readFileSync(file, "utf8");
    expect(src).toContain('import { connect } from "@vercel/connect/eve";');
    expect(src).toContain('auth: connect({ connector: "vercel/deskmate", principalType: "app" })');
  });

  it("appends a { kind:'mcp', connect, service } entry to deskmate.config.ts", () => {
    const cfg = join(dir, "deskmate.config.ts");
    writeFileSync(
      cfg,
      `import { defineTeam } from "@deskmate/core";\nexport default defineTeam({\n  connections: {\n  },\n  deskmates: {},\n});\n`,
    );
    scaffoldConnectConnection(spec, dir);
    const src = readFileSync(cfg, "utf8");
    expect(src).toContain("vercel: {");
    expect(src).toContain('kind: "mcp"');
    expect(src).toContain('connect: "vercel/deskmate"');
    expect(src).toContain('service: "mcp.vercel.com"');
  });

  it("omits `service` from the config entry when it is empty", () => {
    const cfg = join(dir, "deskmate.config.ts");
    writeFileSync(
      cfg,
      `import { defineTeam } from "@deskmate/core";\nexport default defineTeam({\n  connections: {\n  },\n  deskmates: {},\n});\n`,
    );
    scaffoldConnectConnection({ ...spec, service: "" }, dir);
    const src = readFileSync(cfg, "utf8");
    expect(src).toContain('connect: "vercel/deskmate"');
    expect(src).not.toContain("service:");
  });

  it("never clobbers an existing connection file", () => {
    scaffoldConnectConnection(spec, dir); // creates connections/vercel.ts
    const file = join(dir, "connections", "vercel.ts");
    writeFileSync(file, "// hand-edited\n");
    scaffoldConnectConnection(spec, dir); // second call must skip
    expect(readFileSync(file, "utf8")).toBe("// hand-edited\n");
  });
});

describe("scaffoldTokenConnection", () => {
  it("bearer scaffold writes an auth.getToken connection file + { kind:'mcp', env } config entry", () => {
    const cfg = join(dir, "deskmate.config.ts");
    writeFileSync(cfg, `import { defineTeam } from "@deskmate/core";\nexport default defineTeam({\n  connections: {\n  },\n  deskmates: {},\n});\n`);
    scaffoldTokenConnection({ name: "acme", urlEnv: "ACME_MCP_URL", tokenEnv: "ACME_MCP_TOKEN", description: "Acme.", tools: ["search"] }, dir);
    const src = readFileSync(join(dir, "connections", "acme.ts"), "utf8");
    expect(src).toContain('auth: { getToken: async () => ({ token: process.env["ACME_MCP_TOKEN"] || "" }) }');
    expect(readFileSync(cfg, "utf8")).toContain("env: \"ACME\"");
  });

  it("basic scaffold writes an Authorization: Basic header file", () => {
    scaffoldTokenConnection({ name: "lf", urlEnv: "LF_MCP_URL", tokenEnv: "LF_MCP_TOKEN", description: "Langfuse.", tools: [], scheme: "basic" }, dir);
    const src = readFileSync(join(dir, "connections", "lf.ts"), "utf8");
    expect(src).toContain('Basic ${Buffer.from(process.env["LF_MCP_TOKEN"] || "").toString("base64")}');
  });

  it("custom-header scaffold uses the given header name", () => {
    scaffoldTokenConnection({ name: "docs", urlEnv: "DOCS_MCP_URL", tokenEnv: "DOCS_MCP_TOKEN", description: "Docs.", tools: [], scheme: "custom-header", headerName: "X-Api-Key" }, dir);
    const src = readFileSync(join(dir, "connections", "docs.ts"), "utf8");
    expect(src).toContain('"X-Api-Key": process.env["DOCS_MCP_TOKEN"] || ""');
  });

  it("github-app scaffold writes a core-backed getToken file (no _MCP_TOKEN) and still wires a { kind:'mcp', env } entry", () => {
    const cfg = join(dir, "deskmate.config.ts");
    writeFileSync(cfg, `import { defineTeam } from "@deskmate/core";\nexport default defineTeam({\n  connections: {\n  },\n  deskmates: {},\n});\n`);
    scaffoldTokenConnection(
      { name: "githubwrite", urlEnv: "GITHUBWRITE_MCP_URL", tokenEnv: "GITHUBWRITE_MCP_TOKEN", description: "GitHub write.", tools: ["issue_write"], scheme: "github-app" },
      dir,
    );
    const src = readFileSync(join(dir, "connections", "githubwrite.ts"), "utf8");
    expect(src).toContain('import { getInstallationToken, readGithubAppEnv } from "@deskmate/core/coding";');
    expect(src).toContain("getInstallationToken(");
    // App auth — never a bearer _MCP_TOKEN in the generated file.
    expect(src).not.toContain('process.env["GITHUBWRITE_MCP_TOKEN"]');
    // The URL still drives a { kind:"mcp", env } config entry like every other scheme.
    expect(readFileSync(cfg, "utf8")).toContain('env: "GITHUBWRITE"');
  });

  it("never clobbers an existing token connection file", () => {
    scaffoldTokenConnection({ name: "acme", urlEnv: "ACME_MCP_URL", tokenEnv: "ACME_MCP_TOKEN", description: "d", tools: [] }, dir);
    const file = join(dir, "connections", "acme.ts");
    writeFileSync(file, "// hand-edited\n");
    scaffoldTokenConnection({ name: "acme", urlEnv: "ACME_MCP_URL", tokenEnv: "ACME_MCP_TOKEN", description: "d", tools: [] }, dir);
    expect(readFileSync(file, "utf8")).toBe("// hand-edited\n");
  });
});

// `mcpAdd` validates the name BEFORE any interactive prompt, so these reject without
// touching stdin. deskmate's snake_case and eve's kebab-case connection-filename rules
// have no multi-word overlap, so both a dash- and an underscore-separated name must fail
// fast at add time (with a message that names the eve/sync conflict) rather than at deploy.
describe("mcpAdd — connection-name validation (eve ∩ sync intersection)", () => {
  it("rejects a kebab-case name (dashes) with a message that names the eve build conflict", async () => {
    await expect(mcpAdd(["github-write"], dir)).rejects.toThrow(/single lowercase word/);
    await expect(mcpAdd(["github-write"], dir)).rejects.toThrow(/eve build/);
  });

  it("rejects a snake_case multi-word name (underscores) before it can fail at eve build", async () => {
    await expect(mcpAdd(["github_write"], dir)).rejects.toThrow(/single lowercase word/);
  });
});
