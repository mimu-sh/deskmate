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
    // eve's cross-channel delivery: `to(channel, target).send(message, { auth })`.
    const send = vi.fn().mockResolvedValue(undefined);
    const to = vi.fn((_channel: unknown, _target: unknown) => ({ send }));
    const waitUntil = vi.fn();
    const appAuth = { authenticator: "app" };

    const schedule = createJobSchedule({ cron: "0 6 * * *", channelId: "C0123", slack, job });
    await schedule.run!({ to, waitUntil, appAuth } as never);

    expect(waitUntil).toHaveBeenCalledTimes(1);
    expect(to).toHaveBeenCalledTimes(1);
    const [channel, target] = to.mock.calls[0];
    const [message, options] = send.mock.calls[0];
    expect(channel).toBe(slack);
    expect(target).toEqual({ channelId: "C0123" });
    expect(options.auth).toBe(appAuth);
    expect(message).toContain("[proactive:job:conversation_review] window: last 24h");
    expect(message).toContain("file at most 3 issue(s)");
  });
  it("builds the message when the cron fires, not when the schedule is constructed", async () => {
    // The message used to be built once at module load. On a warm machine that froze
    // the injected date at whenever the deployment first booted, so a job running days
    // later would resolve "yesterday" against a stale day.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-09-05T12:00:00Z"));
      const schedule = createJobSchedule({ cron: "0 6 * * *", channelId: "C0123", slack, job });

      // A later firing must carry the later date.
      vi.setSystemTime(new Date("2026-09-12T12:00:00Z"));
      const send = vi.fn().mockResolvedValue(undefined);
      const to = vi.fn((_channel: unknown, _target: unknown) => ({ send }));
      await schedule.run!({ to, waitUntil: vi.fn(), appAuth: {} } as never);

      const [message] = send.mock.calls[0]!;
      expect(message).toContain("2026-09-12");
      expect(message).not.toContain("2026-09-05");
    } finally {
      vi.useRealTimers();
    }
  });
});
