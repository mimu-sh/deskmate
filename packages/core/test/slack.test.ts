import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.mock is hoisted above imports; create the spies with vi.hoisted so the
// mock factories below can reference them.
const { slackChannelMock, connectCredsMock } = vi.hoisted(() => ({
  slackChannelMock: vi.fn((config: unknown) => ({ __config: config })),
  connectCredsMock: vi.fn(() => ({ botToken: "test-token" })),
}));

vi.mock("eve/channels/slack", () => ({
  slackChannel: slackChannelMock,
  defaultSlackAuth: vi.fn(() => ({})),
}));

vi.mock("@vercel/connect/eve", () => ({
  connectSlackCredentials: connectCredsMock,
}));

import { createSlackChannel } from "../src/channels/slack.js";
import type { Roster } from "../src/roster.js";

const roster = {} as Roster;

// Clear ALL mocks (not just slackChannelMock) so call history from connectCredsMock
// or defaultSlackAuth can't leak between tests; clear preserves the vi.fn(impl).
beforeEach(() => {
  vi.clearAllMocks();
});

type SlackConfig = {
  threadContext?: unknown;
  onAppMention: (ctx: unknown, message: { channelId?: string }) => { auth: unknown; context?: string[] };
};

const capturedConfig = (): SlackConfig => slackChannelMock.mock.calls[0]![0] as SlackConfig;

describe("createSlackChannel", () => {
  it("opts into thread-context hydration since the last agent reply", () => {
    createSlackChannel(roster);

    expect(slackChannelMock).toHaveBeenCalledTimes(1);
    // The whole bug is that this option was never set — assert the exact boundary.
    expect(capturedConfig().threadContext).toEqual({ since: "last-agent-reply" });
  });

  it("frames the hydrated thread context as untrusted data on @mention", () => {
    createSlackChannel(roster);

    // No route configured (roster only, empty routes) → onAppMention returns just the
    // untrusted-framing note. It must name the <slack_thread_context> block eve injects.
    const result = capturedConfig().onAppMention({}, { channelId: "C_UNROUTED" });
    expect(result.context).toBeDefined();
    expect(
      result.context!.some((c) => /untrusted/i.test(c) && c.includes("<slack_thread_context>")),
    ).toBe(true);
  });
});

// A turn that dies on a model-call duration limit (the Vercel AI Gateway's
// `gateway_stream_timeout`) is NOT fixed by retrying the same request — the
// second attempt re-runs the same oversized pass and times out again. eve's
// default `turn.failed` handler tells the user to "try again, rephrase", which
// is actively wrong here, so core overrides the event to give advice that works.
describe("turn.failed", () => {
  type Posted = { markdown?: string } | string;
  type FailedData = { code: string; message: string; details?: Record<string, unknown>; turnId: string };
  type EventsConfig = {
    events: { "turn.failed": (data: FailedData, channel: unknown) => Promise<void> };
  };

  /** Run the turn.failed handler and return what it posted into the thread. */
  const runTurnFailed = async (data: Partial<FailedData>): Promise<string> => {
    createSlackChannel(roster);
    const posts: Posted[] = [];
    const channel = { thread: { post: async (p: Posted) => void posts.push(p) }, state: {} };
    const events = (slackChannelMock.mock.calls[0]![0] as EventsConfig).events;
    await events["turn.failed"](
      { code: "MODEL_CALL_FAILED", message: "", turnId: "turn_0", ...data },
      channel,
    );
    return posts.map((p) => (typeof p === "string" ? p : (p.markdown ?? ""))).join("\n");
  };

  it("tells the user to narrow the request when the model call outran its duration limit", async () => {
    const text = await runTurnFailed({
      message: "Stream exceeded maximum duration before function timeout",
      details: { errorId: "3827723d-bea7-4dee-8588-b13f2dd10f3f" },
    });

    // The whole point: do NOT tell them to just retry, tell them to shrink the ask.
    expect(text).toMatch(/narrow|smaller|shorter|split|less/i);
    expect(text).not.toMatch(/try again/i);
    // The error id still has to survive so the failure is traceable in the logs.
    expect(text).toContain("3827723d-bea7-4dee-8588-b13f2dd10f3f");
  });

  it("keeps the generic retry advice for an unrelated failure", async () => {
    const text = await runTurnFailed({
      message: "Something else went wrong",
      details: { errorId: "abc-123" },
    });

    expect(text).toMatch(/try again/i);
    expect(text).toContain("abc-123");
  });
  it("still posts when details cannot be serialised", async () => {
    // `details` is typed JsonObject, but this handler is the last thing standing
    // between a failed turn and silence. If it throws, the user gets nothing at
    // all, which is worse than the wrong advice this override exists to fix.
    const circular: Record<string, unknown> = { errorId: "circular-1" };
    circular.self = circular;

    const text = await runTurnFailed({ message: "Something else went wrong", details: circular });

    expect(text).toMatch(/try again/i);
    expect(text).toContain("circular-1");
  });
});
