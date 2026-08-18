import { describe, it, expect } from "vitest";
import { defineTeam } from "../src/config.js";

describe("defineTeam", () => {
  it("applies defaults (maxTurns 6) and returns a normalized team", () => {
    const team = defineTeam({
      deskmates: { devops: { role: "devops", emoji: "🔧", displayName: "DevOps Engineer", summary: "…", reads: ["github"] } },
      connections: { github: { kind: "mcp", env: "GITHUB" } },
    });
    expect(team.frontDesk.maxTurns).toBe(6);
    expect(team.deskmates.devops.reads).toEqual(["github"]);
    expect(Object.keys(team.connections)).toContain("github");
  });

  it("rejects a deskmate whose `reads` names an unknown connection", () => {
    expect(() =>
      defineTeam({
        deskmates: { devops: { role: "devops", emoji: "🔧", displayName: "D", summary: "…", reads: ["nope"] } },
        connections: {},
      }),
    ).toThrow(/unknown connection/i);
  });

  it("rejects a channel route pointing at an unknown deskmate", () => {
    expect(() =>
      defineTeam({
        deskmates: {},
        connections: {},
        channels: { C1: { deskmate: "ghost" } },
      }),
    ).toThrow(/unknown deskmate/i);
  });

  it("rejects a deskmate id that isn't a snake_case identifier", () => {
    expect(() =>
      defineTeam({
        deskmates: { "Bad-Id": { role: "x", emoji: "x", displayName: "x", summary: "…", reads: [] } },
        connections: {},
      }),
    ).toThrow(/snake_case/i);
  });

  it("rejects a deskmate `role` that isn't a snake_case identifier (path-traversal guard)", () => {
    expect(() =>
      defineTeam({
        deskmates: { devops: { role: "../evil", emoji: "🔧", displayName: "D", summary: "…", reads: [] } },
        connections: {},
      }),
    ).toThrow(/snake_case/i);
  });

  it("rejects a connection name that isn't a snake_case identifier", () => {
    expect(() =>
      defineTeam({
        deskmates: {},
        connections: { "Bad-Name": { kind: "mcp" } },
      }),
    ).toThrow(/snake_case/i);
  });

  it("allows uppercase Slack channel ids as channel keys (not identifier-guarded)", () => {
    const team = defineTeam({
      deskmates: { devops: { role: "devops", emoji: "🔧", displayName: "D", summary: "…", reads: [] } },
      connections: {},
      channels: { C0INCIDENTS: { deskmate: "devops", lock: true } },
    });
    expect(team.channels.C0INCIDENTS).toEqual({ deskmate: "devops", lock: true });
  });

  it("accepts an optional per-deskmate voice line", () => {
    const team = defineTeam({
      deskmates: {
        devops: {
          role: "devops",
          emoji: ":wrench:",
          displayName: "DevOps Engineer",
          summary: "Triages incidents.",
          voice: "Terse SRE. Leads with the punchline.",
        },
      },
    });
    expect(team.deskmates.devops.voice).toBe("Terse SRE. Leads with the punchline.");
  });

  it("leaves voice undefined when omitted", () => {
    const team = defineTeam({
      deskmates: {
        devops: { role: "devops", emoji: ":wrench:", displayName: "DevOps", summary: "x" },
      },
    });
    expect(team.deskmates.devops.voice).toBeUndefined();
  });

  it("parses a channel watch block with defaults", () => {
    const team = defineTeam({
      deskmates: { devops: { role: "devops", emoji: ":x:", displayName: "D", summary: "s" } },
      channels: { C0INC: { deskmate: "devops", watch: {} } },
    });
    expect(team.channels.C0INC.watch).toMatchObject({ react: true, reply: true, post: false, approvePosts: false, picker: "routed" });
  });

  it("rejects an unknown picker", () => {
    expect(() => defineTeam({
      deskmates: { devops: { role: "devops", emoji: ":x:", displayName: "D", summary: "s" } },
      channels: { C0INC: { deskmate: "devops", watch: { picker: "nope" } } },
    })).toThrow();
  });

  it("accepts an oauth connection with connect + service", () => {
    const team = defineTeam({
      deskmates: { devops: { role: "devops", emoji: "🔧", displayName: "D", summary: "…", reads: ["vercel"] } },
      connections: { vercel: { kind: "mcp", connect: "vercel/deskmate", service: "mcp.vercel.com" } },
    });
    expect(team.connections.vercel).toMatchObject({ kind: "mcp", connect: "vercel/deskmate", service: "mcp.vercel.com" });
  });

  it("rejects a connection that sets both env (token) and connect (oauth)", () => {
    expect(() =>
      defineTeam({
        deskmates: {},
        connections: { bad: { kind: "mcp", env: "BAD", connect: "bad/deskmate" } },
      }),
    ).toThrow(/either .*env.* or .*connect/i);
  });

  it("rejects `service` without `connect`", () => {
    expect(() =>
      defineTeam({
        deskmates: {},
        connections: { bad: { kind: "mcp", env: "BAD", service: "mcp.bad.com" } },
      }),
    ).toThrow(/service.*only.*connect/i);
  });

  it("rejects an empty connect string", () => {
    expect(() =>
      defineTeam({ deskmates: {}, connections: { bad: { kind: "mcp", connect: "" } } }),
    ).toThrow();
  });

  it("rejects an empty service string", () => {
    expect(() =>
      defineTeam({ deskmates: {}, connections: { bad: { kind: "mcp", connect: "x/deskmate", service: "" } } }),
    ).toThrow();
  });
});

const base = { role: "cs", emoji: ":x:", displayName: "CS", summary: "s" };

describe("memory config", () => {
  it("normalizes memory:true to defaults", () => {
    const t = defineTeam({ deskmates: { cs: { ...base, memory: true } } });
    expect(t.deskmates.cs.memory).toEqual({ maxItems: 200, coreLimit: 25 });
  });
  it("leaves memory undefined when absent", () => {
    const t = defineTeam({ deskmates: { cs: { ...base } } });
    expect(t.deskmates.cs.memory).toBeUndefined();
  });
  it("treats memory:false as off (undefined)", () => {
    const t = defineTeam({ deskmates: { cs: { ...base, memory: false } } });
    expect(t.deskmates.cs.memory).toBeUndefined();
  });
  it("honors explicit maxItems/coreLimit", () => {
    const t = defineTeam({ deskmates: { cs: { ...base, memory: { maxItems: 50 } } } });
    expect(t.deskmates.cs.memory).toEqual({ maxItems: 50, coreLimit: 25 });
  });
});

describe("coding config", () => {
  const eng = { ...base, role: "engineer" };

  it("normalizes coding:true to a default (empty repos) object", () => {
    const t = defineTeam({ github: { org: "acme" }, deskmates: { engineer: { ...eng, coding: true } } });
    expect(t.deskmates.engineer.coding).toEqual({ repos: [] });
  });

  it("keeps an explicit coding.repos allowlist", () => {
    const t = defineTeam({ github: { org: "acme" }, deskmates: { engineer: { ...eng, coding: { repos: ["acme/*"] } } } });
    expect(t.deskmates.engineer.coding).toEqual({ repos: ["acme/*"] });
  });

  it("defaults coding:{} (object, repos omitted) to empty repos", () => {
    const t = defineTeam({ github: { org: "acme" }, deskmates: { engineer: { ...eng, coding: {} } } });
    expect(t.deskmates.engineer.coding).toEqual({ repos: [] });
  });

  it("rejects a coding.repos entry with no name part (owner only)", () => {
    expect(() =>
      defineTeam({ github: { org: "acme" }, deskmates: { engineer: { ...eng, coding: { repos: ["acme"] } } } }),
    ).toThrow(/owner\/name|org "acme"/i);
  });

  it("rejects a coding.repos entry with extra path segments", () => {
    expect(() =>
      defineTeam({ github: { org: "acme" }, deskmates: { engineer: { ...eng, coding: { repos: ["acme/api/extra"] } } } }),
    ).toThrow(/owner\/name|org "acme"/i);
  });

  it("rejects a partial-wildcard repo name (only owner/name or owner/* allowed)", () => {
    expect(() =>
      defineTeam({ github: { org: "acme" }, deskmates: { engineer: { ...eng, coding: { repos: ["acme/api-*"] } } } }),
    ).toThrow(/owner\/name|owner\/\*/i);
  });

  it("treats coding:false as off (undefined)", () => {
    const t = defineTeam({ github: { org: "acme" }, deskmates: { engineer: { ...eng, coding: false } } });
    expect(t.deskmates.engineer.coding).toBeUndefined();
  });

  it("leaves coding undefined when omitted", () => {
    const t = defineTeam({ deskmates: { engineer: { ...eng } } });
    expect(t.deskmates.engineer.coding).toBeUndefined();
  });

  it("exposes the team github block", () => {
    const t = defineTeam({ github: { org: "acme" }, deskmates: {} });
    expect(t.github).toEqual({ org: "acme" });
  });

  it("accepts an optional github.channel flag", () => {
    const t = defineTeam({ github: { org: "acme", channel: true }, deskmates: {} });
    expect(t.github).toEqual({ org: "acme", channel: true });
  });

  it("rejects a coding deskmate when the team has no github block", () => {
    expect(() => defineTeam({ deskmates: { engineer: { ...eng, coding: true } } })).toThrow(/github/i);
  });

  it("rejects a coding.repos entry outside the configured github.org", () => {
    expect(() =>
      defineTeam({ github: { org: "acme" }, deskmates: { engineer: { ...eng, coding: { repos: ["other/api"] } } } }),
    ).toThrow(/single .*org|org "acme"/i);
  });
});

it("defaults a connection to read-only and accepts an explicit write flag", () => {
  const team = defineTeam({
    connections: { postgres: { kind: "mcp", env: "POSTGRES" },
                   githubwrite: { kind: "mcp", env: "GITHUB", write: true } },
    deskmates: {}, channels: {},
  });
  expect(team.connections.postgres.write).toBe(false);
  expect(team.connections.githubwrite.write).toBe(true);
});

it("accepts an explicit Slack id on a channel route", () => {
  const team = defineTeam({
    connections: {},
    deskmates: { pa: { role: "pa", emoji: ":x:", displayName: "PA", summary: "s" } },
    channels: { "ask-product": { deskmate: "pa", id: "C0123ABC" } },
  });
  expect(team.channels["ask-product"].id).toBe("C0123ABC");
});
