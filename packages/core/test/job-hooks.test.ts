import { describe, it, expect, vi } from "vitest";
import { handleHookRequest, type HookJob } from "../src/jobs/hooks.js";
import { signHookBody } from "../src/jobs/signature.js";

const secret = "s3cr3t";
const slack = { __slack: true };
const jobs: Record<string, HookJob> = {
  feedback_triage: {
    jobId: "feedback_triage",
    deskmate: "customer_success",
    displayName: "Customer Success Analyst",
    brief: "Triage this feedback.",
    ceiling: "issue",
    maxItems: 3,
    channelId: "C0SUCCESS",
  },
};

const body = JSON.stringify({ job: "feedback_triage", data: { id: "f1", message: "cannot upload" } });
const nowMs = 1_760_000_000_000;
const ts = String(Math.floor(nowMs / 1000));

function request(over: { body?: string; signature?: string | null; timestamp?: string | null } = {}) {
  const raw = over.body ?? body;
  const headers = new Headers({ "content-type": "application/json" });
  const sig = over.signature === undefined ? signHookBody(secret, ts, raw) : over.signature;
  if (sig !== null) headers.set("x-deskmate-signature", sig);
  const t = over.timestamp === undefined ? ts : over.timestamp;
  if (t !== null) headers.set("x-deskmate-timestamp", t);
  return new Request("https://example.test/eve/v1/hooks/feedback_triage", { method: "POST", headers, body: raw });
}

const helpers = () => ({ receive: vi.fn().mockResolvedValue(undefined), waitUntil: vi.fn() });

describe("handleHookRequest", () => {
  it("accepts a signed request and hands the run to Slack", async () => {
    const h = helpers();
    const res = await handleHookRequest(request(), {
      jobs, slack, params: { job: "feedback_triage" }, secret, nowMs, ...h,
    });

    expect(res.status).toBe(202);
    expect(h.waitUntil).toHaveBeenCalledTimes(1);
    const [channel, args] = h.receive.mock.calls[0];
    expect(channel).toBe(slack);
    expect(args.target).toEqual({ channelId: "C0SUCCESS" });
    expect(args.message).toContain("[proactive:job:feedback_triage]");
    expect(args.message).toContain('"message": "cannot upload"');
  });

  it("rejects an unsigned request with 401 and starts nothing", async () => {
    const h = helpers();
    const res = await handleHookRequest(request({ signature: null }), {
      jobs, slack, params: { job: "feedback_triage" }, secret, nowMs, ...h,
    });
    expect(res.status).toBe(401);
    expect(h.receive).not.toHaveBeenCalled();
  });

  it("rejects a tampered body with 401", async () => {
    const h = helpers();
    const tampered = request();
    const res = await handleHookRequest(
      new Request(tampered.url, { method: "POST", headers: tampered.headers, body: body.replace("f1", "f2") }),
      { jobs, slack, params: { job: "feedback_triage" }, secret, nowMs, ...h },
    );
    expect(res.status).toBe(401);
    expect(h.receive).not.toHaveBeenCalled();
  });

  it("returns 503 when no secret is configured, rather than accepting anything", async () => {
    const h = helpers();
    const res = await handleHookRequest(request(), {
      jobs, slack, params: { job: "feedback_triage" }, secret: undefined, nowMs, ...h,
    });
    expect(res.status).toBe(503);
    expect(h.receive).not.toHaveBeenCalled();
  });

  it("returns 404 for an unknown job", async () => {
    const h = helpers();
    const res = await handleHookRequest(request(), {
      jobs, slack, params: { job: "no_such_job" }, secret, nowMs, ...h,
    });
    expect(res.status).toBe(404);
    expect(h.receive).not.toHaveBeenCalled();
  });

  it("returns 400 for a signed but unparseable body", async () => {
    const h = helpers();
    const res = await handleHookRequest(request({ body: "not json" }), {
      jobs, slack, params: { job: "feedback_triage" }, secret, nowMs, ...h,
    });
    expect(res.status).toBe(400);
    expect(h.receive).not.toHaveBeenCalled();
  });
});
