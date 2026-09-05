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
 * its own, so it hands the run to Slack with `to(...).send(...)`.
 */
export function createJobSchedule(opts: JobScheduleOptions) {
  return defineSchedule({
    cron: opts.cron,
    async run({ to, waitUntil, appAuth }) {
      // Built per firing, not at construction. The message carries the current date, and
      // a warm machine would otherwise serve the day it first booted for as long as it
      // stayed warm, which is the stale-window bug this is meant to remove.
      const message = buildJobMessage(opts.job);
      waitUntil(to(opts.slack as any, { channelId: opts.channelId }).send(message, { auth: appAuth }));
    },
  });
}
