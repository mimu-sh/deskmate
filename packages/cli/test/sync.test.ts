import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { syncCommand } from "../src/sync/index.js";

// End-to-end sync ownership: `syncCommand` must fully own each surviving deskmate's
// generated `agent/subagents/<id>/` subtree, so a tool removed from the authored
// `roles/<id>/tools/` leaves NO stale generated shim behind (a dangling shim would
// import a now-missing file and break `eve build`).
//
// The config is written as a plain `export default { … }` object (no `@deskmate/core`
// import) so the temp dir needs no installed deps; `syncCommand` only reads
// `mod.default` and passes it to the pure planner.

const CONFIG = `export default {
  model: "anthropic/claude-sonnet-5",
  frontDesk: { maxTurns: 6 },
  connections: {},
  deskmates: {
    devops: {
      role: "devops",
      emoji: ":wrench:",
      displayName: "DevOps Engineer",
      summary: "Triages incidents.",
      reads: [],
    },
  },
  channels: {},
};
`;

/** The CONFIG shape with a swappable model — used to prove config edits live-reload. */
const configWith = (model: string) => CONFIG.replace(`model: "anthropic/claude-sonnet-5"`, `model: "${model}"`);

let cwd: string;

afterEach(() => {
  if (cwd) rmSync(cwd, { recursive: true, force: true });
});

describe("syncCommand", () => {
  it("removes a stale generated tool shim after its authored source is deleted", async () => {
    cwd = mkdtempSync(join(tmpdir(), "deskmate-sync-"));
    writeFileSync(join(cwd, "deskmate.config.ts"), CONFIG);
    mkdirSync(join(cwd, "roles/devops/tools"), { recursive: true });
    writeFileSync(join(cwd, "roles/devops/instructions.md"), "# DevOps\n");
    writeFileSync(join(cwd, "roles/devops/tools/x.ts"), "export default {};\n");

    // First sync: the tool shim is generated for the authored tool.
    await syncCommand(cwd);
    const shim = join(cwd, "agent/subagents/devops/tools/x.ts");
    expect(existsSync(shim)).toBe(true);

    // Remove the authored tool, then re-sync. The subtree is wiped + rebuilt, so the
    // now-orphaned generated shim must be gone (not linger and break `eve build`).
    rmSync(join(cwd, "roles/devops/tools/x.ts"));
    await syncCommand(cwd);
    expect(existsSync(shim)).toBe(false);

    // The deskmate itself is still fully generated (agent.ts recreated fresh).
    expect(existsSync(join(cwd, "agent/subagents/devops/agent.ts"))).toBe(true);
  });

  // `{ quiet: true }` suppresses the summary/warning logs (watch-mode re-syncs run
  // under an interactive TUI, where stray stdout would corrupt the display) while
  // still performing every file write.
  it("writes files but logs nothing when { quiet: true }", async () => {
    cwd = mkdtempSync(join(tmpdir(), "deskmate-sync-"));
    writeFileSync(join(cwd, "deskmate.config.ts"), CONFIG);
    mkdirSync(join(cwd, "roles/devops"), { recursive: true });
    writeFileSync(join(cwd, "roles/devops/instructions.md"), "# DevOps\n");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await syncCommand(cwd, { quiet: true });
      expect(logSpy).not.toHaveBeenCalled();
      expect(existsSync(join(cwd, "agent", "agent.ts"))).toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });

  // `deskmate dev` re-syncs the SAME config path in one long-lived process. Node's
  // ESM loader caches modules by URL, so without a cache-bust the second import would
  // return the stale original and a config edit would never live-reload. This drives
  // the real `syncCommand` twice against one cwd, editing the model between, and
  // asserts the regenerated agent.ts tracks the SECOND config.
  it("re-imports an edited config on re-sync (config edits live-reload)", async () => {
    cwd = mkdtempSync(join(tmpdir(), "deskmate-sync-"));
    mkdirSync(join(cwd, "roles/devops"), { recursive: true });
    writeFileSync(join(cwd, "roles/devops/instructions.md"), "# DevOps\n");
    const agentTs = join(cwd, "agent", "agent.ts");

    writeFileSync(join(cwd, "deskmate.config.ts"), configWith("anthropic/claude-sonnet-5"));
    await syncCommand(cwd, { quiet: true });
    expect(readFileSync(agentTs, "utf8")).toContain("anthropic/claude-sonnet-5");

    // Edit the SAME config path, then re-sync: the regenerated agent must reflect it.
    writeFileSync(join(cwd, "deskmate.config.ts"), configWith("anthropic/claude-opus-4-8"));
    await syncCommand(cwd, { quiet: true });
    const after = readFileSync(agentTs, "utf8");
    expect(after).toContain("anthropic/claude-opus-4-8");
    expect(after).not.toContain("anthropic/claude-sonnet-5");
  });

  // Naming conflict: deskmate's `defineTeam` accepts snake_case connection names
  // (underscores), but eve's `eve build` derives a connection's name from its filename
  // and rejects underscores (it wants kebab-case). A name like `github_write` would
  // therefore pass config validation, sync fine, then blow up at deploy. `sync` must
  // fail fast with a message that names the eve conflict, instead of generating a tree
  // that `eve build` rejects.
  it("rejects a multi-word (underscore) connection name that eve build would reject at deploy", async () => {
    cwd = mkdtempSync(join(tmpdir(), "deskmate-sync-"));
    const cfg = `export default {
  model: "anthropic/claude-sonnet-5",
  frontDesk: { maxTurns: 6 },
  connections: { github_write: { kind: "mcp", env: "GITHUB_WRITE" } },
  deskmates: {
    devops: {
      role: "devops",
      emoji: ":wrench:",
      displayName: "DevOps Engineer",
      summary: "Triages incidents.",
      reads: ["github_write"],
    },
  },
  channels: {},
};
`;
    writeFileSync(join(cwd, "deskmate.config.ts"), cfg);
    mkdirSync(join(cwd, "roles/devops"), { recursive: true });
    writeFileSync(join(cwd, "roles/devops/instructions.md"), "# DevOps\n");
    await expect(syncCommand(cwd, { quiet: true })).rejects.toThrow(/single lowercase word/);
  });
});
