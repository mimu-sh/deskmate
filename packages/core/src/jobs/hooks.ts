import { defineChannel, POST } from "eve/channels";
import { buildJobMessage, type JobSpec } from "./message.js";
import { verifyHookSignature } from "./signature.js";

// An operator watching logs must be able to tell "sender misconfigured" apart from
// "secret rotated", "under attack", and "secret never set" — every other channel in
// this repo logs (see slack-ambient.ts's [ambient] prefix), this one logged nothing
// on any path. NEVER log the signature, the secret, or the request body here — the
// job id + a fixed per-path reason is enough to diagnose without leaking anything an
// attacker could replay or a secret an operator would need to rotate.
const warn = (jobId: string, reason: string) => console.warn("[hooks]", `job=${jobId}`, reason);

/**
 * Reads the body incrementally and bounds it by BYTES (not JS string length — a
 * multi-byte body can exceed `MAX_HOOK_BODY_BYTES` while its `.length` does not),
 * aborting the moment the cap is crossed instead of buffering the rest. This is the
 * real bound: it holds even for a chunked request, or one that lies about (or omits)
 * `content-length`, on the one route reachable without the secret — the
 * `content-length` pre-check in `handleHookRequest` is only a cheap early-out for
 * when that header happens to be present and honest.
 *
 * Decodes with a single streaming `TextDecoder` across chunks so a multi-byte UTF-8
 * character split across a chunk boundary decodes exactly as it would from
 * `req.text()` — required because the signature is computed over the raw body text.
 */
async function readBoundedBody(req: Request): Promise<{ ok: true; raw: string } | { ok: false }> {
  if (!req.body) return { ok: true, raw: "" };

  const reader = req.body.getReader();
  const decoder = new TextDecoder();
  let raw = "";
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_HOOK_BODY_BYTES) {
      await reader.cancel();
      return { ok: false };
    }
    raw += decoder.decode(value, { stream: true });
  }
  raw += decoder.decode();
  return { ok: true, raw };
}

/** eve channels declare absolute route paths (cf. /eve/v1/slack, /eve/v1/github). */
export const HOOKS_CHANNEL_ROUTE = "/eve/v1/hooks/:job";

/** A webhook-triggered job: its spec plus the resolved Slack conversation to report into. */
export type HookJob = JobSpec & { channelId: string };

/** Generous for a webhook payload; the point is to bound a pre-auth read, not to be tight. */
export const MAX_HOOK_BODY_BYTES = 1_048_576;

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
  const jobId = ctx.params.job;
  if (!ctx.secret) {
    warn(jobId, "rejected: DESKMATE_HOOK_SECRET is not configured");
    return new Response("hook secret not configured", { status: 503 });
  }

  // Bound the body BEFORE reading it (or immediately after, if content-length is
  // absent or lying) — this route is reachable by anyone, with or without the
  // secret, so nothing here should do unbounded work pre-authentication.
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_HOOK_BODY_BYTES) {
    warn(jobId, "rejected: declared content-length exceeds the body size limit");
    return new Response("payload too large", { status: 413 });
  }

  // A missing or lying content-length still gets bounded — incrementally, so a
  // chunked or falsely-small-declared body can never be buffered past the cap.
  const bounded = await readBoundedBody(req);
  if (!bounded.ok) {
    warn(jobId, "rejected: body exceeds the size limit");
    return new Response("payload too large", { status: 413 });
  }
  const raw = bounded.raw;

  const verified = verifyHookSignature({
    raw,
    secret: ctx.secret,
    signature: req.headers.get("x-deskmate-signature"),
    timestamp: req.headers.get("x-deskmate-timestamp"),
    nowMs: ctx.nowMs,
  });
  if (!verified) {
    warn(jobId, "rejected: signature verification failed");
    return new Response("unauthorized", { status: 401 });
  }

  // Object.hasOwn guards against `__proto__`/`constructor`/`toString` resolving to a
  // truthy Object.prototype member instead of a real (absent) job.
  const job = Object.hasOwn(ctx.jobs, ctx.params.job) ? ctx.jobs[ctx.params.job] : undefined;
  if (!job) {
    warn(jobId, "rejected: no such job");
    return new Response("unknown job", { status: 404 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    warn(jobId, "rejected: body is not valid JSON");
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
  // Fail at construction, not per request: buildJobMessage throws for a pr ceiling with no
  // handoff, and inside a route that surfaces as an uncontracted 500 on every call. eve
  // build and `deskmate sync` run this, so a misconfigured job is caught before deploy.
  for (const [id, job] of Object.entries(jobs)) {
    if (job.ceiling === "pr" && !job.handoff) {
      throw new Error(
        `hook job "${id}" has ceiling "pr" but no handoff deskmate — the contract must name ` +
          `who receives the work.`,
      );
    }
  }

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
