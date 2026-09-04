import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doctor, loadLocalEnv, sensitiveEnvKeys, findConnectionFile, type DoctorDeps } from "../src/doctor.js";

beforeEach(() => vi.spyOn(console, "log").mockImplementation(() => {}));
afterEach(() => vi.restoreAllMocks());

const team = (connections: Record<string, any>) => ({ connections, deskmates: {}, channels: {} }) as any;

function deps(over: Partial<DoctorDeps>): DoctorDeps {
  return {
    loadTeam: async () => team({}),
    resolveConnection: async () => ({ kind: "not-found" }),
    probe: async () => ({ reachable: true, authOk: true, tools: [] }),
    loadEnv: () => null, // hermetic: never touch the real filesystem env in unit tests
    checkCodingAuth: async () => ({ ok: true }),
    ...over,
  };
}

describe("doctor", () => {
  it("exits 0 when a token connection is reachable, authed, and allow-list matches", async () => {
    const d = deps({
      loadTeam: async () => team({ good: { kind: "mcp", env: "GOOD" } }),
      resolveConnection: async () => ({ kind: "ready", url: "https://good/mcp", headers: { Authorization: "Bearer t" }, allow: ["search"] }),
      probe: async () => ({ reachable: true, authOk: true, tools: ["search", "extra"] }),
    });
    expect(await doctor([], "/proj", d)).toBe(0);
  });

  it("exits 1 when an allowed tool does not exist on the server", async () => {
    const d = deps({
      loadTeam: async () => team({ w: { kind: "mcp", env: "W" } }),
      resolveConnection: async () => ({ kind: "ready", url: "https://w/mcp", headers: {}, allow: ["missing_tool"] }),
      probe: async () => ({ reachable: true, authOk: true, tools: ["real_tool"] }),
    });
    expect(await doctor([], "/proj", d)).toBe(1);
  });

  it("exits 1 on an auth failure", async () => {
    const d = deps({
      loadTeam: async () => team({ good: { kind: "mcp", env: "GOOD" } }),
      resolveConnection: async () => ({ kind: "ready", url: "https://good/mcp", headers: {}, allow: [] }),
      probe: async () => ({ reachable: true, authOk: false, status: 401 }),
    });
    expect(await doctor([], "/proj", d)).toBe(1);
  });

  it("exits 1 when unreachable", async () => {
    const d = deps({
      loadTeam: async () => team({ good: { kind: "mcp", env: "GOOD" } }),
      resolveConnection: async () => ({ kind: "ready", url: "https://good/mcp", headers: {}, allow: [] }),
      probe: async () => ({ reachable: false, authOk: false, error: "ECONNREFUSED" }),
    });
    expect(await doctor([], "/proj", d)).toBe(1);
  });

  it("exits 1 when authed but tools/list errored — even with an empty allow-list (tools unverifiable)", async () => {
    const d = deps({
      loadTeam: async () => team({ good: { kind: "mcp", env: "GOOD" } }),
      resolveConnection: async () => ({ kind: "ready", url: "https://good/mcp", headers: {}, allow: [] }),
      probe: async () => ({ reachable: true, authOk: true, tools: [], error: "tools/list HTTP 500" }),
    });
    expect(await doctor([], "/proj", d)).toBe(1);
  });

  it("treats unconfigured / not-found / oauth as warnings (exit 0)", async () => {
    const d = deps({
      loadTeam: async () => team({
        blank: { kind: "mcp", env: "BLANK" },
        missing: { kind: "mcp", env: "MISSING" },
        oauthy: { kind: "mcp", connect: "svc/deskmate" },
      }),
      resolveConnection: async (name) =>
        name === "blank" ? { kind: "unconfigured", url: "https://example.invalid/mcp" } : { kind: "not-found" },
    });
    expect(await doctor([], "/proj", d)).toBe(0);
  });

  it("exits 0 when there are no connections", async () => {
    expect(await doctor([], "/proj", deps({ loadTeam: async () => team({}) }))).toBe(0);
  });

  it("exits 1 with a healthy connection alongside a broken one (order-independent)", async () => {
    const d = deps({
      loadTeam: async () => team({ good: { kind: "mcp", env: "GOOD" }, bad: { kind: "mcp", env: "BAD" } }),
      resolveConnection: async (name) => ({ kind: "ready", url: `https://${name}/mcp`, headers: {}, allow: name === "bad" ? ["missing"] : [] }),
      probe: async () => ({ reachable: true, authOk: true, tools: ["real"] }),
    });
    expect(await doctor([], "/proj", d)).toBe(1);
  });

  it("exits 1 (and keeps going) when a connection file fails to load", async () => {
    let checked = 0;
    const d = deps({
      loadTeam: async () => team({ broken: { kind: "mcp", env: "BROKEN" }, ok2: { kind: "mcp", env: "OK2" } }),
      resolveConnection: async (name) => {
        checked++;
        return name === "broken" ? { kind: "error", message: "SyntaxError: bad" } : { kind: "ready", url: "https://ok2/mcp", headers: {}, allow: [] };
      },
    });
    expect(await doctor([], "/proj", d)).toBe(1);
    expect(checked).toBe(2); // the broken file did NOT abort the run — ok2 was still checked
  });

  it("exits 1 (never rejects) when resolveConnection itself throws", async () => {
    const d = deps({
      loadTeam: async () => team({ boom: { kind: "mcp", env: "BOOM" } }),
      resolveConnection: async () => { throw new Error("import blew up"); },
    });
    await expect(doctor([], "/proj", d)).resolves.toBe(1);
  });
});

describe("doctor coding readiness", () => {
  const codingTeam = (over: Record<string, unknown> = {}) =>
    ({
      connections: {},
      github: { org: "acme" },
      deskmates: { engineer: { role: "engineer", coding: { repos: ["acme/*"] } } },
      channels: {},
      ...over,
    }) as any;

  it("exits 0 when the GitHub App can mint a token for the org", async () => {
    const d = deps({ loadTeam: async () => codingTeam(), checkCodingAuth: async () => ({ ok: true }) });
    expect(await doctor([], "/proj", d)).toBe(0);
  });

  it("exits 1 when the GitHub App can't mint a token (missing env / not installed)", async () => {
    const d = deps({
      loadTeam: async () => codingTeam(),
      checkCodingAuth: async () => ({ ok: false, error: "set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY" }),
    });
    expect(await doctor([], "/proj", d)).toBe(1);
  });

  it("exits 1 when coding is enabled but no github block is configured", async () => {
    const d = deps({ loadTeam: async () => codingTeam({ github: undefined }), checkCodingAuth: async () => ({ ok: true }) });
    expect(await doctor([], "/proj", d)).toBe(1);
  });

  it("checks coding readiness even when there are no MCP connections (org-level for a glob allowlist)", async () => {
    const called = vi.fn(async () => ({ ok: true as const }));
    const d = deps({ loadTeam: async () => codingTeam(), checkCodingAuth: called });
    expect(await doctor([], "/proj", d)).toBe(0);
    expect(called).toHaveBeenCalledWith("acme", undefined); // acme/* glob → org-level, no repositoryNames
  });

  it("checks a repo-scoped token for an exact coding.repos allowlist", async () => {
    const called = vi.fn(async () => ({ ok: true as const }));
    const exactTeam = codingTeam({
      deskmates: { engineer: { role: "engineer", coding: { repos: ["acme/api", "acme/web"] } } },
    });
    const d = deps({ loadTeam: async () => exactTeam, checkCodingAuth: called });
    expect(await doctor([], "/proj", d)).toBe(0);
    expect(called).toHaveBeenCalledWith("acme", ["api", "web"]);
  });

  it("does not run the coding check for a team with no coding deskmates", async () => {
    const called = vi.fn(async () => ({ ok: true as const }));
    const d = deps({ loadTeam: async () => team({ good: { kind: "mcp", env: "GOOD" } }), checkCodingAuth: called });
    await doctor([], "/proj", d);
    expect(called).not.toHaveBeenCalled();
  });

  const channelTeam = (over: Record<string, unknown> = {}) =>
    ({ connections: {}, github: { org: "acme", channel: true }, deskmates: {}, channels: {}, ...over }) as any;

  async function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void>) {
    const prev: Record<string, string | undefined> = {};
    for (const k of Object.keys(vars)) {
      prev[k] = process.env[k];
      if (vars[k] === undefined) delete process.env[k];
      else process.env[k] = vars[k];
    }
    try {
      await fn();
    } finally {
      for (const k of Object.keys(prev)) {
        if (prev[k] === undefined) delete process.env[k];
        else process.env[k] = prev[k];
      }
    }
  }

  it("passes a channel-only team with valid App, webhook secret, and app slug", async () => {
    await withEnv({ GITHUB_WEBHOOK_SECRET: "whsec", GITHUB_APP_SLUG: "my-app" }, async () => {
      const called = vi.fn(async () => ({ ok: true as const }));
      const d = deps({ loadTeam: async () => channelTeam(), checkCodingAuth: called });
      expect(await doctor([], "/proj", d)).toBe(0);
      expect(called).toHaveBeenCalledWith("acme", undefined); // no exact repos → org-level
    });
  });

  it("fails when the channel is enabled but GITHUB_WEBHOOK_SECRET is missing", async () => {
    await withEnv({ GITHUB_WEBHOOK_SECRET: undefined, GITHUB_APP_SLUG: "my-app" }, async () => {
      const d = deps({ loadTeam: async () => channelTeam(), checkCodingAuth: async () => ({ ok: true }) });
      expect(await doctor([], "/proj", d)).toBe(1);
    });
  });

  it("fails when the channel is enabled but GITHUB_APP_SLUG is missing (mentions won't dispatch)", async () => {
    await withEnv({ GITHUB_WEBHOOK_SECRET: "whsec", GITHUB_APP_SLUG: undefined }, async () => {
      const d = deps({ loadTeam: async () => channelTeam(), checkCodingAuth: async () => ({ ok: true }) });
      expect(await doctor([], "/proj", d)).toBe(1);
    });
  });
});

describe("loadLocalEnv", () => {
  it("loads .vercel/.env.production.local into process.env (only vars not already set)", () => {
    const dir = mkdtempSync(join(tmpdir(), "deskmate-env-"));
    try {
      mkdirSync(join(dir, ".vercel"), { recursive: true });
      writeFileSync(join(dir, ".vercel", ".env.production.local"), "DESKMATE_DOCTOR_TEST_URL=https://real/mcp\n");
      expect(process.env.DESKMATE_DOCTOR_TEST_URL).toBeUndefined();
      const loaded = loadLocalEnv(dir);
      expect(loaded).toBe(join(dir, ".vercel", ".env.production.local"));
      expect(process.env.DESKMATE_DOCTOR_TEST_URL).toBe("https://real/mcp");
    } finally {
      delete process.env.DESKMATE_DOCTOR_TEST_URL;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null when no env file exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "deskmate-env-"));
    try {
      expect(loadLocalEnv(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("warns and returns null when an env file can't be loaded", () => {
    const dir = mkdtempSync(join(tmpdir(), "deskmate-env-"));
    try {
      mkdirSync(join(dir, ".env")); // a directory named .env makes loadEnvFile throw (EISDIR)
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      expect(loadLocalEnv(dir)).toBeNull();
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls through to the next candidate when an earlier env file fails to load", () => {
    const dir = mkdtempSync(join(tmpdir(), "deskmate-env-"));
    try {
      mkdirSync(join(dir, ".vercel", ".env.production.local"), { recursive: true }); // a DIR → load throws
      writeFileSync(join(dir, ".env.local"), "DESKMATE_DOCTOR_FALLBACK=yes\n");
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      expect(loadLocalEnv(dir)).toBe(join(dir, ".env.local"));
      expect(process.env.DESKMATE_DOCTOR_FALLBACK).toBe("yes");
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      delete process.env.DESKMATE_DOCTOR_FALLBACK;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("findConnectionFile", () => {
  it("prefers a role-local connection file over a shared one (matches sync precedence)", () => {
    const dir = mkdtempSync(join(tmpdir(), "deskmate-conn-"));
    try {
      mkdirSync(join(dir, "connections"), { recursive: true });
      writeFileSync(join(dir, "connections", "foo.ts"), "// shared");
      mkdirSync(join(dir, "roles", "x", "connections"), { recursive: true });
      writeFileSync(join(dir, "roles", "x", "connections", "foo.ts"), "// role-local");
      expect(findConnectionFile("foo", dir)).toBe(join(dir, "roles", "x", "connections", "foo.ts"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to the shared file when no role-local exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "deskmate-conn-"));
    try {
      mkdirSync(join(dir, "connections"), { recursive: true });
      writeFileSync(join(dir, "connections", "foo.ts"), "// shared");
      expect(findConnectionFile("foo", dir)).toBe(join(dir, "connections", "foo.ts"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("picks the alphabetically-first role deterministically when multiple roles define it", () => {
    const dir = mkdtempSync(join(tmpdir(), "deskmate-conn-"));
    try {
      for (const role of ["zeta", "alpha", "mid"]) {
        mkdirSync(join(dir, "roles", role, "connections"), { recursive: true });
        writeFileSync(join(dir, "roles", role, "connections", "foo.ts"), `// ${role}`);
      }
      expect(findConnectionFile("foo", dir)).toBe(join(dir, "roles", "alpha", "connections", "foo.ts"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Vercel `sensitive` env vars cannot be read back, so `vercel env pull` writes them as
// KEY="" . Doctor loads that file, sees an empty value, and used to report the var as
// unset — a false failure for a production env that is actually fine.
describe("sensitive (unreadable) env vars", () => {
  const withEnvFile = (body: string, run: (file: string) => Promise<void> | void) => {
    const dir = mkdtempSync(join(tmpdir(), "deskmate-sens-"));
    const file = join(dir, ".env.production.local");
    writeFileSync(file, body);
    return Promise.resolve(run(file)).finally(() => rmSync(dir, { recursive: true, force: true }));
  };

  it("reads back the keys a pull wrote empty", async () => {
    await withEnvFile('REAL="abc"\nSECRET=""\nALSO_SECRET=\n', (file) => {
      const keys = sensitiveEnvKeys(file);
      expect(keys.has("SECRET")).toBe(true);
      expect(keys.has("ALSO_SECRET")).toBe(true);
      expect(keys.has("REAL")).toBe(false);
    });
  });

  it("does not fail the GitHub App check when its env is sensitive, not missing", async () => {
    await withEnvFile('GITHUB_APP_ID=""\nGITHUB_APP_PRIVATE_KEY=""\n', async (file) => {
      const d = deps({
        loadEnv: () => file,
        loadTeam: async () =>
          ({
            connections: {},
            deskmates: { eng: { coding: { repos: ["org/repo"] } } },
            channels: {},
            github: { org: "org" },
          }) as any,
        checkCodingAuth: async () => ({ ok: false, error: "set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY" }),
      });
      expect(await doctor([], "/proj", d)).toBe(0);
    });
  });

  it("still fails the GitHub App check when the env is genuinely absent", async () => {
    await withEnvFile('SOMETHING_ELSE="x"\n', async (file) => {
      const d = deps({
        loadEnv: () => file,
        loadTeam: async () =>
          ({
            connections: {},
            deskmates: { eng: { coding: { repos: ["org/repo"] } } },
            channels: {},
            github: { org: "org" },
          }) as any,
        checkCodingAuth: async () => ({ ok: false, error: "set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY" }),
      });
      expect(await doctor([], "/proj", d)).toBe(1);
    });
  });

  it("does not probe a token connection whose token is sensitive", async () => {
    await withEnvFile('GH_MCP_TOKEN=""\n', async (file) => {
      const probe = vi.fn(async () => ({ reachable: true, authOk: false, tools: [] }));
      const d = deps({
        loadEnv: () => file,
        loadTeam: async () => team({ gh: { kind: "mcp", env: "GH" } }),
        resolveConnection: async () => ({ kind: "ready", url: "https://gh/mcp", headers: {}, allow: [] }),
        probe,
      });
      expect(await doctor([], "/proj", d)).toBe(0);
      expect(probe).not.toHaveBeenCalled();
    });
  });
});
