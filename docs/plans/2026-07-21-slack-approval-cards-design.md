# Human-readable Slack approval cards

**Date:** 2026-07-21
**Status:** Approved — ready for implementation
**Scope:** `@deskmate/core`

## Problem

When a deskmate calls an `approval: always()` tool, the human sees a raw,
developer-facing prompt in the Slack thread instead of an explanation of what
they're approving. From a real thread (DevOps deskmate proposing a GitHub issue):

```
Approve tool call: record_decision
Tool input
{
  "title": "Open GitHub issue: Error pipeline may silently drop repeat-fingerprint…",
  "detail": "\n**Repo:** Addmein-ai/addmein\n\n**Labels:** `enhancement` (nearest…"
}
[ Yes ]   [ No ]
```

The action verb is the internal tool name (`record_decision`), the arguments are
an escaped `JSON.stringify` dump, and the buttons are the generic `Yes`/`No`. A
person approving this cannot tell at a glance what will happen. This undercuts the
feeling of working with a deskmate — the approval reads like a syscall, not a
colleague asking permission.

This affects **every** approval-gated tool in the product, not just
`record_decision`:

| Tool | Input | Consequence |
| --- | --- | --- |
| `record_decision` (DevOps role) | `{ title, detail }` | records a proposed action |
| `open_pull_request` (engineer) | `{ repo, branch, base?, title, body, commitMessage }` | opens a PR |
| `forget` (memory) | `{ key }` | **deletes a memory — irreversible** |

## Root cause

The prompt and the JSON dump are built **inside eve**, and deskmate has no say in
them today.

- The harness builds the approval request with a fixed prompt. In
  `eve/dist/src/harness/input-extraction.js` → `extractToolApprovalInputRequests`:
  ```js
  n.push({
    action: o, allowFreeform: false, display: "confirmation",
    options: [{ id: "approve", label: "Yes" }, { id: "deny", label: "No" }],
    prompt: `Approve tool call: ${a.toolName}`, requestId: t.approvalId,
  });
  ```
- The Slack adapter renders that request. In
  `eve/dist/src/public/channels/slack/hitl.js`, `formatToolInputDetails` appends
  the raw input as a code block:
  ```js
  let n = JSON.stringify(t.action.input, null, 2);
  return `*Tool input*\n\`\`\`\n${truncateWithEllipsis(n, …)}\n\`\`\``;
  ```
- The default `input.requested` event handler
  (`.../slack/defaults.js` → `defaultInputRequestedHandler`) posts those blocks
  verbatim.

## Decision

Override the Slack channel's `input.requested` event handler in
`createSlackChannel` (`packages/core/src/channels/slack.ts`). Supplying an
`events["input.requested"]` handler **replaces** eve's default renderer for that
event, so deskmate can render approvals as a human-readable card while keeping the
approve/deny buttons functional.

This is the single sanctioned extension point, it's implemented with **only the
public `eve/channels/slack` surface**, and — because it lives in core's channel
factory — every deployment inherits it on upgrade with no per-consumer wiring.

### The card

Posted **as the requesting deskmate** (name + avatar) when resolvable; otherwise
under the shared "Deskmate" bot. Card content is identical either way.

Before → after for the thread example above (posted as *Omri · DevOps*):

```
🔐  Approval needed
─────────────────────────────
Record a decision

Open GitHub issue: Error pipeline may silently drop
repeat-fingerprint errors after first occurrence

Repo: Addmein-ai/addmein
Labels: enhancement (observability and tech-debt don't exist yet)…

requested via record_decision
[ Approve ]   [ Reject ]        ← primary (green) / danger (red)
```

The same renderer, driven by a per-tool descriptor, adapts to the other tools:

```
🗑️  Approval needed              🔀  Approval needed
⚠️ Delete a memory —            Open a pull request
   this can't be undone
                                Frame Slack thread context as untrusted
pr-bot-review-triggers          Repo: mama-sh/deskmate → base main
                                Branch: deskmate/omri/untrusted-context
requested via forget            Reads the committed diff, opens a PR. Never merges.
[ Approve ]   [ Reject ]        requested via open_pull_request
                                [ Approve ]   [ Reject ]
```

Block layout (top to bottom), chosen to satisfy eve's answered-card contract
below:

1. `header` — `🔐 Approval needed` (per-descriptor emoji; plain_text).
2. `section` (mrkdwn) — **the ask**: the descriptor's verb phrase, e.g.
   *Record a decision* / *Open a pull request* / *⚠️ Delete a memory — this can't
   be undone*.
3. `section` (mrkdwn) — **the subject**: the descriptor's headline field, bolded
   (`title` / `title` / `key`).
4. `section` (mrkdwn) — **the details**: the descriptor's secondary fields, each
   `*label*: value`, long free-text as a blockquote, truncated to Slack's section
   limit with an ellipsis. Omitted when there are none.
5. `context` (mrkdwn) — `requested via \`<toolName>\`` (keeps the real tool name
   available for traceability, de-emphasized).
6. `actions` — `Approve` (primary) and `Reject` (danger).

Best-practice basis (researched): make the ask plain (a header as subject line),
show the **real** arguments rather than a paraphrase or raw JSON, reserve
green/red for approve/reject, flag irreversibility persistently, and — on a chat
surface — make the approval feel like a message from the agent (hence posting as
the deskmate). Sources:
[Edilec — AI agent approval screens](https://edilec.com/blog/ai-11018/approval-screens-high-risk-agent-actions/),
[Knock — designing Slack notifications](https://knock.app/blog/the-guide-to-designing-slack-notifications).

### Tool descriptors

A small map keyed on the **tool-name string** (no cross-package tool imports —
core already can't import the catalog's `record_decision`):

```ts
type ToolDescriptor = {
  emoji: string;              // header emoji
  verb: string;              // "Record a decision"
  headline?: (input) => string | undefined;   // subject line (e.g. input.title)
  fields?: (input) => { label: string; value: string }[]; // secondary details
  danger?: boolean;          // irreversible → warning treatment
};
```

Descriptors for the three known tools, plus a **generic fallback** for any
unknown/future tool: header `⚙️ Approval needed`, verb `Run \`<humanized tool
name>\``, and every input field rendered `*key*: value` (long/object values as a
fenced block). The fallback guarantees a readable card even for a tool nobody
registered.

### The eve resume/answered contract (hard constraints)

The custom card must preserve the contract eve's interaction pipeline
(`.../slack/interactions.js`) depends on, or approvals stop resolving:

- **Buttons** carry `action_id = "eve_input:<requestId>:button:<index>"` and
  `value = "<optionId>"` (`approve` / `deny`, read from the request's `options`).
  Built via the public `Button({ id, value })` factory — `id` maps to the Slack
  `action_id` verbatim (`cardToSlackBlocks`), and `deriveHitlResponse` matches
  `^eve_input:(?<requestId>.+):button:\d+$`.
- **All persistent content precedes a single trailing `actions` block.** On click,
  eve rewrites the message via `chat.update` to
  `findPromptBlocks(messageBlocks)` (every `section`/`context`/`divider`/`image`
  block up to the first `actions` block) + `✅ *<answer>*` + `Answered by @user`.
  Blocks after the `actions` block are dropped. Our layout keeps blocks 1–5 before
  the single block 6, so the approved/rejected card retains the full record of
  what was decided.
- `chat.update` does not re-send `username`/`icon_url`, so a card posted as the
  deskmate stays as the deskmate through the answered state.

A contract test (below) locks these so an eve upgrade that changes them fails
loudly instead of silently breaking approvals in production.

### Requesting-deskmate identity (best-effort)

Resolve who is asking from the channel's active-deskmate state, reusing the
existing machinery:

- `actions.requested` already records the delegated deskmate via
  `setActiveDeskmate(channel.state, subagentName, turnId)`.
- An approval pauses the turn **before** `message.completed` resets that state, so
  at `input.requested` time `channel.state.activeDeskmateId` still holds the
  current deskmate. Read it directly (the turn-scoped `activeDeskmateForTurn`
  guard is for cross-turn staleness; a mid-turn approval is not stale).
- Resolve `deskmateSlackIdentity(roster, id)`. With an anchored thread + resolved
  identity, post via `chat.postMessage` with `username` + `icon_url`/`icon_emoji`
  (mirroring the existing reply path). Otherwise fall back to
  `channel.thread.post({ blocks, text })` under the shared bot.

This is **best-effort**: if the deskmate can't be resolved (e.g. the front desk
itself called an approval tool), the card still renders correctly under the shared
bot. Identity is a presentation nicety, never a correctness dependency.

### Question parity (ask_question)

Overriding `input.requested` also replaces the default rendering for the built-in
`ask_question` tool (questions / select / freeform). deskmate doesn't call it, but
the model can, so the handler must still render non-approval requests. For any
request that is **not** an approval (`display !== "confirmation"` or options are
not exactly `approve`/`deny`), render faithful parity with eve's default:

- section prompt, then option buttons (`action_id = "eve_input:<requestId>:button:<n>"`),
  or a radio/static_select (`action_id = "eve_input:<requestId>"`) for `display:
  "select"`,
- or, for freeform, a `Type your answer` button with
  `action_id = "eve_input_freeform:<requestId>"`, `value = requestId`.

eve's pipeline opens the freeform modal and writes the answered card itself from
these action ids — we only emit the trigger blocks. A batch may mix an approval
and a question; each request is rendered independently, one post per request.

## Files

- **New** `packages/core/src/channels/slack-approvals.ts`
  - `renderInputRequest(request, deskmateName?): { blocks, text }` — pure; approval
    → card, otherwise → question parity.
  - `TOOL_DESCRIPTORS` map + generic fallback (keyed on tool-name string).
  - `inputRequestedHandler(roster)` — the `events["input.requested"]` handler:
    resolves identity, builds one post per request, posts as the deskmate or falls
    back to the shared bot.
- **Edit** `packages/core/src/channels/slack.ts` — wire
  `events["input.requested"]: inputRequestedHandler(roster)` into
  `createSlackChannel`; expose a reader for `channel.state.activeDeskmateId` if a
  helper is cleaner than a direct read.
- **New** `packages/core/test/slack-approvals.test.ts` — see below.

## Testing

Pure block-building keeps this unit-testable without a live Slack. Assert:

- **Contract**: approve/reject buttons have `action_id ===
  "eve_input:<requestId>:button:0|1"` and `value === "approve"|"deny"`; exactly
  one `actions` block and it is last; all content blocks precede it.
- **Rendering** per tool: `record_decision` shows the title headline + detail;
  `forget` shows the danger warning + key; `open_pull_request` shows repo/branch/base;
  the generic fallback renders arbitrary fields and never dumps escaped JSON.
- **Question parity**: a `select` request yields the select action-id contract; a
  freeform request yields the `eve_input_freeform:<requestId>` trigger.
- **No raw JSON**: the rendered mrkdwn for an approval never contains a
  `JSON.stringify` blob of the input.

## Out of scope / follow-ups

- **`record_decision` is a stub** — approving it records text but performs no
  action (the tool's `execute` echoes its input). That is a tool-*capability* gap,
  separate from this presentation work. Tracked as
  [mama-sh/deskmate#31](https://github.com/mama-sh/deskmate/issues/31); to be
  handled **after** this lands.
- **Reject-with-reason** — eve's approve/deny is a binary button contract; capturing
  a reason needs the freeform-modal path. Possible fast-follow, not in this scope.
- **Upstreaming** a nicer default renderer to eve is out of deskmate's control and
  not pursued here.
