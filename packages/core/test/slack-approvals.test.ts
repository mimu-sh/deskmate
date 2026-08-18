import { describe, it, expect } from "vitest";
import { renderInputRequest, type InputRequest } from "../src/channels/slack-approvals.js";
import { inputRequestedHandler } from "../src/channels/slack-approvals.js";
import type { Roster } from "../src/roster.js";

function approvalReq(
  toolName: string,
  input: Record<string, unknown>,
  requestId = "req_1",
): InputRequest {
  return {
    action: { callId: "c1", input, kind: "tool-call", toolName },
    allowFreeform: false,
    display: "confirmation",
    options: [
      { id: "approve", label: "Yes" },
      { id: "deny", label: "No" },
    ],
    prompt: `Approve tool call: ${toolName}`,
    requestId,
  };
}

// The blocks eve preserves into the answered card (everything before the actions block).
function contentBlocks(blocks: Record<string, unknown>[]) {
  const i = blocks.findIndex((b) => b.type === "actions");
  return i === -1 ? blocks : blocks.slice(0, i);
}
function mrkdwnText(blocks: Record<string, unknown>[]): string {
  return JSON.stringify(blocks);
}

describe("renderInputRequest — eve resume contract", () => {
  it("emits approve/reject buttons with eve action ids and values", () => {
    const { blocks } = renderInputRequest(approvalReq("record_decision", { title: "T", detail: "D" }, "abc"));
    const actions = blocks.filter((b) => b.type === "actions");
    expect(actions).toHaveLength(1); // exactly one actions block
    const els = (actions[0] as any).elements as any[];
    expect(els[0].action_id).toBe("eve_input:abc:button:0");
    expect(els[0].value).toBe("approve");
    expect(els[1].action_id).toBe("eve_input:abc:button:1");
    expect(els[1].value).toBe("deny");
  });

  it("puts the single actions block last, with all content before it", () => {
    const { blocks } = renderInputRequest(approvalReq("record_decision", { title: "T", detail: "D" }));
    expect(blocks[blocks.length - 1].type).toBe("actions");
    expect(contentBlocks(blocks).every((b) => b.type !== "actions")).toBe(true);
  });
});

describe("renderInputRequest — record_decision", () => {
  it("shows the title as the headline and the detail, never raw JSON", () => {
    const { blocks, text } = renderInputRequest(
      approvalReq("record_decision", { title: "Open GitHub issue: dedup gap", detail: "Repo: mama-sh/deskmate" }),
    );
    const dump = mrkdwnText(blocks);
    expect(dump).toContain("Record a decision");
    expect(dump).toContain("Open GitHub issue: dedup gap");
    expect(dump).toContain("Repo: mama-sh/deskmate");
    expect(dump).not.toContain('\\"title\\"'); // no JSON.stringify blob
    expect(text).toContain("Open GitHub issue: dedup gap");
  });
});

describe("renderInputRequest — forget (destructive)", () => {
  it("uses a delete verb with an irreversibility warning and shows the key", () => {
    const { blocks } = renderInputRequest(approvalReq("forget", { key: "pr-bot-review-triggers" }));
    const dump = JSON.stringify(blocks);
    expect(dump).toContain("Delete a memory");
    expect(dump).toMatch(/can.?t be undone/i);
    expect(dump).toContain("pr-bot-review-triggers");
  });
});

describe("renderInputRequest — open_pull_request", () => {
  it("shows title, repo→base and branch", () => {
    const { blocks } = renderInputRequest(
      approvalReq("open_pull_request", {
        repo: "mama-sh/deskmate",
        branch: "deskmate/omri/x",
        base: "main",
        title: "Frame thread context as untrusted",
        body: "why + how verified",
        commitMessage: "fix: ...",
      }),
    );
    const dump = JSON.stringify(blocks);
    expect(dump).toContain("Open a pull request");
    expect(dump).toContain("Frame thread context as untrusted");
    expect(dump).toContain("mama-sh/deskmate → base main");
    expect(dump).toContain("deskmate/omri/x");
  });
});

describe("renderInputRequest — approval card labels & attribution", () => {
  it("labels the buttons Approve/Reject and shows the deskmate + tool in context", () => {
    const { blocks } = renderInputRequest(
      approvalReq("record_decision", { title: "T", detail: "D" }),
      "Omri",
    );
    const els = (blocks.find((b) => b.type === "actions") as any).elements as any[];
    expect(els[0].text.text).toBe("Approve");
    expect(els[1].text.text).toBe("Reject");
    const context = blocks.find((b) => b.type === "context") as any;
    expect(JSON.stringify(context)).toContain("Omri · requested via `record_decision`");
  });
});

describe("renderInputRequest — generic fallback", () => {
  it("renders arbitrary fields without dumping escaped JSON", () => {
    const { blocks } = renderInputRequest(approvalReq("charge_card", { amount: 4200, currency: "USD" }));
    const dump = JSON.stringify(blocks);
    expect(dump).toContain("charge card"); // humanized verb
    expect(dump).toContain("amount");
    expect(dump).toContain("4200");
    expect(dump).not.toContain('\\"amount\\":4200'); // not a JSON blob of the whole input
    expect((blocks[blocks.length - 1] as any).type).toBe("actions");
  });
});

describe("renderInputRequest — danger is opt-in", () => {
  it("does not add the irreversibility note to non-danger tools", () => {
    const { blocks } = renderInputRequest(approvalReq("record_decision", { title: "T", detail: "D" }));
    expect(JSON.stringify(blocks)).not.toMatch(/can.?t be undone/i);
  });
});

describe("renderInputRequest — open_pull_request without base", () => {
  it("shows the repo without a base arrow when base is omitted", () => {
    const { blocks } = renderInputRequest(
      approvalReq("open_pull_request", { repo: "mama-sh/deskmate", branch: "b", title: "t", body: "x", commitMessage: "c" }),
    );
    const dump = JSON.stringify(blocks);
    expect(dump).toContain("mama-sh/deskmate");
    expect(dump).not.toContain("→ base");
  });
});

describe("renderInputRequest — question parity", () => {
  it("renders a select as a menu with the eve select action id", () => {
    const req: InputRequest = {
      action: { callId: "c", input: {}, kind: "tool-call", toolName: "ask_question" },
      display: "select",
      options: [{ id: "a", label: "Option A" }, { id: "b", label: "Option B" }],
      prompt: "Pick one",
      requestId: "q1",
    };
    const { blocks } = renderInputRequest(req);
    const menu = (blocks.find((b) => b.type === "actions") as any).elements[0];
    expect(menu.action_id).toBe("eve_input:q1");
    expect(JSON.stringify(blocks)).toContain("Pick one");
  });

  it("renders a freeform question as an eve freeform trigger", () => {
    const req: InputRequest = {
      action: { callId: "c", input: {}, kind: "tool-call", toolName: "ask_question" },
      display: "text",
      allowFreeform: true,
      prompt: "What should I name it?",
      requestId: "q2",
    };
    const { blocks } = renderInputRequest(req);
    const btn = (blocks.find((b) => b.type === "actions") as any).elements[0];
    expect(btn.action_id).toBe("eve_input_freeform:q2");
    expect(btn.value).toBe("q2");
  });

  it("caps over-long option labels at Slack's 75-char plain_text limit", () => {
    // Slack rejects the whole message if any option/button plain_text exceeds 75 chars.
    const longLabel = "A".repeat(120);
    const req: InputRequest = {
      action: { callId: "c", input: {}, kind: "tool-call", toolName: "ask_question" },
      display: "select",
      options: [{ id: "a", label: longLabel }],
      prompt: "Pick one",
      requestId: "q3",
    };
    const { blocks } = renderInputRequest(req);
    const optionText = (blocks.find((b) => b.type === "actions") as any).elements[0].options[0].text.text;
    expect(optionText.length).toBeLessThanOrEqual(75);
  });

  it("renders more than 6 options as a static_select", () => {
    const options = Array.from({ length: 7 }, (_, i) => ({ id: `o${i}`, label: `Option ${i}` }));
    const req: InputRequest = {
      action: { callId: "c", input: {}, kind: "tool-call", toolName: "ask_question" },
      display: "select",
      options,
      prompt: "Pick one",
      requestId: "q4",
    };
    const { blocks } = renderInputRequest(req);
    const menu = (blocks.find((b) => b.type === "actions") as any).elements[0];
    expect(menu.type).toBe("static_select");
    expect(menu.action_id).toBe("eve_input:q4");
  });

  it("renders options without display:select as eve button ids", () => {
    const req: InputRequest = {
      action: { callId: "c", input: {}, kind: "tool-call", toolName: "ask_question" },
      options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }],
      prompt: "Proceed?",
      requestId: "q5",
    };
    const { blocks } = renderInputRequest(req);
    const els = (blocks.find((b) => b.type === "actions") as any).elements as any[];
    expect(els[0].action_id).toBe("eve_input:q5:button:0");
    expect(els[0].value).toBe("yes");
  });
});

describe("renderInputRequest — mrkdwn injection hardening", () => {
  it("neutralizes Slack control sequences in model-supplied fields and fallback text", () => {
    const { blocks, text } = renderInputRequest(
      approvalReq("record_decision", {
        title: "Ping <!channel> now",
        detail: "Click <https://evil.example|github.com/safe>",
      }),
    );
    const dump = JSON.stringify(blocks);
    // No raw Slack mention/link syntax survives on the decision surface.
    expect(dump).not.toContain("<!channel>");
    expect(dump).not.toContain("<https://evil.example|");
    expect(dump).toContain("&lt;!channel&gt;");
    // The notification/fallback text can't ping via <!channel> either.
    expect(text).not.toContain("<!channel>");
  });

  it("escapes the deskmate name in the approval context block", () => {
    const { blocks } = renderInputRequest(
      approvalReq("record_decision", { title: "T", detail: "D" }),
      "R&D <!channel>",
    );
    const context = JSON.stringify(blocks.find((b) => b.type === "context"));
    expect(context).not.toContain("<!channel>");
    expect(context).toContain("R&amp;D");
  });

  it("escapes Slack control syntax in a question's notification fallback", () => {
    const req: InputRequest = {
      action: { callId: "c", input: {}, kind: "tool-call", toolName: "ask_question" },
      display: "text",
      allowFreeform: true,
      prompt: "Notify <!channel> now?",
      requestId: "q6",
    };
    const { text } = renderInputRequest(req);
    expect(text).not.toContain("<!channel>");
    expect(text).toContain("&lt;!channel&gt;");
  });
});

const roster = {
  omri: { id: "omri", displayName: "Omri", emoji: ":robot_face:", summary: "DevOps" },
} as unknown as Roster;

function fakeChannel(state: Record<string, unknown>) {
  const requests: { method: string; payload: any }[] = [];
  const posts: any[] = [];
  const channel = {
    state,
    slack: {
      request: async (method: string, payload: any) => {
        requests.push({ method, payload });
        return { ok: true };
      },
    },
    thread: {
      post: async (input: any) => {
        posts.push(input);
        return { id: "posted" };
      },
    },
  } as any;
  return { channel, requests, posts };
}

describe("inputRequestedHandler", () => {
  it("posts the card AS the active deskmate when the thread is anchored", async () => {
    const { channel, requests, posts } = fakeChannel({ activeDeskmateId: "omri", channelId: "C1", threadTs: "T1" });
    await inputRequestedHandler(roster)(
      { requests: [approvalReq("record_decision", { title: "T", detail: "D" })] } as any,
      channel,
      {} as any,
    );
    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe("chat.postMessage");
    expect(requests[0].payload.username).toBe("Omri");
    expect(Array.isArray(requests[0].payload.blocks)).toBe(true);
    expect(posts).toHaveLength(0);
  });

  it("falls back to the shared-bot post when the thread is not anchored", async () => {
    const { channel, requests, posts } = fakeChannel({ activeDeskmateId: "omri", channelId: "C1", threadTs: null });
    await inputRequestedHandler(roster)(
      { requests: [approvalReq("forget", { key: "k" })] } as any,
      channel,
      {} as any,
    );
    expect(requests).toHaveLength(0);
    expect(posts).toHaveLength(1);
    expect(posts[0].blocks).toBeTruthy();
  });

  it("never attributes a question to the active deskmate (posts under the shared bot)", async () => {
    // A front-desk ask_question could read a stale activeDeskmateId; it must not
    // impersonate the deskmate. Anchored thread + active deskmate, yet no as-deskmate post.
    const { channel, requests, posts } = fakeChannel({ activeDeskmateId: "omri", channelId: "C1", threadTs: "T1" });
    const question: InputRequest = {
      action: { callId: "c", input: {}, kind: "tool-call", toolName: "ask_question" },
      display: "text",
      allowFreeform: true,
      prompt: "What should I name it?",
      requestId: "q7",
    };
    await inputRequestedHandler(roster)({ requests: [question] } as any, channel, {} as any);
    expect(requests).toHaveLength(0); // not posted via chat.postMessage as a deskmate
    expect(posts).toHaveLength(1); // shared-bot post
    expect(JSON.stringify(posts[0])).not.toContain("Omri"); // no deskmate name anywhere
  });
});
