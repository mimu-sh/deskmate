import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { defineTeam } from "@deskmate/core";
import { add, entryFromRole } from "../src/add.js";

// `add` copies a catalog role into roles/<id>/, appends its roster entry, AND (the
// fix under test) seeds a matching `connections.<provider>` for every provider the
// role reads. Without the seeded connections, `defineTeam` would reject the roster
// entry's `reads` as an unknown connection — so the documented `deskmate add … &&
// deskmate sync` flow would fail.

const MINIMAL_CONFIG = `import { defineTeam } from "@deskmate/core";

export default defineTeam({
  model: "anthropic/claude-sonnet-5",
  connections: {},
  deskmates: {},
  channels: {},
});
`;

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "deskmate-add-"));
  writeFileSync(join(cwd, "deskmate.config.ts"), MINIMAL_CONFIG);
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

/** Evaluate the object literal passed to `defineTeam(…)` in the written config. */
function loadTeam(configSrc: string): unknown {
  const start = configSrc.indexOf("defineTeam(") + "defineTeam(".length;
  const end = configSrc.lastIndexOf(")");
  const objectLiteral = configSrc.slice(start, end);
  // The literal is pure JS (identifier keys, string/array/object/number/bool values);
  // evaluate it to a plain object, then validate it through the REAL defineTeam.
  return new Function(`return (${objectLiteral});`)();
}

describe("entryFromRole", () => {
  it("carries an optional voice from the role manifest into the config entry", () => {
    const entry = entryFromRole({
      id: "devops",
      displayName: "DevOps Engineer",
      emoji: ":wrench:",
      summary: "Triages incidents.",
      voice: "Terse SRE. Dry, not chatty.",
      providers: ["sentry"],
    });
    expect(entry.voice).toBe("Terse SRE. Dry, not chatty.");
  });

  it("omits voice when the manifest has none", () => {
    const entry = entryFromRole({
      id: "devops",
      displayName: "DevOps Engineer",
      emoji: ":wrench:",
      summary: "Triages incidents.",
    });
    expect("voice" in entry).toBe(false);
  });
});

describe("deskmate add — seeds matching connections", () => {
  it("writes BOTH the deskmate entry and its connections entry, and passes defineTeam", () => {
    add(["product_analyst"], cwd);

    const src = readFileSync(join(cwd, "deskmate.config.ts"), "utf8");
    // The roster entry (reads mixpanel) …
    expect(src).toContain("product_analyst: {");
    expect(src).toContain('reads: ["mixpanel"]');
    // … carries the catalog role's voice line …
    expect(src).toContain("voice:");
    // … and the seeded connection with a default env prefix.
    expect(src).toContain("mixpanel: {");
    expect(src).toContain('kind: "mcp"');
    expect(src).toContain('env: "MIXPANEL"');

    // The whole config now validates (no unknown-connection error).
    const raw = loadTeam(src);
    expect(() => defineTeam(raw)).not.toThrow();
    const team = defineTeam(raw);
    expect(team.connections.mixpanel).toEqual({ kind: "mcp", env: "MIXPANEL", write: false });
    expect(team.deskmates.product_analyst.reads).toEqual(["mixpanel"]);
    // The authored role was copied in too.
    expect(existsSync(join(cwd, "roles", "product_analyst", "deskmate.json"))).toBe(true);
  });

  it("seeds connections for multiple roles in one invocation", () => {
    add(["product_analyst", "devops"], cwd);
    const team = defineTeam(loadTeam(readFileSync(join(cwd, "deskmate.config.ts"), "utf8")));
    expect(team.connections.mixpanel).toBeDefined();
    expect(team.connections.sentry).toBeDefined();
    expect(Object.keys(team.deskmates).sort()).toEqual(["devops", "product_analyst"]);
  });

  it("is idempotent: a second add makes no further change to the config", () => {
    add(["product_analyst"], cwd);
    const once = readFileSync(join(cwd, "deskmate.config.ts"), "utf8");
    add(["product_analyst"], cwd);
    const twice = readFileSync(join(cwd, "deskmate.config.ts"), "utf8");
    expect(twice).toBe(once);
  });
});
