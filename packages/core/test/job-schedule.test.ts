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
