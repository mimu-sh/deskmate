import { defineSchedule } from "eve/schedules";
import { resolveChannelTarget } from "../channel-routes.js";
import type { ChannelRoute } from "../channel-routes.js";
import type { Roster } from "../roster.js";

export const DEFAULT_SWEEP_CRON = "0 9 * * 1-5";

export type SweepTarget = { channelId: string; deskmate: string };

/**
 * Channels the scheduled sweep runs for: watch.digest AND watch.post both enabled.
 * A sweep session has no thread, so any non-silent output lands as a top-level post —
 * which watch.post: false forbids. A digest channel with post: false is therefore
 * skipped (and `deskmate sync` warns). See the README "Proactive watching" section.
 */
export function sweepTargets(routes: Record<string, ChannelRoute>): SweepTarget[] {
  return Object.entries(routes)
    .filter(([, r]) => r.watch?.digest === true && r.watch?.post === true)
    .map(([key, r]) => ({ channelId: resolveChannelTarget(key, r), deskmate: r.deskmate }));
}

/**
 * Build the scheduled sweep: on the team-level cron, for each channel that opted into
 * digest + post, start a proactive session that reviews recent activity and posts a
 * digest only if warranted. `slack` is the managed Slack channel (passed opaque to avoid a type dep);
 * the front desk routes to the channel's deskmate via the directive in the message.
 */
export function createDeskmateSweep(
  roster: Roster,
  routes: Record<string, ChannelRoute>,
  opts: { cron?: string; slack: unknown },
) {
  const targets = sweepTargets(routes);
  return defineSchedule({
    cron: opts.cron ?? DEFAULT_SWEEP_CRON,
    async run({ receive, waitUntil, appAuth }) {
      for (const t of targets) {
        const name = roster[t.deskmate]?.displayName ?? t.deskmate;
        waitUntil(
          receive(opts.slack as any, {
            message:
              `[routing] Delegate to the \`${t.deskmate}\` deskmate (${name}).\n\n` +
              `[proactive:sweep] Review recent activity in this channel. Post a short digest ` +
              `only if something genuinely warrants it; otherwise finish silently.`,
            target: { channelId: t.channelId },
            auth: appAuth,
          }),
        );
      }
    },
  });
}
