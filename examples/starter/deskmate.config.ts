import { defineTeam } from "@deskmate/core";

/**
 * The deskmate team for this app. `deskmate sync` reads this file and regenerates
 * the entire `agent/**` tree Eve discovers at build time — so this config (plus the
 * authored `roles/<id>/` files) is the single source of truth. Edit here, then run
 * `deskmate sync` (the `build` script does it for you).
 */
export default defineTeam({
  // Default model for the front desk and any deskmate that doesn't override it.
  // Models resolve through the Vercel AI Gateway.
  model: "anthropic/claude-sonnet-5.5",

  // GitHub App wiring for coding deskmates (see the `engineer` entry below).
  // Only the org lives here; the App secrets come from env (GITHUB_APP_ID /
  // GITHUB_APP_PRIVATE_KEY). Uncomment + set your org to enable coding. Add
  // `channel: true` to also mount eve's GitHub channel (@mentions on issues/PRs).
  // github: { org: "your-org" /*, channel: true */ },

  // External data each deskmate can read. `kind: "mcp"` connections map to an
  // <ENV>_MCP_URL / <ENV>_MCP_TOKEN pair (see the generated .env.example).
  connections: {
    mixpanel: { kind: "mcp", env: "MIXPANEL" },
    sentry: { kind: "mcp", env: "SENTRY" },
    // OAuth (Vercel Connect) connection — app-scoped, no URL/token env. The connector
    // UID is `<service>/<name>` (what `vercel connect create <service> --name <name>` mints).
    // Scaffold with `deskmate mcp-add vercel` (choose oauth), then `deskmate connect vercel`.
    // vercel: { kind: "mcp", connect: "mcp.vercel.com/deskmate", service: "mcp.vercel.com" },
  },

  // The roster. Each entry's `role` names the authored `roles/<id>/` directory;
  // `reads` lists the connections that deskmate may query.
  deskmates: {
    product_analyst: {
      role: "product_analyst",
      emoji: ":bar_chart:",
      displayName: "Product Analyst",
      summary:
        "Turns product usage data into a short narrative: what changed, why, what to look at next.",
      skill: "ncklrs/startup-os-skills@product-analyst",
      voice: "Calm analyst. States what moved and the number behind it, then what to look at next. No hype.",
      reads: ["mixpanel"],
      // Opt into cross-thread memory: this deskmate can remember/recall/forget durable
      // facts across threads, and its core memory is pinned into context each turn.
      memory: true,
    },
    devops: {
      role: "devops",
      emoji: ":wrench:",
      displayName: "DevOps Engineer",
      summary:
        "Triages errors and incidents from logs/monitoring, explains likely causes, and proposes (never auto-applies) fixes.",
      skill: "erichowens/some_claude_skills@logging-observability",
      voice: "Terse SRE. Leads with the punchline, shows the query he ran, flags risk plainly. Dry, not chatty.",
      reads: ["sentry"],
    },
    // A coding deskmate: clones a repo, makes a scoped change on a branch, and opens
    // a PR (never the default branch, never merges). Requires the `github` block above
    // + the GITHUB_APP_* env. `coding.repos` is the allowlist (globs within github.org).
    // engineer: {
    //   role: "engineer",
    //   emoji: ":technologist:",
    //   displayName: "Software Engineer",
    //   summary:
    //     "Clones a repo, makes a scoped change on a branch, and opens a PR — never pushes to default, never merges.",
    //   voice: "Pragmatic senior engineer. States the plan in one line, keeps the diff minimal, links the PR.",
    //   reads: [],
    //   coding: { repos: ["your-org/*"] },
    // },
  },

  // Proactive watching is opt-in per channel. Uncomment and set a real Slack channel id
  // (the Cxxxx from the channel's "Copy link") to have a deskmate watch it.
  channels: {
    // "C0123INCIDENTS": {
    //   deskmate: "devops",
    //   watch: {
    //     react: true,        // add topic-appropriate emoji reactions (👀/✅/🎉/⚠️…)
    //     reply: true,        // answer in-thread when it can help
    //     post: false,        // top-level posts (loudest) — off by default
    //     picker: "routed",   // "routed" = the channel's deskmate; "frontdesk" = pick by domain
    //     // digest: true,    // include this channel in the daily scheduled sweep
    //   },
    // },
  },
  // Team-level sweep cadence (one static cron; only used if a channel sets digest: true).
  // sweep: { cron: "0 9 * * 1-5" },
});
