# Slack Approval Cards — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:executing-plans to implement this plan task-by-task.

**Goal:** Replace eve's raw "Approve tool call: <name> + JSON dump" approval prompt with a human-readable, per-tool approval card posted as the requesting deskmate.

**Architecture:** A new pure module `packages/core/src/channels/slack-approvals.ts` builds Block Kit blocks for any eve HITL `input.requested` (approval → card, `ask_question` → faithful parity). A handler wired into `createSlackChannel`'s `events["input.requested"]` resolves the requesting deskmate and posts the card as them (best-effort), falling back to the shared bot. All rendering is pure and unit-tested, with a contract test locking eve's button/answered-card resume protocol.

**Tech Stack:** TypeScript (NodeNext ESM), eve `slackChannel` public API (`eve/channels/slack`), vitest.

**Design doc:** `docs/plans/2026-07-21-slack-approval-cards-design.md`

---

## Background the executor needs

- **eve owns the current bad rendering.** The harness builds the approval request with `prompt: "Approve tool call: <toolName>"` and the Slack adapter appends `JSON.stringify(input)`. deskmate's only lever is overriding the `events["input.requested"]` handler, which *replaces* eve's default renderer.
- **The eve resume contract is a hard constraint** (locked by tests in Task 1). eve's interaction pipeline (`node_modules/.../eve/dist/src/public/channels/slack/interactions.js`) requires:
  - approve/reject buttons: `action_id === "eve_input:<requestId>:button:<index>"`, `value === "<optionId>"` (`approve`/`deny`);
  - select menus: `action_id === "eve_input:<requestId>"`;
  - freeform trigger: `action_id === "eve_input_freeform:<requestId>"`, `value === "<requestId>"`;
  - **all content blocks must precede a single trailing `actions` block** — on click eve rewrites the message via `chat.update` to every `section`/`context`/`divider`/`image` block *before the first `actions` block*, plus `✅ *answer*` + `Answered by @user`. A `header` block is **not** preserved (acceptable: the record lives in the section/context blocks).
- **`InputRequest` is not publicly exported by name**, so the module declares a local structural mirror. `{ blocks }` posts accept `readonly unknown[]`, so plain block objects need no casts.
- **Identity** is read from `channel.state.activeDeskmateId` (set by the existing `actions.requested` handler in `slack.ts`, still present mid-turn because an approval pauses before `message.completed` resets it). `deskmateSlackIdentity(roster, id)` resolves the name/avatar; with no `DESKMATE_PUBLIC_URL`/`VERCEL_*` env it falls back to `{ username, icon_emoji }`, which is enough to post as the deskmate.

## Setup (before Task 1)

This work is unrelated to the current `fix/slack-thread-context` branch. Start a fresh branch off `main`, carrying the two already-written planning docs:

```bash
cd /Users/davidstrouk/code/deskmate
git stash push -u -- docs/plans/2026-07-21-slack-approval-cards*.md   # if needed
git checkout main && git pull --ff-only
git checkout -b feat/slack-approval-cards
git stash pop 2>/dev/null || true
git add docs/plans/2026-07-21-slack-approval-cards.md docs/plans/2026-07-21-slack-approval-cards-design.md docs/plans/2026-07-21-slack-approval-cards.md.tasks.json
git commit -m "docs(core): design + plan for human-readable Slack approval cards"
```

All test commands run from `packages/core` (its own `vitest.config.ts` globs `test/**/*.test.ts`):

```bash
cd packages/core && npx vitest run test/slack-approvals.test.ts
```

---

### Task 1: Approval card core + eve resume contract (record_decision)

Builds the module skeleton, the `record_decision` descriptor, and locks the eve contract with tests.

**Files:**
- Create: `packages/core/src/channels/slack-approvals.ts`
- Test: `packages/core/test/slack-approvals.test.ts`

**Step 1: Write the failing tests**

Create `packages/core/test/slack-approvals.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { renderInputRequest, type InputRequest } from "../src/channels/slack-approvals.js";

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
```

**Step 2: Run tests to verify they fail**

Run: `cd packages/core && npx vitest run test/slack-approvals.test.ts`
Expected: FAIL — cannot resolve `../src/channels/slack-approvals.js`.

**Step 3: Write the module**

Create `packages/core/src/channels/slack-approvals.ts`:

```ts
// Human-readable Slack rendering for eve HITL requests (approvals + questions).
//
// eve's default renderer shows "Approve tool call: <toolName>" plus a raw
// JSON.stringify of the input. Overriding the Slack channel's `input.requested`
// handler (see slack.ts) lets us render an approval as a per-tool card instead,
// while preserving the exact block/action contract eve's interaction pipeline
// needs to resolve the click and rewrite the answered card
// (node_modules/.../eve/dist/src/public/channels/slack/{hitl,interactions}.js):
//
//   - buttons:  action_id `eve_input:<requestId>:button:<n>`, value = optionId
//   - selects:  action_id `eve_input:<requestId>`
//   - freeform: action_id `eve_input_freeform:<requestId>`, value = requestId
//   - all content blocks precede ONE trailing `actions` block (eve keeps the
//     section/context/divider/image blocks before it as the answered-card record)
//
// slack-approvals.test.ts locks this contract so an eve upgrade that changes it
// fails loudly instead of silently breaking approvals in production.

const HITL_ACTION_PREFIX = "eve_input:";
const HITL_FREEFORM_ACTION_PREFIX = "eve_input_freeform:";
const SECTION_TEXT_MAX = 3000; // Slack section text hard limit

export type InputOption = {
  id: string;
  label: string;
  description?: string;
  style?: "danger" | "default" | "primary";
};

/** Structural mirror of eve's InputRequest (not publicly exported by name). */
export type InputRequest = {
  action: { callId: string; input: Record<string, unknown>; kind: "tool-call"; toolName: string };
  allowFreeform?: boolean;
  display?: "confirmation" | "select" | "text";
  options?: InputOption[];
  prompt: string;
  requestId: string;
};

export type SlackBlock = Record<string, unknown>;
export type RenderedRequest = { blocks: SlackBlock[]; text: string };

type Field = { label: string; value: string };
type ToolDescriptor = {
  emoji: string;
  verb: string;
  danger?: boolean;
  headline?: (input: Record<string, unknown>) => string | undefined;
  fields?: (input: Record<string, unknown>) => Field[];
};

function str(v: unknown): string {
  if (v === null || v === undefined) return "";
  return typeof v === "string" ? v : JSON.stringify(v);
}

const TOOL_DESCRIPTORS: Record<string, ToolDescriptor> = {
  record_decision: {
    emoji: "📝",
    verb: "Record a decision",
    headline: (i) => str(i.title) || undefined,
    fields: (i) => (str(i.detail) ? [{ label: "Details", value: str(i.detail) }] : []),
  },
};

function humanizeToolName(name: string): string {
  return name.replace(/[_-]+/g, " ").trim();
}

function fallbackDescriptor(toolName: string): ToolDescriptor {
  return {
    emoji: "⚙️",
    verb: `Run \`${humanizeToolName(toolName)}\``,
    fields: (input) =>
      Object.entries(input)
        .filter(([, v]) => str(v) !== "")
        .map(([k, v]) => ({ label: k, value: str(v) })),
  };
}

function truncate(text: string, max = SECTION_TEXT_MAX): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

function section(mrkdwn: string): SlackBlock {
  return { type: "section", text: { type: "mrkdwn", text: truncate(mrkdwn) } };
}

export function isApproval(req: InputRequest): boolean {
  return (
    req.display === "confirmation" &&
    req.options?.length === 2 &&
    req.options[0]?.id === "approve" &&
    req.options[1]?.id === "deny"
  );
}

function approvalActions(req: InputRequest): SlackBlock {
  const labelFor: Record<string, string> = { approve: "Approve", deny: "Reject" };
  const styleFor: Record<string, "primary" | "danger"> = { approve: "primary", deny: "danger" };
  const elements = (req.options ?? []).map((opt, i) => ({
    type: "button",
    action_id: `${HITL_ACTION_PREFIX}${req.requestId}:button:${i}`,
    text: { type: "plain_text", text: labelFor[opt.id] ?? opt.label },
    value: opt.id,
    ...(styleFor[opt.id] ? { style: styleFor[opt.id] } : {}),
  }));
  return { type: "actions", elements };
}

function renderApproval(req: InputRequest, deskmateName?: string): RenderedRequest {
  const d = TOOL_DESCRIPTORS[req.action.toolName] ?? fallbackDescriptor(req.action.toolName);
  const blocks: SlackBlock[] = [
    { type: "header", text: { type: "plain_text", text: "🔐 Approval needed", emoji: true } },
    section(`${d.emoji} *${d.verb}*`),
  ];
  const headline = d.headline?.(req.action.input);
  if (headline) blocks.push(section(`*${headline}*`));
  for (const f of d.fields?.(req.action.input) ?? []) blocks.push(section(`*${f.label}:* ${f.value}`));
  const who = deskmateName ? `${deskmateName} · ` : "";
  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: `${who}requested via \`${req.action.toolName}\`` }],
  });
  blocks.push(approvalActions(req));
  return { blocks, text: `Approval needed: ${d.verb}${headline ? ` — ${headline}` : ""}` };
}

export function renderInputRequest(req: InputRequest, deskmateName?: string): RenderedRequest {
  // Question parity is added in Task 4; until then non-approvals fall through.
  return renderApproval(req, deskmateName);
}
```

**Step 4: Run tests to verify they pass**

Run: `cd packages/core && npx vitest run test/slack-approvals.test.ts`
Expected: PASS (4 tests).

**Step 5: Commit**

```bash
git add packages/core/src/channels/slack-approvals.ts packages/core/test/slack-approvals.test.ts
git commit -m "feat(core): human-readable Slack approval card for record_decision"
```

---

### Task 2: `forget` (danger) and `open_pull_request` descriptors

**Files:**
- Modify: `packages/core/src/channels/slack-approvals.ts` (add two descriptors to `TOOL_DESCRIPTORS`)
- Test: `packages/core/test/slack-approvals.test.ts` (add cases)

**Step 1: Write the failing tests** (append inside the file)

```ts
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
```

**Step 2: Run to verify failure** — `... npx vitest run test/slack-approvals.test.ts` → FAIL (renders via fallback, assertions miss).

**Step 3: Add the descriptors** to `TOOL_DESCRIPTORS`:

```ts
  forget: {
    emoji: "🗑️",
    verb: "Delete a memory — this can't be undone",
    danger: true,
    headline: (i) => str(i.key) || undefined,
  },
  open_pull_request: {
    emoji: "🔀",
    verb: "Open a pull request",
    headline: (i) => str(i.title) || undefined,
    fields: (i) => {
      const f: Field[] = [];
      const base = str(i.base);
      if (str(i.repo)) f.push({ label: "Repo", value: base ? `${str(i.repo)} → base ${base}` : str(i.repo) });
      if (str(i.branch)) f.push({ label: "Branch", value: str(i.branch) });
      if (str(i.body)) f.push({ label: "Description", value: str(i.body) });
      return f;
    },
  },
```

**Step 4: Run to verify pass** — Expected: PASS (6 tests).

**Step 5: Commit**

```bash
git add packages/core/src/channels/slack-approvals.ts packages/core/test/slack-approvals.test.ts
git commit -m "feat(core): approval cards for forget (danger) and open_pull_request"
```

---

### Task 3: Generic fallback for unknown tools

**Files:**
- Test: `packages/core/test/slack-approvals.test.ts` (fallback already implemented in Task 1; this locks it)

**Step 1: Write the failing test**

```ts
describe("renderInputRequest — generic fallback", () => {
  it("renders arbitrary fields without dumping escaped JSON", () => {
    const { blocks } = renderInputRequest(approvalReq("charge_card", { amount: 4200, currency: "USD" }));
    const dump = JSON.stringify(blocks);
    expect(dump).toContain("charge card"); // humanized verb
    expect(dump).toContain("amount");
    expect(dump).toContain("4200");
    expect(dump).not.toContain('\\"amount\\":4200'); // not a JSON blob of the whole input
    // still a valid, resolvable approval
    expect((blocks[blocks.length - 1] as any).type).toBe("actions");
  });
});
```

**Step 2: Run** → Expected: PASS immediately (fallback exists from Task 1). If any assertion fails, fix the fallback in `slack-approvals.ts`, not the test.

**Step 3: Commit**

```bash
git add packages/core/test/slack-approvals.test.ts
git commit -m "test(core): lock generic approval-card fallback for unknown tools"
```

---

### Task 4: Question parity (`ask_question`: select + freeform + option buttons)

Overriding `input.requested` also replaces eve's rendering of the built-in `ask_question`. Render non-approval requests with faithful parity.

**Files:**
- Modify: `packages/core/src/channels/slack-approvals.ts`
- Test: `packages/core/test/slack-approvals.test.ts`

**Step 1: Write the failing tests**

```ts
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
});
```

**Step 2: Run** → FAIL (non-approvals still routed to `renderApproval`).

**Step 3: Implement `renderQuestion` and route through it**

Add to `slack-approvals.ts`:

```ts
function toOption(opt: InputOption): SlackBlock {
  const o: SlackBlock = { text: { type: "plain_text", text: opt.label }, value: opt.id };
  if (opt.description) o.description = { type: "plain_text", text: opt.description };
  return o;
}

function renderQuestion(req: InputRequest): RenderedRequest {
  const blocks: SlackBlock[] = [section(req.prompt)];
  const opts = req.options ?? [];
  if (opts.length > 0 && req.display === "select") {
    const menu =
      opts.length <= 6
        ? { type: "radio_buttons", action_id: `${HITL_ACTION_PREFIX}${req.requestId}`, options: opts.map(toOption) }
        : {
            type: "static_select",
            action_id: `${HITL_ACTION_PREFIX}${req.requestId}`,
            options: opts.map(toOption),
            placeholder: { type: "plain_text", text: "Choose an option" },
          };
    blocks.push({ type: "actions", elements: [menu] });
  } else if (opts.length > 0) {
    blocks.push({
      type: "actions",
      elements: opts.map((opt, i) => ({
        type: "button",
        action_id: `${HITL_ACTION_PREFIX}${req.requestId}:button:${i}`,
        text: { type: "plain_text", text: opt.label },
        value: opt.id,
        ...(opt.style === "primary" || opt.style === "danger" ? { style: opt.style } : {}),
      })),
    });
  } else {
    // freeform: eve opens the modal itself from the section block + this trigger
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: `${HITL_FREEFORM_ACTION_PREFIX}${req.requestId}`,
          text: { type: "plain_text", text: "Type your answer" },
          style: "primary",
          value: req.requestId,
        },
      ],
    });
  }
  return { blocks, text: req.prompt };
}
```

Change `renderInputRequest` to route:

```ts
export function renderInputRequest(req: InputRequest, deskmateName?: string): RenderedRequest {
  return isApproval(req) ? renderApproval(req, deskmateName) : renderQuestion(req);
}
```

**Step 4: Run** → Expected: PASS (all prior tests + 2 new).

**Step 5: Commit**

```bash
git add packages/core/src/channels/slack-approvals.ts packages/core/test/slack-approvals.test.ts
git commit -m "feat(core): question parity for ask_question in the input.requested override"
```

---

### Task 5: `inputRequestedHandler` + wire into `createSlackChannel`

**Files:**
- Modify: `packages/core/src/channels/slack-approvals.ts` (add the handler)
- Modify: `packages/core/src/channels/slack.ts` (wire the event)
- Test: `packages/core/test/slack-approvals.test.ts` (handler posting behavior)

**Step 1: Write the failing tests**

```ts
import { inputRequestedHandler } from "../src/channels/slack-approvals.js";
import type { Roster } from "../src/roster.js";

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
});
```

**Step 2: Run** → FAIL (`inputRequestedHandler` not exported).

**Step 3: Implement the handler** in `slack-approvals.ts`:

```ts
import type { SlackChannelEvents } from "eve/channels/slack";
import { deskmateSlackIdentity } from "../deskmate-identity.js";
import type { Roster } from "../roster.js";

/**
 * `events["input.requested"]` handler: render each pending HITL request as a
 * human-readable card and post it AS the requesting deskmate when we can resolve
 * one and the thread is anchored; otherwise post under the shared bot. `blocks`
 * is identical on both paths. Reads `activeDeskmateId` — set by the
 * `actions.requested` handler in slack.ts and still present because an approval
 * pauses the turn before `message.completed` resets it.
 */
export function inputRequestedHandler(roster: Roster): NonNullable<SlackChannelEvents["input.requested"]> {
  return async (data, channel) => {
    const state = channel.state as { activeDeskmateId?: string | null; channelId: string | null; threadTs: string | null };
    const id = typeof state.activeDeskmateId === "string" ? state.activeDeskmateId : null;
    const identity = deskmateSlackIdentity(roster, id);
    const deskmateName = identity?.username;
    const { channelId, threadTs } = state;

    for (const req of data.requests as unknown as InputRequest[]) {
      const { blocks, text } = renderInputRequest(req, deskmateName);
      if (identity && channelId && threadTs) {
        try {
          const res = await channel.slack.request("chat.postMessage", {
            channel: channelId,
            thread_ts: threadTs,
            blocks,
            text,
            username: identity.username,
            ...(identity.icon_url ? { icon_url: identity.icon_url } : {}),
            ...(identity.icon_emoji ? { icon_emoji: identity.icon_emoji } : {}),
          });
          if (res.ok) continue;
        } catch {
          // fall through to the shared-bot post
        }
      }
      await channel.thread.post({ blocks, text });
    }
  };
}
```

**Step 4: Wire into `createSlackChannel`** — in `packages/core/src/channels/slack.ts`:

- Add import near the top:
  ```ts
  import { inputRequestedHandler } from "./slack-approvals.js";
  ```
- Add the event inside the `events: { ... }` object (alongside `actions.requested`, `action.result`, `message.completed`):
  ```ts
      "input.requested": inputRequestedHandler(roster),
  ```

**Step 5: Run tests + typecheck + full suite**

```bash
cd packages/core
npx vitest run test/slack-approvals.test.ts   # all green
pnpm typecheck                                 # tsc, no errors
pnpm test                                      # full core suite green
```
Expected: all PASS, no type errors.

**Step 6: Commit**

```bash
git add packages/core/src/channels/slack-approvals.ts packages/core/src/channels/slack.ts packages/core/test/slack-approvals.test.ts
git commit -m "feat(core): render Slack approvals as deskmate cards via input.requested"
```

---

### Task 6: Verify end-to-end and finish the branch

**Step 1: Repo-wide typecheck + build + tests**

```bash
cd /Users/davidstrouk/code/deskmate
pnpm -r typecheck
pnpm -r --filter="./packages/*" build
pnpm -r test
```
Expected: green across `core`, `catalog`, `cli`.

**Step 2: Live check (recommended)** — use the `/run` or `deskmate dev` loop to trigger an `always()` approval in a Slack thread and confirm the card renders, Approve/Reject resolves, and the answered card shows "✅ Approve / Answered by @you". If a live Slack isn't available, the contract tests + design-doc trace of eve's `interactions.js` stand in.

**Step 3: Open the PR**

```bash
git push -u origin feat/slack-approval-cards
gh pr create --repo mama-sh/deskmate --base main \
  --title "feat(core): human-readable Slack approval cards" \
  --body "See docs/plans/2026-07-21-slack-approval-cards-design.md. Replaces eve's raw 'Approve tool call: <name>' + JSON dump with a per-tool approval card posted as the requesting deskmate. Follow-up: #31 (record_decision executes nothing yet)."
```

Note: PR bots don't re-review new commits automatically — re-request Copilot / `@codex review` if you push follow-ups.

---

## Follow-ups (tracked, out of this plan)

- **#31** — `record_decision` approvals execute nothing (stub tool). Handle **after** this lands, as agreed.
- Reject-with-reason capture (needs eve's freeform-modal path) — optional fast-follow.
