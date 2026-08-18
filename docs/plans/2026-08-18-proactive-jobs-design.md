# Proactive jobs: scheduled and event-driven work over external data

**Date:** 2026-08-18
**Status:** Approved — ready for implementation
**Scope:** `@deskmate/core`, `@deskmate/cli`

## Problem

A deskmate only works when a human starts the conversation. The one exception is
the scheduled sweep, and it is Slack-shaped to its bones: its targets are channel
ids, its prompt says "review recent activity in this channel", and the whole team
shares a single cron. There is no way to say "every morning, have the product
analyst read yesterday's support conversations and file what matters", or "the
moment a customer submits feedback, have someone triage it".

Three capabilities are missing:

1. **Named jobs.** Work defined by a cadence, a deskmate, a brief, and a
   destination — independent of Slack channel activity.
2. **Inbound events.** A way for the product a team already runs to say
   "this just happened" and have a deskmate pick it up.
3. **A declared autonomy ceiling.** Proactive work with no human in the loop
   needs an explicit, per-job limit on how far it may go on its own.

Without a shared mechanism, every team re-implements these in prose inside role
instructions, and cross-cutting concerns — don't file duplicates, don't post
noise, stop at this boundary — drift across every deskmate that copies them.

## Design

### Config

```ts
jobs: {
  conversation_review: {
    deskmate: "product_analyst",
    cron: "0 6 * * *",        // exactly one of cron | webhook
    channel: "product",          // a key in `channels`
    ceiling: "issue",         // "digest" | "issue" | "pr"
    window: "24h",            // cron jobs only
    maxItems: 3,
  },
  feedback_triage: {
    deskmate: "customer_success",
    webhook: true,
    channel: "success",
    ceiling: "issue",
  },
}
```

| Field | Meaning |
| --- | --- |
| `deskmate` | Who runs it. Must exist in `deskmates`. |
| `cron` \| `webhook` | The trigger. Exactly one, mirroring `defineSchedule`'s `markdown` \| `run`. |
| `channel` | Where output lands. A key in `channels`. |
| `ceiling` | How far the job may go unattended. Default `digest`. |
| `window` | How far back a cron job looks, as `^\d+[hd]$` (e.g. `24h`, `7d`). Default `24h`. Ignored for webhook jobs. |
| `maxItems` | Cap on action items per run. Default `3`. |
| `brief` | Brief path, relative to `roles/<role>/jobs/`. Defaults to `<job-id>.md`. |
| `handoff` | For `ceiling: "pr"`, which coding deskmate receives the work. |
| `enabled` | Set `false` to stop a job without deleting its config. Default `true`. |

The brief is a role file — `roles/<role>/jobs/<job-id>.md` — so prompts are
versioned beside the deskmate that runs them. `deskmate sync` inlines the body
into the generated schedule; since `build` runs `deskmate sync && eve build`, an
edited brief can never ship stale.

### Two supporting config additions

**`ConnectionConfig.write?: boolean`.** Write capability is currently expressed
only in comments, so nothing can check it. Declaring it lets `defineTeam` reject
`ceiling: "issue"` on a deskmate that reads no write-capable connection, instead
of the job discovering that at run time.

**`ChannelRoute.id?: string`.** `receive()` passes `target.channelId` straight to
Slack's API, but `channels` keys may be names rather than ids — `resolveRoute`
accepts either. A name-keyed channel therefore produces a target Slack cannot
resolve. Jobs resolve `route.id ?? key` and `deskmate sync` warns when the result
does not match `^[CGD][A-Z0-9]+$`. The existing sweep adopts the same resolver,
which fixes the same latent bug there.

### Validation (`defineTeam`)

- Job ids are snake_case: they become filenames and URL segments.
- `deskmate` and `channel` must exist.
- Exactly one of `cron` / `webhook`.
- `window` matches `^\d+[hd]$`.
- Ceilings are cumulative (`pr` ⊃ `issue` ⊃ `digest`), so any ceiling above
  `digest` requires the deskmate to read a connection marked `write`.
- `ceiling: "pr"` additionally requires a coding deskmate — named by `handoff`, or
  inferred when the team has exactly one. Ambiguity is an error, not a guess.

### What sync generates

**Each cron job** becomes its own `agent/schedules/job-<id>.ts`, so each gets an
independent Vercel Cron Job with its own cadence — the thing a single shared
sweep cannot express. The handler stays thin; the message comes from a pure core
function so it can be tested apart from the channel:

```
[routing] Delegate to the `<deskmate>` deskmate (<Display Name>).
[proactive:job:<id>] window: last <window>

<brief body>

<autonomy contract, rendered from ceiling + maxItems>
<dedup protocol>
```

**Webhook jobs** share one generated `agent/channels/hooks.ts` exposing
`POST /eve/v1/hooks/:job`. It verifies the signature, resolves the job, hands off
via `receive()` inside `waitUntil`, and returns `202` immediately so the caller
never blocks on agent work. The payload's `data` object is passed to the brief as
JSON; core stays ignorant of what any given event means.

Generated files for removed jobs are deleted on sync. A stale schedule file keeps
firing forever otherwise — the same reason the sweep renderer already deletes.

### The autonomy ceiling

`digest` posts findings and files nothing. `issue` may file up to `maxItems`.
`pr` may do everything `issue` may, and additionally hand one well-scoped item to
the coding deskmate, whose existing approval gate still stands before any PR opens.

This is instruction-enforced and capability-gated, not sandboxed. Config-time
validation guarantees a job's deskmate *can* do what its ceiling allows, and a
`digest` job's deskmate holds no write connection to misuse. That is the honest
boundary: the ceiling narrows what a job is told to do and what it is equipped to
do, and it does not intercept tool calls.

### Deduplication

Recurring reviews re-encounter the same problem daily. Rather than provisioning
storage for a ledger, the issue tracker is the ledger. Every filed issue carries
a `deskmate-job` label and a marker:

```
<!-- deskmate-fingerprint: whatsapp-image-upload-fails -->
```

Before filing, a job searches `label:deskmate-job` for the fingerprint. On a
match it comments on the existing issue with the new occurrence instead of
opening a duplicate. The model chooses a stable kebab-case slug rather than
hashing the text, because the same complaint never arrives phrased identically
twice. The record ends up where a person would look for it, and no database is
introduced to remember what was already said.

### Webhook signature

Headers `x-deskmate-timestamp` and
`x-deskmate-signature: sha256=<hmac-sha256(secret, "<ts>.<rawBody>")>`, verified
with a constant-time compare against `DESKMATE_HOOK_SECRET` and a five-minute
replay window. The scheme deliberately mirrors Slack's, so anyone wiring a sender
has a reference implementation to copy.

### Cost and noise

Every job's contract ends with "if nothing clears the bar, finish silently". eve
supports conditional delivery, so a quiet day costs one session and posts
nothing. `maxItems` bounds a loud day.

## Testing

Pure functions are extracted so they can be tested without a channel, following
`sweepTargets` and `nextConveneDecision`.

**core**
- `defineTeam` rejects: unknown deskmate, unknown channel, both or neither of
  cron/webhook, `issue` without a write connection, `pr` with no or ambiguous
  coding deskmate, non-snake_case job id.
- `buildJobMessage` renders the correct contract for each ceiling, honours
  `maxItems`, and includes the window for cron jobs only.
- `verifyHookSignature` accepts a valid signature; rejects a tampered body, a
  wrong secret, and a stale timestamp.
- Fingerprint marker formats and parses round-trip.

**cli**
- One schedule file per cron job; exactly one `hooks.ts` when any webhook job
  exists; none when there are none.
- Removing a job deletes its generated file.
- A job whose channel does not resolve to a Slack id produces a warning.

**Gates:** `pnpm lint`, `pnpm typecheck`, `pnpm test`, and a local `pnpm build`.
The build gate is not optional: sync, typecheck, and vitest all pass on a config
that `eve build` rejects, and that failure would otherwise surface only in a
remote build log.

**Manual:** `eve dev`, then
`curl -X POST localhost:3000/eve/v1/dev/schedules/job-<id>` fires a cron job once
out of band, and a signed curl to `/eve/v1/hooks/<job>` exercises the webhook
path. Production builds do not mount the dispatch route, so this is the only way
to run a job without waiting for a tick.

## Out of scope

- Dynamic, per-tenant schedules. eve compiles schedules from files at build time;
  runtime-defined cadences are a separate problem.
- A durable cursor store. Cron jobs derive their window from the cadence and
  webhook jobs carry their payload, so nothing needs a watermark yet.
- Ceiling enforcement at the tool-call layer.
