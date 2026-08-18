import { describe, it, expect, vi } from "vitest";
import { createHooksChannel, handleHookRequest, type HookJob } from "../src/jobs/hooks.js";
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

  it("answers 401, not 404, for a bad signature on an unknown job — no id enumeration", async () => {
    const h = helpers();
    const res = await handleHookRequest(request({ signature: "sha256=deadbeef" }), {
      jobs, slack, params: { job: "no_such_job" }, secret, nowMs, ...h,
    });
    expect(res.status).toBe(401);
    expect(h.receive).not.toHaveBeenCalled();
  });

  it("rejects an oversized body before doing any signature work", async () => {
    const h = helpers();
    const big = "x".repeat(1_048_577);
    const req = new Request("https://example.test/eve/v1/hooks/feedback_triage", {
      method: "POST", headers: new Headers({ "content-type": "application/json" }), body: big,
    });
    const res = await handleHookRequest(req, {
      jobs, slack, params: { job: "feedback_triage" }, secret, nowMs, ...h,
    });
    expect(res.status).toBe(413);
    expect(h.receive).not.toHaveBeenCalled();
  });

  it("refuses to construct a channel for a pr job with no handoff", () => {
    expect(() =>
      createHooksChannel(
        { bad: { ...jobs.feedback_triage, ceiling: "pr", handoff: undefined } },
        { slack },
      ),
    ).toThrow(/no handoff deskmate/);
  });

  it("does not resolve a prototype key as a job", async () => {
    const h = helpers();
    const res = await handleHookRequest(request(), {
      jobs, slack, params: { job: "__proto__" }, secret, nowMs, ...h,
    });
    expect(res.status).toBe(404);
    expect(h.receive).not.toHaveBeenCalled();
  });

  describe("logging", () => {
    it("warns with the job id on a rejected (non-2xx) path", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const h = helpers();
      await handleHookRequest(request({ signature: null }), {
        jobs, slack, params: { job: "feedback_triage" }, secret, nowMs, ...h,
      });
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const logged = warnSpy.mock.calls[0].join(" ");
      expect(logged).toContain("feedback_triage");
      warnSpy.mockRestore();
    });

    it("never logs the signature, the secret, or the body", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const h = helpers();
      await handleHookRequest(request({ signature: "sha256=deadbeef" }), {
        jobs, slack, params: { job: "feedback_triage" }, secret, nowMs, ...h,
      });
      const logged = warnSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logged).not.toContain(secret);
      expect(logged).not.toContain("deadbeef");
      expect(logged).not.toContain("cannot upload");
      warnSpy.mockRestore();
    });

    it("does not warn on a successful (202) request", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const h = helpers();
      await handleHookRequest(request(), {
        jobs, slack, params: { job: "feedback_triage" }, secret, nowMs, ...h,
      });
      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });
});
