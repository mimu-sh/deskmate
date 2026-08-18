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

import type { SlackChannelEvents } from "eve/channels/slack";
import { deskmateSlackIdentity } from "../deskmate-identity.js";
import type { Roster } from "../roster.js";

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
  forget: {
    emoji: "🗑️",
    verb: "Delete a memory",
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
      const repo = str(i.repo);
      if (repo) f.push({ label: "Repo", value: base ? `${repo} → base ${base}` : repo });
      if (str(i.branch)) f.push({ label: "Branch", value: str(i.branch) });
      if (str(i.body)) f.push({ label: "Description", value: str(i.body) });
      return f;
    },
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

// Slack caps button/option/menu `plain_text` at 75 chars and rejects the WHOLE
// chat.postMessage if any element exceeds it — so an over-long option label would
// make the question fail to post. Cap every plain_text element, matching eve's
// own `truncatePlainText`.
const PLAIN_TEXT_MAX = 75;
function plainText(text: string, max = PLAIN_TEXT_MAX): SlackBlock {
  return { type: "plain_text", text: truncate(text, max) };
}

// Neutralize Slack mrkdwn control chars in MODEL-supplied text before it lands on
// the human's approval decision surface, so a tool-input value can't inject a
// `<!channel>` ping, a `<@U…>` mention, or a masked `<url|text>` link that
// spoofs where "Approve" leads. Escaping only `& < >` (Slack's documented set)
// leaves legitimate `*bold*`/`_italic_` formatting intact — nicer than eve's raw
// code-fence, and still safe. Applied to headlines, field labels/values, and
// question prompts; our own literals (verbs, "Repo:") pass through unchanged.
function escapeMrkdwn(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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
    text: plainText(labelFor[opt.id] ?? opt.label),
    value: opt.id,
    ...(styleFor[opt.id] ? { style: styleFor[opt.id] } : {}),
  }));
  return { type: "actions", elements };
}

function renderApproval(req: InputRequest, deskmateName?: string): RenderedRequest {
  const d = TOOL_DESCRIPTORS[req.action.toolName] ?? fallbackDescriptor(req.action.toolName);
  const ask = d.danger
    ? `:warning: ${d.emoji} *${d.verb}* — this can't be undone`
    : `${d.emoji} *${d.verb}*`;
  const blocks: SlackBlock[] = [
    { type: "header", text: { type: "plain_text", text: "🔐 Approval needed", emoji: true } },
    section(ask),
  ];
  const headline = d.headline?.(req.action.input);
  const safeHeadline = headline ? escapeMrkdwn(headline) : undefined;
  if (safeHeadline) blocks.push(section(`*${safeHeadline}*`));
  for (const f of d.fields?.(req.action.input) ?? [])
    blocks.push(section(`*${escapeMrkdwn(f.label)}:* ${escapeMrkdwn(f.value)}`));
  // deskmateName is consumer-supplied (roster displayName), so escape it too —
  // both for consistency and to survive a name with `&`/`<`/`>`.
  const who = deskmateName ? `${escapeMrkdwn(deskmateName)} · ` : "";
  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: `${who}requested via \`${req.action.toolName}\`` }],
  });
  blocks.push(approvalActions(req));
  return { blocks, text: `Approval needed: ${d.verb}${safeHeadline ? ` — ${safeHeadline}` : ""}` };
}

function toOption(opt: InputOption): SlackBlock {
  const o: SlackBlock = { text: plainText(opt.label), value: opt.id };
  if (opt.description) o.description = plainText(opt.description);
  return o;
}

function renderQuestion(req: InputRequest): RenderedRequest {
  const blocks: SlackBlock[] = [section(escapeMrkdwn(req.prompt))];
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
        text: plainText(opt.label),
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
  // Escape the notification/accessibility fallback too — Slack processes `<!channel>`
  // / `<@U…>` in `text`, so an un-escaped prompt could ping despite the escaped block.
  return { blocks, text: escapeMrkdwn(req.prompt) };
}

export function renderInputRequest(req: InputRequest, deskmateName?: string): RenderedRequest {
  return isApproval(req) ? renderApproval(req, deskmateName) : renderQuestion(req);
}

/**
 * `events["input.requested"]` handler: render each pending HITL request as a
 * human-readable card and post it AS the requesting deskmate — for APPROVAL
 * requests only — when we can resolve one and the thread is anchored; questions
 * and everything else post under the shared bot. `blocks` is identical either way.
 *
 * Attribution is scoped to approvals on purpose. Approvals are subagent-proxied,
 * so `activeDeskmateId` is the deskmate that raised them (set on this same parent
 * turn). A built-in `ask_question` can instead come straight from the front desk,
 * where `activeDeskmateId` may be a leftover from an earlier turn — attributing a
 * question to it would impersonate a stale deskmate, so questions never carry it.
 *
 * Identity is resolved from `activeDeskmateId` on the channel state. Every
 * approval-gated tool is subagent-bound, and a subagent runs as a separate child
 * session — but eve forwards the child's approval onto the PARENT session's
 * stream and renders it against the PARENT's channel state (traced through eve's
 * subagent-HITL bridge: subagent-adapter → parent turn inbox → proxied
 * `input.requested`). So the id the parent turn's `actions.requested` stored on
 * that state IS present here. We read it RAW, not turn-scoped
 * (`activeDeskmateForTurn`): the proxied event carries the CHILD turn's id, so
 * `activeDeskmateForTurn(state, data.turnId)` would never match and would always
 * fall back to the shared bot — defeating the point.
 *
 * Known residual (cosmetic, #32): `activeDeskmateId` is a single scalar, so two
 * delegations within one parent turn can attribute a late-bubbling approval to
 * the wrong deskmate. Identity is best-effort and never affects the approval
 * contract or its resolution; only the sender name/avatar.
 */
export function inputRequestedHandler(roster: Roster): NonNullable<SlackChannelEvents["input.requested"]> {
  return async (data, channel) => {
    const state = channel.state as {
      activeDeskmateId?: string | null;
      channelId: string | null;
      threadTs: string | null;
    };
    const id = typeof state.activeDeskmateId === "string" ? state.activeDeskmateId : null;
    const identity = deskmateSlackIdentity(roster, id);
    const deskmateName = identity?.username;
    const { channelId, threadTs } = state;

    for (const req of data.requests as unknown as InputRequest[]) {
      // Only approvals carry the deskmate identity (see the doc comment): a stale
      // `activeDeskmateId` must never impersonate on a front-desk `ask_question`.
      const name = isApproval(req) ? deskmateName : undefined;
      const { blocks, text } = renderInputRequest(req, name);
      if (identity && name && channelId && threadTs) {
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
