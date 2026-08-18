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
    case "pr": {
      if (!spec.handoff) {
        throw new Error(
          `job "${spec.jobId}" has ceiling "pr" but no handoff deskmate — the contract must name ` +
            `who receives the work.`,
        );
      }
      lines.push(
        `Post your findings to this channel, and file at most ${spec.maxItems} issue(s) for the ` +
          "items that clear the bar.",
        `You may also hand at most ONE well-scoped item to the \`${spec.handoff}\` deskmate to ` +
          "implement. That deskmate's own approval gate still applies before any pull request opens.",
      );
      break;
    }
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
