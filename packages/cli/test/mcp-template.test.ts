import { describe, it, expect } from "vitest";
import { renderMcpConnection, renderConnectConnection } from "../src/lib/mcp-template.js";

describe("renderMcpConnection", () => {
  it("renders a read-only, env-token connection from options", () => {
    const out = renderMcpConnection({
      name: "datadog",
      urlEnv: "DATADOG_MCP_URL",
      tokenEnv: "DATADOG_MCP_TOKEN",
      description: "Read-only Datadog: search logs and monitors.",
      tools: ["search_logs", "get_monitor"],
    });
    expect(out).toContain('import { defineMcpClientConnection } from "eve/connections";');
    expect(out).toContain("process.env[\"DATADOG_MCP_URL\"] || \"https://example.invalid/mcp\"");
    expect(out).toContain("process.env[\"DATADOG_MCP_TOKEN\"] || \"\"");
    expect(out).toContain('tools: { allow: ["search_logs", "get_monitor"] }');
    expect(out).toContain("Read-only Datadog: search logs and monitors.");
  });

  it("renders an empty allow-list when no tools are given", () => {
    const out = renderMcpConnection({
      name: "x", urlEnv: "X_MCP_URL", tokenEnv: "X_MCP_TOKEN", description: "d", tools: [],
    });
    expect(out).toContain("tools: { allow: [] }");
  });

  it("uses || (not ??) for the URL fallback so an empty-string env still falls back", () => {
    const src = renderMcpConnection({
      name: "acme", urlEnv: "ACME_MCP_URL", tokenEnv: "ACME_MCP_TOKEN",
      description: "Acme.", tools: ["search"],
    });
    expect(src).toContain('process.env["ACME_MCP_URL"] || "https://example.invalid/mcp"');
    expect(src).not.toContain('?? "https://example.invalid/mcp"');
  });

  it("bearer scheme (default) emits auth.getToken with a Bearer token", () => {
    const src = renderMcpConnection({
      name: "acme", urlEnv: "ACME_MCP_URL", tokenEnv: "ACME_MCP_TOKEN",
      description: "Acme.", tools: ["search"],
    });
    expect(src).toContain('auth: { getToken: async () => ({ token: process.env["ACME_MCP_TOKEN"] || "" }) }');
    expect(src).not.toContain("headers:");
  });

  it("basic scheme base64-encodes the token env (plaintext pk:sk) into an Authorization: Basic header", () => {
    const src = renderMcpConnection({
      name: "lf", urlEnv: "LF_MCP_URL", tokenEnv: "LF_MCP_TOKEN",
      description: "Langfuse.", tools: ["traces"], scheme: "basic",
    });
    expect(src).toContain('Basic ${Buffer.from(process.env["LF_MCP_TOKEN"] || "").toString("base64")}');
    expect(src).toContain("headers: {");
    expect(src).not.toContain("auth:");
    expect(src).toContain("Set LF_MCP_URL + LF_MCP_TOKEN"); // hint names the URL env too, not just the token
  });

  it("custom-header scheme sends the token under the named header", () => {
    const src = renderMcpConnection({
      name: "docs", urlEnv: "DOCS_MCP_URL", tokenEnv: "DOCS_MCP_TOKEN",
      description: "Docs.", tools: ["search"], scheme: "custom-header", headerName: "X-Api-Key",
    });
    expect(src).toContain('"X-Api-Key": process.env["DOCS_MCP_TOKEN"] || ""');
    expect(src).toContain("headers: {");
    expect(src).toContain("Set DOCS_MCP_URL + DOCS_MCP_TOKEN"); // hint names the URL env too
  });

  it("custom-header scheme defaults the header name to X-Api-Key when none is given", () => {
    const src = renderMcpConnection({
      name: "docs", urlEnv: "DOCS_MCP_URL", tokenEnv: "DOCS_MCP_TOKEN",
      description: "Docs.", tools: ["search"], scheme: "custom-header",
    });
    expect(src).toContain('"X-Api-Key": process.env["DOCS_MCP_TOKEN"] || ""');
  });

  it("custom-header scheme falls back to X-Api-Key when the header name is not a valid HTTP token", () => {
    const src = renderMcpConnection({
      name: "docs", urlEnv: "DOCS_MCP_URL", tokenEnv: "DOCS_MCP_TOKEN",
      description: "Docs.", tools: ["search"], scheme: "custom-header", headerName: "bad\nname",
    });
    expect(src).toContain('"X-Api-Key": process.env["DOCS_MCP_TOKEN"] || ""');
    expect(src).not.toContain("bad\nname"); // the newline-bearing name never reaches the output
  });
});

describe("renderMcpConnection — github-app scheme", () => {
  it("mints an installation token via @deskmate/core/coding instead of an env _MCP_TOKEN", () => {
    const src = renderMcpConnection({
      name: "github_write",
      urlEnv: "GITHUB_WRITE_MCP_URL",
      tokenEnv: "GITHUB_WRITE_MCP_TOKEN",
      description: "GitHub write (issues, comments).",
      tools: ["issue_write", "add_issue_comment"],
      scheme: "github-app",
    });
    // Pulls the App-auth helpers from core's public coding subpath.
    expect(src).toContain('import { getInstallationToken, readGithubAppEnv } from "@deskmate/core/coding";');
    // getToken brokers a fine-grained installation token from the App env.
    expect(src).toContain("getToken:");
    expect(src).toContain("getInstallationToken(");
    expect(src).toContain("readGithubAppEnv()");
    // Tool allow-list is rendered like every other scheme.
    expect(src).toContain('tools: { allow: ["issue_write", "add_issue_comment"] }');
    // App auth — NEVER a bearer _MCP_TOKEN.
    expect(src).not.toContain('process.env["GITHUB_WRITE_MCP_TOKEN"]');
    // The .env.example-style hint points at the GitHub App vars, not a _MCP_TOKEN.
    expect(src).toContain("GITHUB_APP_ID");
    expect(src).not.toContain("GITHUB_WRITE_MCP_TOKEN");
    // The committed header comment must be accurate: App-authed, NOT "Read-only, env-token".
    expect(src).toContain("// Generated by `deskmate mcp-add`. App-authed (mints a GitHub App installation token).");
    expect(src).not.toContain("Read-only, env-token");
  });

  it("does not disturb bearer output (the default scheme stays byte-identical)", () => {
    const src = renderMcpConnection({
      name: "acme", urlEnv: "ACME_MCP_URL", tokenEnv: "ACME_MCP_TOKEN",
      description: "Acme.", tools: ["search"],
    });
    expect(src).toContain('auth: { getToken: async () => ({ token: process.env["ACME_MCP_TOKEN"] || "" }) }');
    expect(src).not.toContain("@deskmate/core/coding");
    // Env-token schemes keep the original header verbatim.
    expect(src).toContain("// Generated by `deskmate mcp-add`. Read-only, env-token (single-deployment).");
  });
});

describe("renderConnectConnection", () => {
  it("renders an app-scoped Vercel Connect connection", () => {
    const out = renderConnectConnection({
      name: "vercel",
      connector: "vercel/deskmate",
      url: "https://mcp.vercel.com",
      description: "Vercel projects, deployments, and logs (read-only).",
      tools: ["list_deployments", "get_deployment"],
    });
    expect(out).toContain('import { connect } from "@vercel/connect/eve";');
    expect(out).toContain('import { defineMcpClientConnection } from "eve/connections";');
    expect(out).toContain('url: "https://mcp.vercel.com"');
    expect(out).toContain('auth: connect({ connector: "vercel/deskmate", principalType: "app" })');
    expect(out).toContain('tools: { allow: ["list_deployments", "get_deployment"] }');
    expect(out).not.toContain("process.env");
    expect(out).not.toContain("getToken");
  });

  it("renders an empty allow-list when no tools are given", () => {
    const out = renderConnectConnection({
      name: "x", connector: "x/deskmate", url: "https://mcp.x.com", description: "d", tools: [],
    });
    expect(out).toContain("tools: { allow: [] }");
  });
});
