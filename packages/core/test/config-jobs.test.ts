import { describe, it, expect } from "vitest";
import { defineTeam } from "../src/config.js";

const base = {
  connections: {
    postgres: { kind: "mcp" as const, env: "POSTGRES" },
    githubwrite: { kind: "mcp" as const, env: "GITHUB", write: true },
  },
  deskmates: {
    analyst: { role: "analyst", emoji: ":x:", displayName: "Analyst", summary: "s",
               reads: ["postgres", "githubwrite"] },
    reader: { role: "reader", emoji: ":y:", displayName: "Reader", summary: "s",
              reads: ["postgres"] },
  },
  channels: { "ask-product": { deskmate: "analyst", id: "C0123ABC" } },
};

const job = (over: Record<string, unknown> = {}) => ({
  ...base,
  jobs: { review: { deskmate: "analyst", channel: "ask-product", cron: "0 6 * * *", ...over } },
});

describe("jobs config", () => {
  it("applies defaults for ceiling, window, maxItems and enabled", () => {
    const team = defineTeam(job());
    expect(team.jobs.review).toMatchObject({ ceiling: "digest", window: "24h", maxItems: 3, enabled: true });
  });

  it("accepts a webhook job with no cron", () => {
    const team = defineTeam(job({ cron: undefined, webhook: true }));
    expect(team.jobs.review.webhook).toBe(true);
  });

  it("rejects a job with both cron and webhook", () => {
    expect(() => defineTeam(job({ webhook: true }))).toThrow(/either .cron. or .webhook/);
  });

  it("rejects a job with neither cron nor webhook", () => {
    expect(() => defineTeam(job({ cron: undefined }))).toThrow(/either .cron. or .webhook/);
  });

  it("rejects a non-snake_case job id", () => {
    expect(() => defineTeam({ ...base, jobs: { "bad-id": { deskmate: "analyst", channel: "ask-product", cron: "0 6 * * *" } } }))
      .toThrow(/must be snake_case/);
  });

  it("rejects an unknown deskmate", () => {
    expect(() => defineTeam(job({ deskmate: "nobody" }))).toThrow(/unknown deskmate "nobody"/);
  });

  it("rejects an unknown channel", () => {
    expect(() => defineTeam(job({ channel: "ask-nowhere" }))).toThrow(/unknown channel "ask-nowhere"/);
  });

  it("rejects a malformed window", () => {
    expect(() => defineTeam(job({ window: "yesterday" }))).toThrow(/window/);
  });

  it("rejects ceiling issue when the deskmate reads no write connection", () => {
    expect(() => defineTeam(job({ deskmate: "reader", ceiling: "issue" })))
      .toThrow(/reads no write-capable connection/);
  });

  it("accepts ceiling issue when the deskmate reads a write connection", () => {
    expect(defineTeam(job({ ceiling: "issue" })).jobs.review.ceiling).toBe("issue");
  });

  it("rejects ceiling pr when no deskmate has coding enabled", () => {
    expect(() => defineTeam(job({ ceiling: "pr" }))).toThrow(/no coding deskmate/);
  });

  it("infers the handoff when exactly one deskmate codes", () => {
    const withCoder = {
      ...base,
      github: { org: "acme" },
      deskmates: { ...base.deskmates, eng: { role: "eng", emoji: ":z:", displayName: "Eng", summary: "s", coding: true } },
      jobs: { review: { deskmate: "analyst", channel: "ask-product", cron: "0 6 * * *", ceiling: "pr" } },
    };
    expect(defineTeam(withCoder).jobs.review.handoff).toBe("eng");
  });

  it("rejects an ambiguous handoff when two deskmates code", () => {
    const twoCoders = {
      ...base,
      github: { org: "acme" },
      deskmates: {
        ...base.deskmates,
        eng: { role: "eng", emoji: ":z:", displayName: "Eng", summary: "s", coding: true },
        eng2: { role: "eng2", emoji: ":w:", displayName: "Eng2", summary: "s", coding: true },
      },
      jobs: { review: { deskmate: "analyst", channel: "ask-product", cron: "0 6 * * *", ceiling: "pr" } },
    };
    expect(() => defineTeam(twoCoders)).toThrow(/ambiguous/);
  });

  it("rejects a handoff naming a non-coding deskmate", () => {
    const withCoder = {
      ...base,
      github: { org: "acme" },
      deskmates: { ...base.deskmates, eng: { role: "eng", emoji: ":z:", displayName: "Eng", summary: "s", coding: true } },
      jobs: { review: { deskmate: "analyst", channel: "ask-product", cron: "0 6 * * *", ceiling: "pr", handoff: "reader" } },
    };
    expect(() => defineTeam(withCoder)).toThrow(/handoff "reader"/);
  });
});
