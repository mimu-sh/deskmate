import { z } from "zod";

const ConnectionConfig = z
  .object({
    kind: z.literal("mcp"),
    env: z.string().optional(), // token model → <ENV>_MCP_URL/_TOKEN
    connect: z.string().min(1).optional(), // oauth model → app-scoped Vercel Connect connector UID
    service: z.string().min(1).optional(), // oauth model → Connect service id for `vercel connect create`
    // Declares that this connection can mutate the remote system. Consumed by job
    // ceiling validation; read-only is the default and the overwhelming majority.
    write: z.boolean().default(false),
  })
  .refine((c) => !(c.env && c.connect), {
    message: "a connection uses either `env` (token) or `connect` (oauth), not both",
  })
  .refine((c) => !(c.service && !c.connect), {
    message: "`service` only applies to an oauth (`connect`) connection",
  });

const MemorySetting = z.object({
  maxItems: z.number().int().positive().default(200),
  coreLimit: z.number().int().positive().default(25),
});

const CodingSetting = z.object({
  // Repo allowlist as owner/name globs (e.g. "acme/*"). Empty = any repo in the
  // team's github.org. Every entry must resolve to the single configured github.org
  // (validated in defineTeam) so onSession can broker one installation token.
  repos: z.array(z.string()).default([]),
});

const DeskmateConfig = z.object({
  role: z.string(),
  emoji: z.string(),
  displayName: z.string(),
  summary: z.string(),
  reads: z.array(z.string()).default([]),
  model: z.string().optional(),
  skill: z.string().optional(),
  voice: z.string().optional(), // one line of persona/register, injected under the shared house style
  // Opt-in cross-thread memory. `true` normalizes to the MemorySetting defaults;
  // `false`/omitted stay off (undefined). An object opts in with overrides, and its
  // branch parses through MemorySetting so inner defaults (e.g. coreLimit) still apply.
  memory: z.union([z.boolean(), MemorySetting]).optional().transform((m) => {
    if (m === undefined || m === false) return undefined;
    return m === true ? MemorySetting.parse({}) : m;
  }),
  // Opt-in agentic-coding capability. `true` normalizes to the CodingSetting defaults
  // (empty repos = any repo in the team's github.org); `false`/omitted stay off
  // (undefined). An object opts in with a repo allowlist. Mirrors `memory` above; a
  // coding deskmate requires the team's `github` block (validated in defineTeam).
  coding: z.union([z.boolean(), CodingSetting]).optional().transform((c) => {
    if (c === undefined || c === false) return undefined;
    return c === true ? CodingSetting.parse({}) : c;
  }),
});

const ChannelWatch = z.object({
  react: z.boolean().default(true),
  reply: z.boolean().default(true),
  post: z.boolean().default(false),
  approvePosts: z.boolean().default(false),
  picker: z.enum(["routed", "frontdesk"]).default("routed"),
  reactionPalette: z.array(z.string()).nonempty().optional(),
  digest: z.boolean().optional(),
});

// `watch` is `.optional()` (NOT `.default({})`): an omitted `watch` means "not
// watched" and stays undefined, while a present `watch` (even `{}`) is re-parsed so
// the inner `.default()`s fill in. zod v4's `.default({})` would return the literal
// `{}` without re-parsing, skipping those inner defaults: the same gotcha the
// `frontDesk` field above documents with `.prefault({})`.
const ChannelRoute = z.object({
  deskmate: z.string(),
  // The Slack conversation id, when the key is a human-readable name. `receive()`
  // hands `target.channelId` straight to Slack, which cannot resolve a bare name.
  id: z.string().min(1).optional(),
  lock: z.boolean().optional(),
  watch: ChannelWatch.optional(),
});

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

const TeamConfig = z.object({
  model: z.string().default("anthropic/claude-sonnet-5"),
  // .prefault({}) (not .default({})) so the inner maxTurns default is applied when
  // frontDesk is omitted: zod v4's .default() returns the fallback value as-is
  // without re-parsing it, whereas .prefault() runs it through the schema.
  frontDesk: z.object({ maxTurns: z.number().int().positive().default(6) }).prefault({}),
  sweep: z.object({ cron: z.string() }).optional(),
  // Team-level memory knob. `memory.reflect.cron` is consumed by `deskmate sync`, which
  // renders the nightly reflection ("dreaming") schedule's cron from it.
  memory: z.object({ reflect: z.object({ cron: z.string() }).optional() }).optional(),
  // GitHub App wiring for coding deskmates. Only the non-secret `org` lives here; the
  // App secrets (GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY / GITHUB_WEBHOOK_SECRET) come
  // from env, like MCP connection tokens. A deskmate with `coding` enabled requires it.
  // `channel: true` also mounts eve's root GitHub App channel (@mentions on issues/PRs).
  github: z.object({ org: z.string().min(1), channel: z.boolean().optional() }).optional(),
  connections: z.record(z.string(), ConnectionConfig).default({}),
  deskmates: z.record(z.string(), DeskmateConfig).default({}),
  channels: z.record(z.string(), ChannelRoute).default({}),
  jobs: z.record(z.string(), JobConfig).default({}),
});

export type TeamConfig = z.infer<typeof TeamConfig>;
export type DeskmateConfig = z.infer<typeof DeskmateConfig>;
export type ConnectionConfig = z.infer<typeof ConnectionConfig>;
export type CodingSetting = z.infer<typeof CodingSetting>;
export type JobConfig = z.infer<typeof JobConfig>;

// Deskmate ids and connection names become directory names AND import specifiers in
// the generated `agent/**` tree, so they must be safe snake_case identifiers (same
// guard as `deskmate mcp-add`). Channel keys are exempt — they are Slack channel ids.
const IDENTIFIER_RE = /^[a-z][a-z0-9_]*$/;

export function defineTeam(input: unknown): TeamConfig {
  const team = TeamConfig.parse(input);
  for (const id of Object.keys(team.deskmates)) {
    if (!IDENTIFIER_RE.test(id)) {
      throw new Error(
        `deskmate id "${id}" must be snake_case (a lowercase letter, then letters/digits/underscores) — ` +
          `it becomes a directory name and import specifier.`,
      );
    }
  }
  for (const name of Object.keys(team.connections)) {
    if (!IDENTIFIER_RE.test(name)) {
      throw new Error(
        `connection name "${name}" must be snake_case (a lowercase letter, then letters/digits/underscores) — ` +
          `it becomes a directory name and import specifier.`,
      );
    }
  }
  for (const [id, d] of Object.entries(team.deskmates)) {
    // `role` is used as a filesystem path segment by `deskmate sync` (roles/<role>/…
    // and the generated re-export specifiers), so guard it with the same identifier
    // rule as ids/connection names — otherwise a value like "../.." could traverse
    // outside roles/.
    if (!IDENTIFIER_RE.test(d.role)) {
      throw new Error(
        `deskmate "${id}" has role "${d.role}" which must be snake_case (a lowercase letter, then ` +
          `letters/digits/underscores) — it becomes a directory path segment (roles/<role>/…).`,
      );
    }
    for (const r of d.reads) {
      if (!team.connections[r]) throw new Error(`deskmate "${id}" reads unknown connection "${r}"`);
    }
  }
  for (const [ch, route] of Object.entries(team.channels)) {
    if (!team.deskmates[route.deskmate]) throw new Error(`channel "${ch}" routes to unknown deskmate "${route.deskmate}"`);
  }
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
  // Coding deskmates require the team `github` block, and every repo in their allowlist
  // must resolve to that single org (Phase 1 brokers one installation token per session).
  for (const [id, d] of Object.entries(team.deskmates)) {
    if (!d.coding) continue;
    if (!team.github) {
      throw new Error(
        `deskmate "${id}" has coding enabled but the team has no \`github\` block — set ` +
          `github.org (and the GITHUB_APP_* env).`,
      );
    }
    for (const r of d.coding.repos) {
      const parts = r.split("/");
      const [owner, name] = parts;
      // Exactly two segments; the name must be a plain repo name OR exactly "*".
      // A partial glob like "api-*" is rejected — it isn't a real repo, and it would
      // otherwise make the sandbox read-token fall back to org-wide (the "*" branch in
      // sandboxRepoScope), silently broadening clone access beyond the allowlist.
      const nameOk = name === "*" || /^[A-Za-z0-9._-]+$/.test(name ?? "");
      if (parts.length !== 2 || owner !== team.github.org || !nameOk) {
        throw new Error(
          `deskmate "${id}" coding.repos entry "${r}" must be within the single configured ` +
            `github.org "${team.github.org}" as "owner/name" or "owner/*" (e.g. "${team.github.org}/api").`,
        );
      }
    }
  }
  return team;
}
