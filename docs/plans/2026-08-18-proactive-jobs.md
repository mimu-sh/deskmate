# Proactive Jobs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a deskmate start work on its own — on a cron cadence or on an inbound webhook — with a declared limit on how far it may go unattended.

**Architecture:** A `jobs` block in `deskmate.config.ts` is validated by `defineTeam`. `deskmate sync` renders one `agent/schedules/job-<id>.ts` per cron job and a single `agent/channels/hooks.ts` for all webhook jobs. Both generated files are thin shims over factories in `@deskmate/core/jobs`; every non-trivial decision (message composition, signature verification, fingerprint parsing) lives in a pure function that is unit-tested without a channel, matching how `sweepTargets` and `nextConveneDecision` are already structured.

**Tech Stack:** TypeScript (Node ≥22.18 for type-stripping, Node 24 for the eve CLI), zod v4, vitest, eve ^0.19.

**Spec:** `docs/plans/2026-08-18-proactive-jobs-design.md`

## Global Constraints

- Package versions land as `@deskmate/core` 0.4.0 and `@deskmate/cli` 0.6.0 via release-please; use conventional commits (`feat:`, `fix:`, `docs:`, `test:`) with `(core)` / `(cli)` scopes.
- Connection and channel-key naming rules are unchanged and still conflicting: `eve build` demands `^[a-z][a-z0-9-]*$`, `deskmate sync` demands `^[a-z][a-z0-9_]*$`. Job ids follow the sync rule (`^[a-z][a-z0-9_]*$`) because they become directory-free filenames and URL segments.
- `window` values match `^\d+[hd]$`.
- Fingerprint slugs are kebab-case: `^[a-z0-9]+(?:-[a-z0-9]+)*$`.
- The hook signature scheme is `x-deskmate-signature: sha256=<hmac-sha256(secret, "<ts>.<rawBody>")>` with `x-deskmate-timestamp` in unix seconds and a 300-second replay window.
- Channel routes in eve declare **absolute** paths (`/eve/v1/slack`, `/eve/v1/github`), so the hooks channel declares `/eve/v1/hooks/:job`.
- `pnpm lint`, `pnpm typecheck`, and `pnpm test` must each be run and read separately — never chained through a pipe whose exit status hides a failure.
- Ceilings are cumulative: `pr` ⊃ `issue` ⊃ `digest`.

---

### Task 1: Connection `write` flag, channel `id`, and the target resolver

Foundation for later validation, and it fixes a latent bug: `receive()` passes `target.channelId` straight to Slack's API, but `channels` keys may be names, which Slack cannot resolve.

**Files:**
- Modify: `packages/core/src/config.ts` (ConnectionConfig, ChannelRoute schemas)
- Modify: `packages/core/src/channel-routes.ts` (ChannelRoute type + new helpers)
- Modify: `packages/core/src/schedules/deskmate-sweep.ts` (use the resolver)
- Modify: `packages/core/src/index.ts` (export the helpers)
- Test: `packages/core/test/channel-routes.test.ts`, `packages/core/test/config.test.ts`, `packages/core/test/deskmate-sweep.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `resolveChannelTarget(key: string, route?: { id?: string } | null): string`; `isSlackChannelId(value: string): boolean`; `ConnectionConfig.write: boolean` (defaulted `false`); `ChannelRoute.id?: string`; `SweepTarget.channelId` now carries the resolved id.

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/test/channel-routes.test.ts`:

```ts
import { resolveChannelTarget, isSlackChannelId } from "../src/channel-routes.js";

describe("resolveChannelTarget", () => {
  it("prefers the route's explicit Slack id over the config key", () => {
    expect(resolveChannelTarget("ask-product", { deskmate: "pa", id: "C0123ABC" })).toBe("C0123ABC");
  });
  it("falls back to the key when no id is declared", () => {
    expect(resolveChannelTarget("C0456DEF", { deskmate: "pa" })).toBe("C0456DEF");
  });
  it("falls back to the key when the route is missing entirely", () => {
    expect(resolveChannelTarget("C0456DEF", null)).toBe("C0456DEF");
  });
});

describe("isSlackChannelId", () => {
  it.each(["C0123ABC", "G07ABCDEF", "D0ABC123"])("accepts %s", (v) => {
    expect(isSlackChannelId(v)).toBe(true);
  });
  it.each(["ask-product", "c0123abc", "", "#ask-product"])("rejects %s", (v) => {
    expect(isSlackChannelId(v)).toBe(false);
  });
});
```

Append to `packages/core/test/config.test.ts`:

```ts
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
```

Append to `packages/core/test/deskmate-sweep.test.ts`:

```ts
it("resolves a name-keyed channel to its declared Slack id", () => {
  const named = { "ask-devops": { deskmate: "devops", id: "C0XYZ", watch: { digest: true, post: true } } };
  expect(sweepTargets(named as any)).toEqual([{ channelId: "C0XYZ", deskmate: "devops" }]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/core && npx vitest run test/channel-routes.test.ts test/config.test.ts test/deskmate-sweep.test.ts`
Expected: FAIL — `resolveChannelTarget is not a function`, and the config tests fail on unknown keys / undefined `write`.

- [ ] **Step 3: Add the helpers to `channel-routes.ts`**

Extend the exported type and append the helpers:

```ts
export type ChannelRoute = { deskmate: string; id?: string; lock?: boolean; watch?: ChannelWatch };

/** Slack conversation ids: public (C), private group (G), and DM (D). */
const SLACK_CHANNEL_ID_RE = /^[CGD][A-Z0-9]+$/;

/** True when `value` looks like a Slack conversation id rather than a channel name. */
export function isSlackChannelId(value: string): boolean {
  return SLACK_CHANNEL_ID_RE.test(value);
}

/**
 * The value to hand to `receive({ target: { channelId } })`. Config keys may be
 * channel NAMES (resolveRoute accepts either), but Slack's API needs an id, so an
 * explicit `id` on the route always wins.
 */
export function resolveChannelTarget(key: string, route?: { id?: string } | null): string {
  return route?.id ?? key;
}
```

- [ ] **Step 4: Add the schema fields in `config.ts`**

In `ConnectionConfig`'s object literal, after `service`:

```ts
    // Declares that this connection can mutate the remote system. Consumed by job
    // ceiling validation; read-only is the default and the overwhelming majority.
    write: z.boolean().default(false),
```

In `ChannelRoute`'s object literal, after `deskmate`:

```ts
  // The Slack conversation id, when the key is a human-readable name. `receive()`
  // hands `target.channelId` straight to Slack, which cannot resolve a bare name.
  id: z.string().min(1).optional(),
```

- [ ] **Step 5: Use the resolver in the sweep**

In `packages/core/src/schedules/deskmate-sweep.ts`, replace the body of `sweepTargets`:

```ts
export function sweepTargets(routes: Record<string, ChannelRoute>): SweepTarget[] {
  return Object.entries(routes)
    .filter(([, r]) => r.watch?.digest === true && r.watch?.post === true)
    .map(([key, r]) => ({ channelId: resolveChannelTarget(key, r), deskmate: r.deskmate }));
}
```

Add the import at the top:

```ts
import { resolveChannelTarget } from "../channel-routes.js";
```

- [ ] **Step 6: Export the helpers**

In `packages/core/src/index.ts`, extend the existing `channel-routes.js` export line to include `resolveChannelTarget` and `isSlackChannelId`.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd packages/core && npx vitest run`
Expected: PASS, including the pre-existing sweep and channel-route tests.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/config.ts packages/core/src/channel-routes.ts packages/core/src/schedules/deskmate-sweep.ts packages/core/src/index.ts packages/core/test/channel-routes.test.ts packages/core/test/config.test.ts packages/core/test/deskmate-sweep.test.ts
git commit -m "feat(core): declare connection write capability and channel Slack ids

A channels key may be a name, but receive() hands target.channelId straight to
Slack, which cannot resolve one. resolveChannelTarget prefers an explicit id and
the sweep now uses it."
```

---

### Task 2: The `jobs` config block and its validation

**Files:**
- Modify: `packages/core/src/config.ts`
- Test: `packages/core/test/config-jobs.test.ts` (create)

**Interfaces:**
- Consumes: `ConnectionConfig.write`, `ChannelRoute.id` (Task 1).
- Produces: `JobConfig` type — `{ deskmate: string; channel: string; cron?: string; webhook?: boolean; ceiling: "digest" | "issue" | "pr"; window: string; maxItems: number; brief?: string; handoff?: string; enabled: boolean }` — and `TeamConfig.jobs: Record<string, JobConfig>`.

- [ ] **Step 1: Write the failing tests**

Create `packages/core/test/config-jobs.test.ts`:

```ts
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
```

Note the `pr` cases: because ceilings are cumulative, `analyst` must also read a write connection — it does.

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/core && npx vitest run test/config-jobs.test.ts`
Expected: FAIL — `team.jobs` is undefined.

- [ ] **Step 3: Add the schema**

In `packages/core/src/config.ts`, above `TeamConfig`:

```ts
const WINDOW_RE = /^\d+[hd]$/;

const JobConfig = z
  .object({
    deskmate: z.string(),
    channel: z.string(),
    // Exactly one trigger, mirroring eve's own `markdown` | `run` one-of on schedules.
    cron: z.string().min(1).optional(),
    webhook: z.boolean().optional(),
    // How far the job may go unattended. Cumulative: pr ⊃ issue ⊃ digest.
    ceiling: z.enum(["digest", "issue", "pr"]).default("digest"),
    // How far back a cron job looks. Ignored for webhook jobs, which carry a payload.
    window: z.string().regex(WINDOW_RE, "window must look like `24h` or `7d`").default("24h"),
    maxItems: z.number().int().positive().default(3),
    // Brief path relative to roles/<role>/jobs/. Defaults to `<job-id>.md`.
    brief: z.string().min(1).optional(),
    // For ceiling `pr`: which coding deskmate receives the work. Inferred when the
    // team has exactly one coding deskmate.
    handoff: z.string().min(1).optional(),
    enabled: z.boolean().default(true),
  })
  .refine((j) => (j.cron !== undefined) !== (j.webhook === true), {
    message: "a job uses either `cron` or `webhook: true`, not both and not neither",
  });
```

Add to `TeamConfig`'s object literal, after `channels`:

```ts
  jobs: z.record(z.string(), JobConfig).default({}),
```

Add the exported type beside the others:

```ts
export type JobConfig = z.infer<typeof JobConfig>;
```

- [ ] **Step 4: Add the validation**

In `defineTeam`, after the existing channel loop and before the coding loop:

```ts
  const codingIds = Object.entries(team.deskmates).filter(([, d]) => d.coding).map(([id]) => id);
  for (const [id, job] of Object.entries(team.jobs)) {
    if (!IDENTIFIER_RE.test(id)) {
      throw new Error(
        `job id "${id}" must be snake_case (a lowercase letter, then letters/digits/underscores) — ` +
          `it becomes a generated filename and a webhook URL segment.`,
      );
    }
    const d = team.deskmates[job.deskmate];
    if (!d) throw new Error(`job "${id}" routes to unknown deskmate "${job.deskmate}"`);
    if (!team.channels[job.channel]) throw new Error(`job "${id}" targets unknown channel "${job.channel}"`);

    // Ceilings are cumulative, so anything above `digest` needs somewhere to write.
    if (job.ceiling !== "digest") {
      const hasWrite = d.reads.some((r) => team.connections[r]?.write === true);
      if (!hasWrite) {
        throw new Error(
          `job "${id}" has ceiling "${job.ceiling}" but deskmate "${job.deskmate}" reads no ` +
            `write-capable connection — mark one of its connections \`write: true\` or lower the ceiling.`,
        );
      }
    }

    if (job.ceiling === "pr") {
      if (job.handoff) {
        if (!team.deskmates[job.handoff]?.coding) {
          throw new Error(
            `job "${id}" handoff "${job.handoff}" must name a deskmate with \`coding\` enabled.`,
          );
        }
      } else if (codingIds.length === 0) {
        throw new Error(`job "${id}" has ceiling "pr" but the team has no coding deskmate to hand off to.`);
      } else if (codingIds.length > 1) {
        throw new Error(
          `job "${id}" has ceiling "pr" and the handoff is ambiguous (${codingIds.join(", ")}) — set \`handoff\`.`,
        );
      } else {
        job.handoff = codingIds[0];
      }
    }
  }
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd packages/core && npx vitest run test/config-jobs.test.ts`
Expected: PASS (13 tests).

- [ ] **Step 6: Run the full core suite**

Run: `cd packages/core && npx vitest run`
Expected: PASS — no regression in the existing config tests.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/config.ts packages/core/test/config-jobs.test.ts
git commit -m "feat(core): add the jobs config block with ceiling validation

A job declares a deskmate, a trigger (cron or webhook), a destination channel
and an autonomy ceiling. Validation rejects a ceiling the deskmate is not
equipped for rather than letting the job discover it at run time."
```

---

### Task 3: Fingerprint markers

**Files:**
- Create: `packages/core/src/jobs/fingerprint.ts`
- Test: `packages/core/test/job-fingerprint.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `JOB_LABEL: "deskmate-job"`; `fingerprintMarker(slug: string): string`; `parseFingerprint(body: string): string | null`.

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/job-fingerprint.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { JOB_LABEL, fingerprintMarker, parseFingerprint } from "../src/jobs/fingerprint.js";

describe("fingerprintMarker", () => {
  it("renders an HTML comment carrying the slug", () => {
    expect(fingerprintMarker("whatsapp-image-upload-fails"))
      .toBe("<!-- deskmate-fingerprint: whatsapp-image-upload-fails -->");
  });
  it.each(["Not-Kebab", "trailing-", "has space", "", "under_score"])("rejects %s", (s) => {
    expect(() => fingerprintMarker(s)).toThrow(/kebab-case/);
  });
});

describe("parseFingerprint", () => {
  it("round-trips a rendered marker", () => {
    expect(parseFingerprint(fingerprintMarker("voice-drops-after-30s"))).toBe("voice-drops-after-30s");
  });
  it("finds the marker inside a larger issue body", () => {
    const body = `## Summary\n\nUsers cannot upload.\n\n${fingerprintMarker("upload-broken")}\n`;
    expect(parseFingerprint(body)).toBe("upload-broken");
  });
  it("tolerates loose whitespace", () => {
    expect(parseFingerprint("<!--deskmate-fingerprint:   spaced-out  -->")).toBe("spaced-out");
  });
  it("returns null when no marker is present", () => {
    expect(parseFingerprint("just an ordinary issue body")).toBeNull();
  });
});

describe("JOB_LABEL", () => {
  it("is the label every job-filed issue carries", () => {
    expect(JOB_LABEL).toBe("deskmate-job");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/core && npx vitest run test/job-fingerprint.test.ts`
Expected: FAIL — cannot resolve `../src/jobs/fingerprint.js`.

- [ ] **Step 3: Implement**

Create `packages/core/src/jobs/fingerprint.ts`:

```ts
/**
 * Deduplication for recurring jobs. The issue tracker IS the ledger: every issue a
 * job files carries the JOB_LABEL and a fingerprint marker, so the next run can find
 * what it already reported without any storage of its own.
 */

/** The label every job-filed issue carries, so a job can scope its search. */
export const JOB_LABEL = "deskmate-job";

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MARKER_RE = /<!--\s*deskmate-fingerprint:\s*([a-z0-9]+(?:-[a-z0-9]+)*)\s*-->/;

/** The marker to embed in an issue body. Throws on a slug that could not be found again. */
export function fingerprintMarker(slug: string): string {
  if (!SLUG_RE.test(slug)) {
    throw new Error(`fingerprint slug "${slug}" must be kebab-case (lowercase words joined by single dashes)`);
  }
  return `<!-- deskmate-fingerprint: ${slug} -->`;
}

/** The slug carried by an issue body, or null when it carries none. */
export function parseFingerprint(body: string): string | null {
  return body.match(MARKER_RE)?.[1] ?? null;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd packages/core && npx vitest run test/job-fingerprint.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/jobs/fingerprint.ts packages/core/test/job-fingerprint.test.ts
git commit -m "feat(core): add job fingerprint markers for issue deduplication"
```

---

### Task 4: `buildJobMessage` — brief, autonomy contract, dedup protocol

**Files:**
- Create: `packages/core/src/jobs/message.ts`
- Test: `packages/core/test/job-message.test.ts`

**Interfaces:**
- Consumes: `JOB_LABEL` (Task 3).
- Produces:
```ts
export type JobCeiling = "digest" | "issue" | "pr";
export interface JobSpec {
  jobId: string; deskmate: string; displayName: string; brief: string;
  ceiling: JobCeiling; maxItems: number; window?: string; handoff?: string;
}
export function buildJobMessage(spec: JobSpec, payload?: unknown): string;
```

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/job-message.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildJobMessage, type JobSpec } from "../src/jobs/message.js";

const spec = (over: Partial<JobSpec> = {}): JobSpec => ({
  jobId: "conversation_review",
  deskmate: "product_analyst",
  displayName: "Product Analyst",
  brief: "Read yesterday's conversations and report what broke.",
  ceiling: "digest",
  maxItems: 3,
  window: "24h",
  ...over,
});

describe("buildJobMessage", () => {
  it("opens with the routing directive naming the deskmate", () => {
    expect(buildJobMessage(spec())).toContain(
      "[routing] Delegate to the `product_analyst` deskmate (Product Analyst).",
    );
  });

  it("tags the run with the job id and the window for a cron job", () => {
    expect(buildJobMessage(spec())).toContain("[proactive:job:conversation_review] window: last 24h");
  });

  it("omits the window for a webhook job and inlines the payload as JSON", () => {
    const msg = buildJobMessage(spec({ window: undefined }), { id: "f1", message: "cannot upload" });
    expect(msg).not.toContain("window:");
    expect(msg).toContain('"message": "cannot upload"');
  });

  it("includes the brief verbatim", () => {
    expect(buildJobMessage(spec())).toContain("Read yesterday's conversations and report what broke.");
  });

  it("forbids external records at the digest ceiling", () => {
    const msg = buildJobMessage(spec());
    expect(msg).toContain("Do NOT create issues, pull requests, or any other external record");
    expect(msg).not.toContain("deskmate-fingerprint");
  });

  it("permits a bounded number of issues at the issue ceiling", () => {
    const msg = buildJobMessage(spec({ ceiling: "issue", maxItems: 2 }));
    expect(msg).toContain("file at most 2 issue(s)");
    expect(msg).toContain("Do not open pull requests");
  });

  it("permits one handoff at the pr ceiling and keeps the approval gate", () => {
    const msg = buildJobMessage(spec({ ceiling: "pr", handoff: "fullstack_engineer" }));
    expect(msg).toContain("hand at most ONE well-scoped item to the `fullstack_engineer` deskmate");
    expect(msg).toContain("approval gate still applies");
  });

  it("includes the dedup protocol above the digest ceiling", () => {
    const msg = buildJobMessage(spec({ ceiling: "issue" }));
    expect(msg).toContain("label:deskmate-job");
    expect(msg).toContain("<!-- deskmate-fingerprint: some-stable-slug -->");
    expect(msg).toContain("add a comment to THAT issue");
  });

  it("always permits finishing silently", () => {
    for (const ceiling of ["digest", "issue"] as const) {
      expect(buildJobMessage(spec({ ceiling }))).toContain("finish silently without posting");
    }
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/core && npx vitest run test/job-message.test.ts`
Expected: FAIL — cannot resolve `../src/jobs/message.js`.

- [ ] **Step 3: Implement**

Create `packages/core/src/jobs/message.ts`:

```ts
import { JOB_LABEL } from "./fingerprint.js";

export type JobCeiling = "digest" | "issue" | "pr";

/** Everything a job run needs, resolved at sync time and passed to the factory. */
export interface JobSpec {
  jobId: string;
  deskmate: string;
  displayName: string;
  brief: string;
  ceiling: JobCeiling;
  maxItems: number;
  /** Cron jobs only — how far back to look. */
  window?: string;
  /** ceiling "pr" only — the coding deskmate that receives the work. */
  handoff?: string;
}

const SILENT = "If nothing clears the bar, finish silently without posting.";

/**
 * The autonomy contract. This is instruction plus capability-gating, not a sandbox:
 * `defineTeam` guarantees the deskmate CAN do what its ceiling allows, and the text
 * below is what tells it where to stop.
 */
function contract(spec: JobSpec): string {
  const lines = ["## What you may do on your own"];
  switch (spec.ceiling) {
    case "digest":
      lines.push(
        "Post your findings to this channel. Do NOT create issues, pull requests, or any " +
          "other external record — reporting is the whole job.",
      );
      break;
    case "issue":
      lines.push(
        `Post your findings to this channel, and file at most ${spec.maxItems} issue(s) for the ` +
          "items that clear the bar. Do not open pull requests and do not change any code.",
      );
      break;
    case "pr":
      lines.push(
        `Post your findings to this channel, and file at most ${spec.maxItems} issue(s) for the ` +
          "items that clear the bar.",
        `You may also hand at most ONE well-scoped item to the \`${spec.handoff}\` deskmate to ` +
          "implement. That deskmate's own approval gate still applies before any pull request opens.",
      );
      break;
  }
  lines.push(SILENT);
  return lines.join("\n");
}

/** How a job avoids re-filing what a previous run already filed. */
function dedupProtocol(): string {
  return [
    "## Before you file anything",
    `Search existing issues for \`label:${JOB_LABEL}\` and look for a line like:`,
    "",
    "    <!-- deskmate-fingerprint: some-stable-slug -->",
    "",
    "If one of them describes the same underlying problem, add a comment to THAT issue with the",
    "new occurrence instead of opening a duplicate. Only when nothing matches, open a new issue",
    `carrying the \`${JOB_LABEL}\` label and its own fingerprint line, using a stable kebab-case`,
    "slug that names the problem itself — not this run's phrasing of it.",
  ].join("\n");
}

/**
 * The full message handed to the front desk for one job run. The `[routing]` directive
 * is the same mechanism the scheduled sweep uses to reach a specific deskmate.
 */
export function buildJobMessage(spec: JobSpec, payload?: unknown): string {
  const header = spec.window
    ? `[proactive:job:${spec.jobId}] window: last ${spec.window}`
    : `[proactive:job:${spec.jobId}]`;

  const sections = [
    `[routing] Delegate to the \`${spec.deskmate}\` deskmate (${spec.displayName}).`,
    header,
    "",
    spec.brief.trimEnd(),
  ];

  if (payload !== undefined) {
    sections.push("", "## The event that triggered this run", "```json", JSON.stringify(payload, null, 2), "```");
  }

  sections.push("", contract(spec));
  if (spec.ceiling !== "digest") sections.push("", dedupProtocol());

  return `${sections.join("\n")}\n`;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd packages/core && npx vitest run test/job-message.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/jobs/message.ts packages/core/test/job-message.test.ts
git commit -m "feat(core): compose the job run message, contract and dedup protocol"
```

---

### Task 5: `createJobSchedule` and the `@deskmate/core/jobs` subpath

**Files:**
- Create: `packages/core/src/jobs/schedule.ts`, `packages/core/src/jobs/index.ts`
- Modify: `packages/core/package.json` (exports map)
- Test: `packages/core/test/job-schedule.test.ts`

**Interfaces:**
- Consumes: `buildJobMessage`, `JobSpec` (Task 4).
- Produces: `createJobSchedule(opts: { cron: string; channelId: string; slack: unknown; job: JobSpec })`; the `@deskmate/core/jobs` entry point re-exporting `createJobSchedule`, `buildJobMessage`, `JobSpec`, `JobCeiling`, `JOB_LABEL`, `fingerprintMarker`, `parseFingerprint`.

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/job-schedule.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { createJobSchedule } from "../src/jobs/schedule.js";
import type { JobSpec } from "../src/jobs/message.js";

const job: JobSpec = {
  jobId: "conversation_review",
  deskmate: "product_analyst",
  displayName: "Product Analyst",
  brief: "Read yesterday's conversations.",
  ceiling: "issue",
  maxItems: 3,
  window: "24h",
};

const slack = { __slack: true };

describe("createJobSchedule", () => {
  it("carries the configured cron", () => {
    expect(createJobSchedule({ cron: "0 6 * * *", channelId: "C0123", slack, job }).cron).toBe("0 6 * * *");
  });

  it("hands the composed message to the target channel under waitUntil", async () => {
    const receive = vi.fn().mockResolvedValue(undefined);
    const waitUntil = vi.fn();
    const appAuth = { authenticator: "app" };

    const schedule = createJobSchedule({ cron: "0 6 * * *", channelId: "C0123", slack, job });
    await schedule.run!({ receive, waitUntil, appAuth } as never);

    expect(waitUntil).toHaveBeenCalledTimes(1);
    expect(receive).toHaveBeenCalledTimes(1);
    const [channel, args] = receive.mock.calls[0];
    expect(channel).toBe(slack);
    expect(args.target).toEqual({ channelId: "C0123" });
    expect(args.auth).toBe(appAuth);
    expect(args.message).toContain("[proactive:job:conversation_review] window: last 24h");
    expect(args.message).toContain("file at most 3 issue(s)");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/core && npx vitest run test/job-schedule.test.ts`
Expected: FAIL — cannot resolve `../src/jobs/schedule.js`.

- [ ] **Step 3: Implement the factory**

Create `packages/core/src/jobs/schedule.ts`:

```ts
import { defineSchedule } from "eve/schedules";
import { buildJobMessage, type JobSpec } from "./message.js";

export interface JobScheduleOptions {
  cron: string;
  /** A Slack conversation id — NOT a channel name; see resolveChannelTarget. */
  channelId: string;
  /** The managed Slack channel, passed opaque to avoid a type dependency. */
  slack: unknown;
  job: JobSpec;
}

/**
 * One cron job as its own eve schedule (and so its own Vercel Cron Job), which is
 * what lets each job carry an independent cadence. The handler owns no channel of
 * its own, so it hands the run to Slack with `receive`.
 */
export function createJobSchedule(opts: JobScheduleOptions) {
  const message = buildJobMessage(opts.job);
  return defineSchedule({
    cron: opts.cron,
    async run({ receive, waitUntil, appAuth }) {
      waitUntil(
        receive(opts.slack as never, {
          message,
          target: { channelId: opts.channelId },
          auth: appAuth,
        }),
      );
    },
  });
}
```

- [ ] **Step 4: Create the subpath barrel**

Create `packages/core/src/jobs/index.ts`:

```ts
export { createJobSchedule, type JobScheduleOptions } from "./schedule.js";
export { buildJobMessage, type JobSpec, type JobCeiling } from "./message.js";
export { JOB_LABEL, fingerprintMarker, parseFingerprint } from "./fingerprint.js";
```

- [ ] **Step 5: Publish the subpath**

In `packages/core/package.json`, add to `exports` after the `"./coding"` entry:

```json
    "./jobs": {
      "types": "./dist/jobs/index.d.ts",
      "default": "./dist/jobs/index.js"
    }
```

- [ ] **Step 6: Run to verify it passes**

Run: `cd packages/core && npx vitest run test/job-schedule.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 7: Verify the built subpath resolves**

Run: `cd packages/core && npx tsc -p tsconfig.build.json --noEmit && node -e "console.log(require('node:fs').existsSync('src/jobs/index.ts'))"`
Expected: no type errors, prints `true`.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/jobs/schedule.ts packages/core/src/jobs/index.ts packages/core/package.json packages/core/test/job-schedule.test.ts
git commit -m "feat(core): add createJobSchedule and the @deskmate/core/jobs subpath"
```

---

### Task 6: `verifyHookSignature`

**Files:**
- Create: `packages/core/src/jobs/signature.ts`
- Test: `packages/core/test/job-signature.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
```ts
export function signHookBody(secret: string, timestamp: string, raw: string): string; // "sha256=<hex>"
export function verifyHookSignature(input: {
  raw: string; secret: string;
  signature: string | null; timestamp: string | null;
  nowMs: number; toleranceSec?: number;
}): boolean;
```
`signHookBody` is exported because senders need a reference implementation and the tests need to build valid inputs.

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/job-signature.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { signHookBody, verifyHookSignature } from "../src/jobs/signature.js";

const secret = "s3cr3t";
const raw = JSON.stringify({ job: "feedback_triage", data: { id: "f1" } });
const nowMs = 1_760_000_000_000;
const ts = String(Math.floor(nowMs / 1000));
const ok = { raw, secret, signature: signHookBody(secret, ts, raw), timestamp: ts, nowMs };

describe("signHookBody", () => {
  it("prefixes the hex digest with sha256=", () => {
    expect(signHookBody(secret, ts, raw)).toMatch(/^sha256=[0-9a-f]{64}$/);
  });
  it("changes when the body changes", () => {
    expect(signHookBody(secret, ts, raw)).not.toBe(signHookBody(secret, ts, `${raw} `));
  });
  it("changes when the timestamp changes", () => {
    expect(signHookBody(secret, ts, raw)).not.toBe(signHookBody(secret, "1", raw));
  });
});

describe("verifyHookSignature", () => {
  it("accepts a correctly signed request", () => {
    expect(verifyHookSignature(ok)).toBe(true);
  });
  it("rejects a tampered body", () => {
    expect(verifyHookSignature({ ...ok, raw: raw.replace("f1", "f2") })).toBe(false);
  });
  it("rejects a signature made with a different secret", () => {
    expect(verifyHookSignature({ ...ok, signature: signHookBody("other", ts, raw) })).toBe(false);
  });
  it("rejects a stale timestamp beyond the replay window", () => {
    expect(verifyHookSignature({ ...ok, nowMs: nowMs + 301_000 })).toBe(false);
  });
  it("rejects a timestamp too far in the future", () => {
    expect(verifyHookSignature({ ...ok, nowMs: nowMs - 301_000 })).toBe(false);
  });
  it("accepts a timestamp inside the replay window", () => {
    expect(verifyHookSignature({ ...ok, nowMs: nowMs + 299_000 })).toBe(true);
  });
  it.each([
    ["missing signature", { signature: null }],
    ["missing timestamp", { timestamp: null }],
    ["non-numeric timestamp", { timestamp: "not-a-number" }],
    ["signature without the sha256 prefix", { signature: "deadbeef" }],
    ["signature of the wrong length", { signature: "sha256=abc" }],
  ])("rejects %s", (_label, over) => {
    expect(verifyHookSignature({ ...ok, ...(over as object) })).toBe(false);
  });
  it("rejects an empty secret rather than trusting an unsigned request", () => {
    expect(verifyHookSignature({ ...ok, secret: "" })).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/core && npx vitest run test/job-signature.test.ts`
Expected: FAIL — cannot resolve `../src/jobs/signature.js`.

- [ ] **Step 3: Implement**

Create `packages/core/src/jobs/signature.ts`:

```ts
import { createHmac, timingSafeEqual } from "node:crypto";

/** How far a timestamp may drift, in seconds, before the request is treated as a replay. */
const DEFAULT_TOLERANCE_SEC = 300;

/**
 * The signature a sender puts in `x-deskmate-signature`. Signing the timestamp with
 * the body is what makes an intercepted request unusable later; the scheme mirrors
 * Slack's so any sender has a reference implementation to copy.
 */
export function signHookBody(secret: string, timestamp: string, raw: string): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${raw}`).digest("hex")}`;
}

export interface VerifyHookInput {
  raw: string;
  secret: string;
  signature: string | null;
  timestamp: string | null;
  nowMs: number;
  toleranceSec?: number;
}

/** Constant-time verification. Any missing or malformed part is a rejection, never a pass. */
export function verifyHookSignature(input: VerifyHookInput): boolean {
  const { raw, secret, signature, timestamp, nowMs } = input;
  const tolerance = input.toleranceSec ?? DEFAULT_TOLERANCE_SEC;
  if (!secret || !signature || !timestamp) return false;

  const sentSec = Number(timestamp);
  if (!Number.isFinite(sentSec)) return false;
  if (Math.abs(nowMs / 1000 - sentSec) > tolerance) return false;

  const expected = Buffer.from(signHookBody(secret, timestamp, raw));
  const actual = Buffer.from(signature);
  // timingSafeEqual throws on a length mismatch, which itself leaks nothing useful
  // here (the expected length is fixed and public), so guard it explicitly.
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd packages/core && npx vitest run test/job-signature.test.ts`
Expected: PASS (14 tests).

- [ ] **Step 5: Export from the barrel**

Add to `packages/core/src/jobs/index.ts`:

```ts
export { signHookBody, verifyHookSignature, type VerifyHookInput } from "./signature.js";
```

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/jobs/signature.ts packages/core/src/jobs/index.ts packages/core/test/job-signature.test.ts
git commit -m "feat(core): verify inbound hook signatures in constant time"
```

---

### Task 7: `createHooksChannel`

**Files:**
- Create: `packages/core/src/jobs/hooks.ts`
- Modify: `packages/core/src/jobs/index.ts`
- Test: `packages/core/test/job-hooks.test.ts`

**Interfaces:**
- Consumes: `buildJobMessage`/`JobSpec` (Task 4), `verifyHookSignature`/`signHookBody` (Task 6).
- Produces: `HOOKS_CHANNEL_ROUTE: "/eve/v1/hooks/:job"`; `handleHookRequest(...)` (the pure request handler, exported for tests); `createHooksChannel(jobs: Record<string, HookJob>, opts: { slack: unknown })` where `HookJob = JobSpec & { channelId: string }`.

The handler is separated from `defineChannel` so it can be tested with a plain `Request`, the same way `clampVerdict` is tested apart from the watch channel.

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/job-hooks.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { handleHookRequest, type HookJob } from "../src/jobs/hooks.js";
import { signHookBody } from "../src/jobs/signature.js";

const secret = "s3cr3t";
const slack = { __slack: true };
const jobs: Record<string, HookJob> = {
  feedback_triage: {
    jobId: "feedback_triage",
    deskmate: "customer_success",
    displayName: "Customer Success Analyst",
    brief: "Triage this feedback.",
    ceiling: "issue",
    maxItems: 3,
    channelId: "C0SUCCESS",
  },
};

const body = JSON.stringify({ job: "feedback_triage", data: { id: "f1", message: "cannot upload" } });
const nowMs = 1_760_000_000_000;
const ts = String(Math.floor(nowMs / 1000));

function request(over: { body?: string; signature?: string | null; timestamp?: string | null } = {}) {
  const raw = over.body ?? body;
  const headers = new Headers({ "content-type": "application/json" });
  const sig = over.signature === undefined ? signHookBody(secret, ts, raw) : over.signature;
  if (sig !== null) headers.set("x-deskmate-signature", sig);
  const t = over.timestamp === undefined ? ts : over.timestamp;
  if (t !== null) headers.set("x-deskmate-timestamp", t);
  return new Request("https://example.test/eve/v1/hooks/feedback_triage", { method: "POST", headers, body: raw });
}

const helpers = () => ({ receive: vi.fn().mockResolvedValue(undefined), waitUntil: vi.fn() });

describe("handleHookRequest", () => {
  it("accepts a signed request and hands the run to Slack", async () => {
    const h = helpers();
    const res = await handleHookRequest(request(), {
      jobs, slack, params: { job: "feedback_triage" }, secret, nowMs, ...h,
    });

    expect(res.status).toBe(202);
    expect(h.waitUntil).toHaveBeenCalledTimes(1);
    const [channel, args] = h.receive.mock.calls[0];
    expect(channel).toBe(slack);
    expect(args.target).toEqual({ channelId: "C0SUCCESS" });
    expect(args.message).toContain("[proactive:job:feedback_triage]");
    expect(args.message).toContain('"message": "cannot upload"');
  });

  it("rejects an unsigned request with 401 and starts nothing", async () => {
    const h = helpers();
    const res = await handleHookRequest(request({ signature: null }), {
      jobs, slack, params: { job: "feedback_triage" }, secret, nowMs, ...h,
    });
    expect(res.status).toBe(401);
    expect(h.receive).not.toHaveBeenCalled();
  });

  it("rejects a tampered body with 401", async () => {
    const h = helpers();
    const tampered = request();
    const res = await handleHookRequest(
      new Request(tampered.url, { method: "POST", headers: tampered.headers, body: body.replace("f1", "f2") }),
      { jobs, slack, params: { job: "feedback_triage" }, secret, nowMs, ...h },
    );
    expect(res.status).toBe(401);
    expect(h.receive).not.toHaveBeenCalled();
  });

  it("returns 503 when no secret is configured, rather than accepting anything", async () => {
    const h = helpers();
    const res = await handleHookRequest(request(), {
      jobs, slack, params: { job: "feedback_triage" }, secret: undefined, nowMs, ...h,
    });
    expect(res.status).toBe(503);
    expect(h.receive).not.toHaveBeenCalled();
  });

  it("returns 404 for an unknown job", async () => {
    const h = helpers();
    const res = await handleHookRequest(request(), {
      jobs, slack, params: { job: "no_such_job" }, secret, nowMs, ...h,
    });
    expect(res.status).toBe(404);
    expect(h.receive).not.toHaveBeenCalled();
  });

  it("returns 400 for a signed but unparseable body", async () => {
    const h = helpers();
    const res = await handleHookRequest(request({ body: "not json" }), {
      jobs, slack, params: { job: "feedback_triage" }, secret, nowMs, ...h,
    });
    expect(res.status).toBe(400);
    expect(h.receive).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/core && npx vitest run test/job-hooks.test.ts`
Expected: FAIL — cannot resolve `../src/jobs/hooks.js`.

- [ ] **Step 3: Implement**

Create `packages/core/src/jobs/hooks.ts`:

```ts
import { defineChannel, POST } from "eve/channels";
import { buildJobMessage, type JobSpec } from "./message.js";
import { verifyHookSignature } from "./signature.js";

/** eve channels declare absolute route paths (cf. /eve/v1/slack, /eve/v1/github). */
export const HOOKS_CHANNEL_ROUTE = "/eve/v1/hooks/:job";

/** A webhook-triggered job: its spec plus the resolved Slack conversation to report into. */
export type HookJob = JobSpec & { channelId: string };

export interface HookRequestContext {
  jobs: Record<string, HookJob>;
  slack: unknown;
  params: { job: string };
  secret: string | undefined;
  nowMs: number;
  receive: (channel: never, args: unknown) => Promise<unknown>;
  waitUntil: (task: Promise<unknown>) => void;
}

/**
 * The whole inbound-hook decision, kept apart from `defineChannel` so it can be
 * driven by a plain Request in tests.
 *
 * Verification comes before job lookup on purpose: an unauthenticated caller learns
 * nothing about which job ids exist.
 */
export async function handleHookRequest(req: Request, ctx: HookRequestContext): Promise<Response> {
  if (!ctx.secret) return new Response("hook secret not configured", { status: 503 });

  const raw = await req.text();
  const verified = verifyHookSignature({
    raw,
    secret: ctx.secret,
    signature: req.headers.get("x-deskmate-signature"),
    timestamp: req.headers.get("x-deskmate-timestamp"),
    nowMs: ctx.nowMs,
  });
  if (!verified) return new Response("unauthorized", { status: 401 });

  const job = ctx.jobs[ctx.params.job];
  if (!job) return new Response("unknown job", { status: 404 });

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return new Response("invalid json", { status: 400 });
  }

  // Hand off in the background and answer immediately: the sender is a product
  // request path and must never wait on an agent run.
  ctx.waitUntil(
    ctx.receive(ctx.slack as never, {
      message: buildJobMessage(job, payload),
      target: { channelId: job.channelId },
      auth: null,
    }),
  );

  return new Response(null, { status: 202 });
}

/**
 * The single channel serving every webhook job, mounted at /eve/v1/hooks/:job.
 * The secret is read per request so a rotated `DESKMATE_HOOK_SECRET` takes effect
 * without a rebuild.
 */
export function createHooksChannel(jobs: Record<string, HookJob>, opts: { slack: unknown }) {
  return defineChannel({
    routes: [
      POST(HOOKS_CHANNEL_ROUTE, async (req, { receive, waitUntil, params }) =>
        handleHookRequest(req, {
          jobs,
          slack: opts.slack,
          params: params as { job: string },
          secret: process.env.DESKMATE_HOOK_SECRET,
          nowMs: Date.now(),
          receive: receive as never,
          waitUntil,
        }),
      ),
    ],
  });
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd packages/core && npx vitest run test/job-hooks.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Export from the barrel**

Add to `packages/core/src/jobs/index.ts`:

```ts
export { createHooksChannel, handleHookRequest, HOOKS_CHANNEL_ROUTE, type HookJob } from "./hooks.js";
```

- [ ] **Step 6: Run the whole core suite and typecheck**

Run: `cd packages/core && npx vitest run`
Then: `cd packages/core && npx tsc --noEmit`
Expected: both PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/jobs/hooks.ts packages/core/src/jobs/index.ts packages/core/test/job-hooks.test.ts
git commit -m "feat(core): serve webhook jobs from a signed /eve/v1/hooks/:job channel"
```

---

### Task 8: Sync renderers for job schedules and the hooks channel

**Files:**
- Modify: `packages/cli/src/sync/render.ts`
- Test: `packages/cli/test/render.test.ts`

**Interfaces:**
- Consumes: `JobSpec`, `HookJob` shapes (Tasks 4 and 7).
- Produces:
```ts
export function renderJobSchedule(input: { jobId: string; cron: string; channelId: string; job: JobSpec }): string;
export function renderHooksChannel(jobs: Record<string, HookJob>): string;
```
Both emit files that import from `@deskmate/core/jobs`, so the contract text lives in the published package rather than in generated output.

- [ ] **Step 1: Write the failing test**

Append to `packages/cli/test/render.test.ts`:

```ts
import { renderJobSchedule, renderHooksChannel } from "../src/sync/render.js";

const spec = {
  jobId: "conversation_review",
  deskmate: "product_analyst",
  displayName: "Product Analyst",
  brief: "Read yesterday's conversations.\nReport what broke.",
  ceiling: "issue" as const,
  maxItems: 3,
  window: "24h",
};

describe("renderJobSchedule", () => {
  const out = renderJobSchedule({ jobId: "conversation_review", cron: "0 6 * * *", channelId: "C0123", job: spec });

  it("carries the generated banner", () => {
    expect(out.startsWith("// GENERATED by `deskmate sync`")).toBe(true);
  });
  it("imports the factory from the core jobs subpath", () => {
    expect(out).toContain('import { createJobSchedule } from "@deskmate/core/jobs";');
    expect(out).toContain('import slack from "../channels/slack.js";');
  });
  it("passes the cron and the resolved channel id", () => {
    expect(out).toContain('cron: "0 6 * * *"');
    expect(out).toContain('channelId: "C0123"');
  });
  it("JSON-encodes a multi-line brief so it cannot break the file", () => {
    expect(out).toContain('"brief": "Read yesterday\'s conversations.\\nReport what broke."');
    expect(out).not.toContain("\n    Report what broke.");
  });
  it("survives a brief containing backticks and template syntax", () => {
    const nasty = renderJobSchedule({
      jobId: "j", cron: "0 6 * * *", channelId: "C0",
      job: { ...spec, brief: "use `sql` and ${danger}" },
    });
    // JSON.stringify emits a DOUBLE-quoted string, where a backtick and a ${} are
    // both inert — which is exactly why the brief is encoded rather than templated.
    expect(nasty).toContain('"brief": "use `sql` and ${danger}"');
  });
});

describe("renderHooksChannel", () => {
  const out = renderHooksChannel({
    feedback_triage: { ...spec, jobId: "feedback_triage", window: undefined, channelId: "C0SUCCESS" },
  });

  it("imports the hooks factory and the slack channel", () => {
    expect(out).toContain('import { createHooksChannel } from "@deskmate/core/jobs";');
    expect(out).toContain('import slack from "../channels/slack.js";');
  });
  it("embeds each job keyed by id", () => {
    expect(out).toContain('"feedback_triage"');
    expect(out).toContain('"channelId": "C0SUCCESS"');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/cli && npx vitest run test/render.test.ts`
Expected: FAIL — `renderJobSchedule is not exported`.

- [ ] **Step 3: Implement**

Append to `packages/cli/src/sync/render.ts`:

```ts
/**
 * `agent/schedules/job-<id>.ts` — one cron job. Each job gets its own file so each
 * becomes its own Vercel Cron Job with an independent cadence (the shared sweep
 * cannot express that). The spec is JSON-encoded, which is what keeps a brief
 * containing backticks or `${}` from breaking the generated module.
 */
export function renderJobSchedule(input: {
  jobId: string;
  cron: string;
  channelId: string;
  job: unknown;
}): string {
  return `${BANNER}
import { createJobSchedule } from "@deskmate/core/jobs";
import slack from "../channels/slack.js";

export default createJobSchedule({
  cron: ${JSON.stringify(input.cron)},
  channelId: ${JSON.stringify(input.channelId)},
  slack,
  job: ${JSON.stringify(input.job, null, 2)},
});
`;
}

/**
 * `agent/channels/hooks.ts` — ONE channel serving every webhook job, mounted at
 * /eve/v1/hooks/:job. Emitted only when at least one job declares `webhook: true`.
 */
export function renderHooksChannel(jobs: Record<string, unknown>): string {
  return `${BANNER}
import { createHooksChannel } from "@deskmate/core/jobs";
import slack from "../channels/slack.js";

export default createHooksChannel(${JSON.stringify(jobs, null, 2)}, { slack });
`;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd packages/cli && npx vitest run test/render.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/sync/render.ts packages/cli/test/render.test.ts
git commit -m "feat(cli): render job schedules and the webhook hooks channel"
```

---

### Task 9: Wire jobs into the sync plan

**Files:**
- Modify: `packages/cli/src/sync/plan.ts`
- Test: `packages/cli/test/plan.test.ts`

**Interfaces:**
- Consumes: `renderJobSchedule`, `renderHooksChannel` (Task 8); `team.jobs` (Task 2); `resolveChannelTarget`, `isSlackChannelId` (Task 1).
- Produces: writes at `agent/schedules/job-<id>.ts` and `agent/channels/hooks.ts`; deletes for removed or disabled jobs; warnings for a missing brief and an unresolvable channel target.

- [ ] **Step 1: Write the failing test**

Append to `packages/cli/test/plan.test.ts`. Follow the file's existing conventions: the
signature is `planSync(team, cwd)`, `cwd` is the module-scoped temp dir built in
`beforeAll`, and `paths()` / `find()` are the existing helpers.

```ts
const jobsTeam = {
  ...fixtureTeam,
  connections: { ...fixtureTeam.connections, githubwrite: { kind: "mcp", env: "GITHUB", write: true } },
  deskmates: {
    ...fixtureTeam.deskmates,
    product_analyst: { ...fixtureTeam.deskmates.product_analyst, reads: ["mixpanel", "githubwrite"] },
  },
  channels: { "ask-product": { deskmate: "product_analyst", id: "C0123ABC" } },
  jobs: {
    review: {
      deskmate: "product_analyst", channel: "ask-product", cron: "0 6 * * *",
      ceiling: "issue", window: "24h", maxItems: 3, enabled: true,
    },
  },
} as unknown as TeamConfig;

describe("planSync jobs", () => {
  beforeAll(() => {
    mkdirSync(join(cwd, "roles/product_analyst/jobs"), { recursive: true });
    writeFileSync(join(cwd, "roles/product_analyst/jobs/review.md"), "Read the conversations.\n");
  });

  it("emits one schedule file per cron job, carrying the brief and resolved id", () => {
    const file = find(planSync(jobsTeam, cwd), "agent/schedules/job-review.ts");
    expect(file).toBeDefined();
    expect(String(file!.contents)).toContain('"brief": "Read the conversations."');
    expect(String(file!.contents)).toContain('channelId: "C0123ABC"');
  });

  it("emits no hooks channel when no job uses a webhook", () => {
    expect(paths(planSync(jobsTeam, cwd))).not.toContain(join(cwd, "agent/channels/hooks.ts"));
  });

  it("emits exactly one hooks channel for any number of webhook jobs", () => {
    const withHooks = {
      ...jobsTeam,
      jobs: {
        review: { ...jobsTeam.jobs.review, cron: undefined, webhook: true },
        other: { ...jobsTeam.jobs.review, cron: undefined, webhook: true, ceiling: "digest" },
      },
    } as unknown as TeamConfig;
    const ps = paths(planSync(withHooks, cwd));
    expect(ps.filter((p) => p === join(cwd, "agent/channels/hooks.ts"))).toHaveLength(1);
    expect(ps.some((p) => p.includes("agent/schedules/job-"))).toBe(false);
  });

  it("warns and stubs the brief when the role file is missing", () => {
    const missing = {
      ...jobsTeam,
      jobs: { absent: { ...jobsTeam.jobs.review } },
    } as unknown as TeamConfig;
    const plan = planSync(missing, cwd);
    expect(plan.warnings.join("\n")).toContain("roles/product_analyst/jobs/absent.md");
    expect(String(find(plan, "agent/schedules/job-absent.ts")!.contents)).toContain("TODO");
  });

  it("warns when the target channel does not resolve to a Slack id", () => {
    const named = {
      ...jobsTeam,
      channels: { "ask-product": { deskmate: "product_analyst" } },
    } as unknown as TeamConfig;
    expect(planSync(named, cwd).warnings.join("\n")).toMatch(/ask-product.*Slack conversation id/s);
  });

  it("treats a disabled job as absent", () => {
    const off = {
      ...jobsTeam,
      jobs: { review: { ...jobsTeam.jobs.review, enabled: false } },
    } as unknown as TeamConfig;
    expect(paths(planSync(off, cwd))).not.toContain(join(cwd, "agent/schedules/job-review.ts"));
  });

  it("deletes a generated schedule for a job that is gone", () => {
    const stale = join(cwd, "agent/schedules/job-stale.ts");
    mkdirSync(join(cwd, "agent/schedules"), { recursive: true });
    writeFileSync(stale, "// old\n");
    const none = { ...jobsTeam, jobs: {} } as unknown as TeamConfig;
    expect(planSync(none, cwd).deletes).toContain(stale);
    rmSync(stale, { force: true });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/cli && npx vitest run test/plan.test.ts`
Expected: FAIL — no `job-review.ts` write is produced.

- [ ] **Step 3: Implement**

In `packages/cli/src/sync/plan.ts`, add the imports:

```ts
import { isSlackChannelId, resolveChannelTarget } from "@deskmate/core";
import { renderHooksChannel, renderJobSchedule } from "./render.js";
```

Then, after the memory-reflection block and before `return { writes, deletes, warnings }`:

```ts
  // ── Proactive jobs ──────────────────────────────────────────────────────────
  // One schedule file per cron job (so each gets its own Vercel Cron Job and its own
  // cadence) and ONE hooks channel for every webhook job. sync OWNS agent/**, so any
  // previously generated file for a job that is gone or disabled must be DELETED —
  // a stale schedule keeps firing forever otherwise.
  const activeJobs = Object.entries(team.jobs).filter(([, j]) => j.enabled);
  const hookJobs: Record<string, unknown> = {};
  const jobFiles = new Set<string>();

  for (const [jobId, job] of activeJobs) {
    const d = team.deskmates[job.deskmate];
    const route = team.channels[job.channel];
    const channelId = resolveChannelTarget(job.channel, route);
    if (!isSlackChannelId(channelId)) {
      warnings.push(
        `job "${jobId}": channel "${job.channel}" does not resolve to a Slack conversation id — ` +
          `set \`id: "C…"\` on that channel, or the job's output has nowhere to land.`,
      );
    }

    const briefFile = job.brief ?? `${jobId}.md`;
    const briefPath = join(cwd, "roles", d.role, "jobs", briefFile);
    let brief: string;
    if (existsSync(briefPath)) {
      brief = readFileSync(briefPath, "utf8").trim();
    } else {
      brief = `<!-- TODO: no brief found at roles/${d.role}/jobs/${briefFile}. Add one, then re-run \`deskmate sync\`. -->`;
      warnings.push(`job "${jobId}": no brief at roles/${d.role}/jobs/${briefFile} — the run will have no instructions.`);
    }

    const spec = {
      jobId,
      deskmate: job.deskmate,
      displayName: d.displayName,
      brief,
      ceiling: job.ceiling,
      maxItems: job.maxItems,
      ...(job.cron ? { window: job.window } : {}),
      ...(job.handoff ? { handoff: job.handoff } : {}),
    };

    if (job.cron) {
      const rel = `agent/schedules/job-${jobId}.ts`;
      out(rel, renderJobSchedule({ jobId, cron: job.cron, channelId, job: spec }));
      jobFiles.add(rel);
    } else {
      hookJobs[jobId] = { ...spec, channelId };
    }
  }

  // Stale per-job schedules: anything matching job-*.ts we did not just write.
  const schedulesDir = join(cwd, "agent", "schedules");
  for (const name of tsFiles(schedulesDir)) {
    if (!name.startsWith("job-")) continue;
    if (!jobFiles.has(`agent/schedules/${name}`)) deletes.push(join(schedulesDir, name));
  }

  const hooksPath = join(cwd, "agent", "channels", "hooks.ts");
  if (Object.keys(hookJobs).length > 0) {
    out("agent/channels/hooks.ts", renderHooksChannel(hookJobs as never));
  } else if (existsSync(hooksPath)) {
    deletes.push(hooksPath);
  }
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd packages/cli && npx vitest run test/plan.test.ts`
Expected: PASS, including the existing idempotency test.

- [ ] **Step 5: Run the whole CLI suite and typecheck**

Run: `cd packages/cli && npx vitest run`
Then: `cd packages/cli && npx tsc --noEmit`
Expected: both PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/sync/plan.ts packages/cli/test/plan.test.ts
git commit -m "feat(cli): generate job schedules and the hooks channel from config"
```

---

### Task 10: Documentation, end-to-end proof, and release

**Files:**
- Modify: `README.md` (a "Proactive jobs" section beside "Proactive watching")
- Create: a scratch consumer under `/tmp` for the build + dev proof (not committed)

- [ ] **Step 1: Document the feature**

Add a `## Proactive jobs` section to `README.md` covering: the `jobs` config block and every field; where briefs live (`roles/<role>/jobs/<job-id>.md`); the three ceilings and that they are cumulative, instruction-enforced and capability-gated rather than sandboxed; the `write` flag on connections and the `id` on channel routes; `DESKMATE_HOOK_SECRET` and the exact signature scheme with a copy-pasteable sender snippet using `signHookBody`; and the dev dispatch commands from Step 3.

- [ ] **Step 2: Build the packages**

Run: `pnpm -w run build:packages`
Expected: SUCCESS, and `packages/core/dist/jobs/index.js` exists.

- [ ] **Step 3: Prove it end to end against a scratch consumer**

Use an existing example under `examples/` (or `pnpm dlx @deskmate/cli init` into a `/tmp` dir), point its `package.json` at the local packages with `file:` links, add one cron job and one webhook job to its config plus their briefs, then:

```bash
pnpm sync          # writes agent/schedules/job-*.ts and agent/channels/hooks.ts
pnpm build         # deskmate sync && eve build — the ONLY gate that catches eve Discovery errors
npx eve dev &
curl -X POST http://localhost:3000/eve/v1/dev/schedules/job-<id>
```
Expected: the dispatch route returns `{"scheduleId":"job-<id>","sessionIds":["…"]}`.

Then sign and post a webhook, with `DESKMATE_HOOK_SECRET` exported in the dev server's environment:

```bash
BODY='{"job":"feedback_triage","event":"feedback.created","data":{"id":"f1","message":"hi"}}'
TS=$(date +%s)
SIG="sha256=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$DESKMATE_HOOK_SECRET" -hex | sed 's/^.* //')"
curl -i -X POST http://localhost:3000/eve/v1/hooks/feedback_triage \
  -H "content-type: application/json" \
  -H "x-deskmate-timestamp: $TS" -H "x-deskmate-signature: $SIG" -d "$BODY"
```
Expected: `202`. Repeat with a mangled signature and expect `401`.

If `auth: null` is rejected by `receive` at runtime, that surfaces here as a failed handoff in the dev log. The fix is to thread an app principal through `handleHookRequest`; adjust `hooks.ts` and its test together.

- [ ] **Step 4: Run every gate separately**

```bash
pnpm lint
pnpm typecheck
pnpm test
```
Read each result on its own — never chain them through a pipe whose exit status can hide a failure.

- [ ] **Step 5: Commit and open the PR**

```bash
git add README.md
git commit -m "docs: document proactive jobs, ceilings and the hook signature scheme"
git push -u origin feat/proactive-jobs
gh pr create --title "feat: proactive jobs (scheduled + webhook-triggered)" --body "$(cat <<'EOF'
Adds named jobs: a deskmate, a trigger (cron or webhook), a destination channel and
a declared autonomy ceiling.

- `jobs` config block, validated in `defineTeam`
- one `agent/schedules/job-<id>.ts` per cron job — independent cadences
- one signed `agent/channels/hooks.ts` at `/eve/v1/hooks/:job` for webhook jobs
- GitHub-as-ledger deduplication via a fingerprint marker, no new storage
- `write` on connections and `id` on channel routes (the latter also fixes a latent
  sweep bug: a name-keyed channel produced a target Slack cannot resolve)

Design: `docs/plans/2026-08-18-proactive-jobs-design.md`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 6: After merge, confirm the release**

release-please opens a "chore: release" PR. Merging it publishes `@deskmate/core` 0.4.0 and `@deskmate/cli` 0.6.0. Verify with `npm view @deskmate/core version` before starting the AddMeIn plan, which pins these versions.
