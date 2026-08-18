import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { TeamConfig } from "@deskmate/core";
import { isSlackChannelId, resolveChannelTarget } from "@deskmate/core";
import type { HookJob } from "@deskmate/core/jobs";
import {
  renderAvatarsChannel,
  renderChannelRoutes,
  renderDeskmateSaysTool,
  renderDeskmateSweepSchedule,
  renderEnvExample,
  renderEveChannel,
  renderFrontDeskInstructions,
  renderHooksChannel,
  renderJobSchedule,
  renderMemoryInstructions,
  renderMemoryReflectionSchedule,
  renderMemoryTool,
  renderReexport,
  renderCodingInstructions,
  renderCodingSandbox,
  renderCodingTool,
  renderGithubChannel,
  renderRootAgent,
  renderRosterRegistry,
  renderSlackAmbientChannel,
  renderSlackChannel,
  renderStubConnection,
  renderSubagentAgent,
  renderSubagentInstructions,
} from "./render.js";

export type FileWrite = { path: string; contents: string | Buffer };
export type SyncPlan = {
  writes: FileWrite[];
  deletes: string[];
  /** Human-readable notes (stubbed connections, missing instructions) for the CLI to surface. */
  warnings: string[];
};

// Placeholder written when a deskmate has no authored roles/<role>/instructions.md.
// `deskmate add` always copies one, so this only fires for a hand-added deskmate.
function missingInstructions(id: string, role: string): string {
  return `# ${id}\n\n<!-- TODO: no authored roles/${role}/instructions.md found. Add one, then re-run \`deskmate sync\`. -->\n`;
}

/** Directory entries that are themselves directories, sorted for deterministic output. */
function subdirs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => {
      try {
        return statSync(join(dir, name)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();
}

/** `*.ts` files in a dir (non-recursive), sorted for deterministic output. */
function tsFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".ts"))
    .sort();
}

/**
 * Every file under `root`, recursively, as POSIX-style paths relative to `root`
 * (including dotfiles/dirs like `templates/.github/…`). Entries are sorted at each
 * directory level, so the flattened list is deterministic → idempotent writes.
 */
function walkFiles(root: string, prefix = ""): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const name of readdirSync(root).sort()) {
    const abs = join(root, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    if (statSync(abs).isDirectory()) out.push(...walkFiles(abs, rel));
    else out.push(rel);
  }
  return out;
}

/**
 * Compute the full set of file writes + directory deletes that rebuild `agent/**`
 * from the consumer's `deskmate.config.ts` (passed in as a parsed `team` object)
 * and their authored `roles/<id>/` + shared `connections/` files under `cwd`.
 *
 * Pure w.r.t. its inputs (team + the filesystem under cwd): it performs no writes.
 * Deterministic — directory listings are sorted — so re-running with the same
 * inputs yields byte-identical `writes` (see the idempotency test). All returned
 * paths are absolute (joined to `cwd`).
 */
export function planSync(team: TeamConfig, cwd: string): SyncPlan {
  const writes: FileWrite[] = [];
  const warnings: string[] = [];
  const out = (rel: string, contents: string | Buffer) =>
    writes.push({ path: join(cwd, rel), contents });

  // ── Root files ────────────────────────────────────────────────────────────
  out("agent/agent.ts", renderRootAgent(team));
  out("agent/instructions.md", renderFrontDeskInstructions());
  out("agent/lib/deskmates.ts", renderRosterRegistry(team));
  out("agent/lib/channel-routes.ts", renderChannelRoutes(team));
  out("agent/tools/deskmate_says.ts", renderDeskmateSaysTool());
  out("agent/channels/slack.ts", renderSlackChannel(team));
  out("agent/channels/slack-ambient.ts", renderSlackAmbientChannel(team));
  out("agent/channels/eve.ts", renderEveChannel());
  out("agent/channels/deskmate-avatars.ts", renderAvatarsChannel());
  out(".env.example", renderEnvExample(team));

  // ── Per-deskmate subagent tree ──────────────────────────────────────────────
  // OUTPUT paths are keyed by the deskmate `id` (agent/subagents/<id>/…); AUTHORED
  // SOURCE paths are keyed by `d.role`, so a deskmate whose id differs from its role
  // (e.g. `ops: { role: "devops" }`) still resolves its authored files under
  // `roles/<role>/`. `role` is schema-required, so the common id == role case is
  // unchanged.
  for (const [id, d] of Object.entries(team.deskmates)) {
    const role = d.role;
    out(`agent/subagents/${id}/agent.ts`, renderSubagentAgent(id));

    // instructions.md — authored role instructions composed with core's shared
    // house-style block (voice + work discipline) + the deskmate's optional `voice`.
    const instrPath = join(cwd, "roles", role, "instructions.md");
    const hasInstructions = existsSync(instrPath);
    const roleInstructions = hasInstructions ? readFileSync(instrPath, "utf8") : missingInstructions(id, role);
    if (!hasInstructions) {
      warnings.push(`deskmate "${id}": no authored roles/${role}/instructions.md — wrote a TODO placeholder.`);
    }
    out(`agent/subagents/${id}/instructions.md`, renderSubagentInstructions(roleInstructions, d.voice));

    // tools/<tool>.ts — one re-export shim per authored roles/<role>/tools/*.ts.
    for (const tool of tsFiles(join(cwd, "roles", role, "tools"))) {
      out(
        `agent/subagents/${id}/tools/${tool}`,
        renderReexport(`../../../../roles/${role}/tools/${tool.replace(/\.ts$/, ".js")}`, { star: true }),
      );
    }

    // connections/<name>.ts — one shim per `reads` name. Resolution order:
    //   1. deskmate-local  roles/<role>/connections/<name>.ts
    //   2. shared          connections/<name>.ts   (repo root)
    //   3. TODO stub       (neither exists — don't crash)
    for (const name of d.reads) {
      const local = join(cwd, "roles", role, "connections", `${name}.ts`);
      const shared = join(cwd, "connections", `${name}.ts`);
      let contents: string;
      if (existsSync(local)) {
        contents = renderReexport(`../../../../roles/${role}/connections/${name}.js`, { star: true });
      } else if (existsSync(shared)) {
        contents = renderReexport(`../../../../connections/${name}.js`, { star: true });
      } else {
        contents = renderStubConnection(name, team.connections[name]);
        warnings.push(
          `deskmate "${id}": connection "${name}" has no authored file (roles/${role}/connections/${name}.ts ` +
            `or connections/${name}.ts) — wrote a TODO stub.`,
        );
      }
      out(`agent/subagents/${id}/connections/${name}.ts`, contents);
    }

    // skills/** — the deskmate's authored skill playbooks (SKILL.md + rules/
    // references/templates), copied VERBATIM with their nested structure. These
    // are markdown/asset files Eve discovers under agent/subagents/<id>/skills/;
    // they are copied like instructions.md (no shim, no banner). The `skill`
    // field in the config stays metadata — sync just copies the tree. Read as a
    // Buffer (no encoding) so a binary asset in a skill (e.g. a diagram PNG/PDF)
    // is copied byte-for-byte instead of being mangled by UTF-8 decoding.
    const skillsRoot = join(cwd, "roles", role, "skills");
    for (const rel of walkFiles(skillsRoot)) {
      out(`agent/subagents/${id}/skills/${rel}`, readFileSync(join(skillsRoot, rel)));
    }

    // Cross-thread memory shims — ONLY for a deskmate that opts into `memory`
    // (d.memory is undefined when off, so a non-memory deskmate emits none of these).
    // Three tool shims + a dynamic-recall instructions entry that COEXISTS with the
    // composed root instructions.md above (eve reads instructions/* beside it). All
    // logic lives in @deskmate/core/memory; the shims just bind it to this id.
    //
    // NOTE: d.memory.maxItems is intentionally NOT read here — it is not yet plumbed to
    // the store (adapters use a global 200-row cap). Only coreLimit is wired, via the
    // instructions shim below. (Tracked as a follow-up; do not plumb maxItems here.)
    if (d.memory) {
      for (const tool of ["remember", "recall", "forget"] as const) {
        out(`agent/subagents/${id}/tools/${tool}.ts`, renderMemoryTool(id, tool));
      }
      out(`agent/subagents/${id}/instructions/memory.ts`, renderMemoryInstructions(id, d.memory.coreLimit));
    }

    // Agentic-coding capability — ONLY for a deskmate that opts into `coding` (and
    // whose team declares `github`; defineTeam guarantees the pair). Emits the
    // deskmate's own sandbox (brokers the org's install token + locks egress), the
    // approval-gated push+PR tool, and the coding safety-rules instructions module.
    // All logic lives in @deskmate/core/coding; the shims bind it by id + org + repos.
    // Turning `coding` off simply stops emitting these (sync wipes the subagent dir first).
    if (d.coding && team.github) {
      const coding = { org: team.github.org, repos: d.coding.repos };
      out(`agent/subagents/${id}/sandbox.ts`, renderCodingSandbox(coding));
      out(`agent/subagents/${id}/tools/open_pull_request.ts`, renderCodingTool(id, coding));
      out(`agent/subagents/${id}/instructions/coding.ts`, renderCodingInstructions());
    }
  }

  // ── Deletes: generated subagent dirs for deskmates no longer in the config ──
  const deletes: string[] = [];
  for (const existing of subdirs(join(cwd, "agent", "subagents"))) {
    if (!team.deskmates[existing]) deletes.push(join(cwd, "agent", "subagents", existing));
  }

  // ── Phase-2 scheduled sweep ─────────────────────────────────────────────────
  // Runs only for channels with BOTH watch.digest AND watch.post: a sweep session has
  // no thread, so any non-silent output is a top-level post — which post: false forbids
  // (warn on digest-without-post). sync OWNS agent/**, so when nothing qualifies we must
  // DELETE any previously generated sweep file, else a stale schedule keeps firing.
  const digestChannels = Object.entries(team.channels).filter(([, r]) => r.watch?.digest === true);
  for (const [ch, r] of digestChannels) {
    if (r.watch?.post !== true) {
      warnings.push(
        `channel "${ch}": watch.digest needs watch.post: true to run — a scheduled sweep can only ` +
          `post top-level, so with post: false it is skipped.`,
      );
    }
  }
  // ── Phase-2 GitHub channel (root-only) ──────────────────────────────────────
  // Mounted when `github.channel` is set: @mentions on issues/PRs get an eve
  // auto-checkout + commit/push with the firewall-brokered install token. sync OWNS
  // agent/**, so when the flag is off we DELETE any previously generated channel file.
  const githubChannelPath = join(cwd, "agent", "channels", "github.ts");
  if (team.github?.channel) {
    out("agent/channels/github.ts", renderGithubChannel());
  } else if (existsSync(githubChannelPath)) {
    deletes.push(githubChannelPath);
  }

  const sweepPath = join(cwd, "agent", "schedules", "deskmate-sweep.ts");
  if (digestChannels.some(([, r]) => r.watch?.post === true)) {
    out("agent/schedules/deskmate-sweep.ts", renderDeskmateSweepSchedule(team));
  } else if (existsSync(sweepPath)) {
    deletes.push(sweepPath);
  }

  // ── Deployment-root memory reflection ("dreaming") schedule ─────────────────
  // Root-only (schedules can't live under a subagent). Emitted ONCE iff ≥1 deskmate
  // opts into memory, wiring every memory-enabled id + the team's reflect cron. ids
  // stay in config order (like the roster) — deterministic given the same config. As
  // with the sweep, sync OWNS agent/**, so when no deskmate has memory we DELETE any
  // previously generated file, else a stale schedule keeps firing.
  const memoryIds = Object.entries(team.deskmates)
    .filter(([, d]) => d.memory)
    .map(([id]) => id);
  const reflectPath = join(cwd, "agent", "schedules", "memory-reflection.ts");
  if (memoryIds.length > 0) {
    out("agent/schedules/memory-reflection.ts", renderMemoryReflectionSchedule(memoryIds, team.memory?.reflect?.cron));
  } else if (existsSync(reflectPath)) {
    deletes.push(reflectPath);
  }

  // ── Proactive jobs ──────────────────────────────────────────────────────────
  // One schedule file per cron job (so each gets its own Vercel Cron Job and its own
  // cadence) and ONE hooks channel for every webhook job. sync OWNS agent/**, so any
  // previously generated file for a job that is gone or disabled must be DELETED —
  // a stale schedule keeps firing forever otherwise.
  // `team.jobs` is only guaranteed by zod's `.default({})` when the config went through
  // `defineTeam`; several pre-existing test fixtures in this file are hand-built objects
  // cast straight to `TeamConfig` (no `jobs` key at all), so guard with `?? {}`.
  const activeJobs = Object.entries(team.jobs ?? {}).filter(([, j]) => j.enabled);
  const hookJobs: Record<string, HookJob> = {};
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
    out("agent/channels/hooks.ts", renderHooksChannel(hookJobs));
    warnings.push(
      "webhook jobs are configured — set DESKMATE_HOOK_SECRET in your deployment env (see the " +
        "generated .env.example), or the hooks channel returns 503 for every request.",
    );
  } else if (existsSync(hooksPath)) {
    deletes.push(hooksPath);
  }

  return { writes, deletes, warnings };
}
