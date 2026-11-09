import { describe, it, expect } from "vitest";
import { defineTeam } from "../src/config.js";
import { deskmateAgentConfig } from "../src/deskmate.js"; // pure helper under defineDeskmate

const team = defineTeam({
  model: "anthropic/claude-opus-4.8",
  deskmates: {
    devops: { role: "devops", emoji: "🔧", displayName: "DevOps Engineer",
              summary: "Triages incidents; proposes fixes.", reads: [] },
  },
  connections: {},
});

describe("deskmateAgentConfig", () => {
  it("builds a routing description from summary and falls back to team model", () => {
    const cfg = deskmateAgentConfig(team, "devops");
    expect(cfg.model).toBe("anthropic/claude-opus-4.8");
    expect(cfg.description).toMatch(/DevOps Engineer/);
    expect(cfg.description).toMatch(/Triages incidents/);
  });
  it("throws on unknown id", () => {
    expect(() => deskmateAgentConfig(team, "ghost")).toThrow(/unknown deskmate/i);
  });

  it("normalizes a PLAIN (unwrapped) team so an omitted model falls back to the schema default", () => {
    // The generated subagent shim re-imports the raw default export; a consumer may
    // export a plain object WITHOUT `model`, relying on the schema default. Without
    // internal normalization this deskmate's model would be `undefined`.
    const plain = {
      deskmates: {
        devops: { role: "devops", emoji: "🔧", displayName: "DevOps Engineer", summary: "Triages incidents.", reads: [] },
      },
      connections: {},
    };
    const cfg = deskmateAgentConfig(plain, "devops");
    expect(cfg.model).toBe("anthropic/claude-sonnet-5.5"); // schema default, NOT undefined
    expect(cfg.description).toMatch(/DevOps Engineer/);
  });
});
