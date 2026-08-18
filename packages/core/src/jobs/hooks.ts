import { defineChannel, POST } from "eve/channels";
import { buildJobMessage, type JobSpec } from "./message.js";
import { verifyHookSignature } from "./signature.js";

/** eve channels declare absolute route paths (cf. /eve/v1/slack, /eve/v1/github). */
export const HOOKS_CHANNEL_ROUTE = "/eve/v1/hooks/:job";

/** A webhook-triggered job: its spec plus the resolved Slack conversation to report into. */
export type HookJob = JobSpec & { channelId: string };

export interface HookRequestContext {
  jobs: Record<string, HookJob>;
  slack: unknown;
  params: { job: string };
  secret: string | undefined;
  nowMs: number;
  receive: (channel: never, args: unknown) => Promise<unknown>;
  waitUntil: (task: Promise<unknown>) => void;
}

/**
 * The whole inbound-hook decision, kept apart from `defineChannel` so it can be
 * driven by a plain Request in tests.
 *
 * Verification comes before job lookup on purpose: an unauthenticated caller learns
 * nothing about which job ids exist.
 */
export async function handleHookRequest(req: Request, ctx: HookRequestContext): Promise<Response> {
  if (!ctx.secret) return new Response("hook secret not configured", { status: 503 });

  const raw = await req.text();
  const verified = verifyHookSignature({
    raw,
    secret: ctx.secret,
    signature: req.headers.get("x-deskmate-signature"),
    timestamp: req.headers.get("x-deskmate-timestamp"),
    nowMs: ctx.nowMs,
  });
  if (!verified) return new Response("unauthorized", { status: 401 });

  const job = ctx.jobs[ctx.params.job];
  if (!job) return new Response("unknown job", { status: 404 });

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return new Response("invalid json", { status: 400 });
  }

  // Hand off in the background and answer immediately: the sender is a product
  // request path and must never wait on an agent run.
  ctx.waitUntil(
    ctx.receive(ctx.slack as never, {
      message: buildJobMessage(job, payload),
      target: { channelId: job.channelId },
      auth: null,
    }),
  );

  return new Response(null, { status: 202 });
}

/**
 * The single channel serving every webhook job, mounted at /eve/v1/hooks/:job.
 * The secret is read per request so a rotated `DESKMATE_HOOK_SECRET` takes effect
 * without a rebuild.
 */
export function createHooksChannel(jobs: Record<string, HookJob>, opts: { slack: unknown }) {
  return defineChannel({
    routes: [
      POST(HOOKS_CHANNEL_ROUTE, async (req, { receive, waitUntil, params }) =>
        handleHookRequest(req, {
          jobs,
          slack: opts.slack,
          params: params as { job: string },
          secret: process.env.DESKMATE_HOOK_SECRET,
          nowMs: Date.now(),
          receive: receive as never,
          waitUntil,
        }),
      ),
    ],
  });
}
