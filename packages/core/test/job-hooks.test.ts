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

// `to(channel, target).send(message, options)` — eve's cross-channel delivery API.
// The extra `send` key rides along on the spread ctx and is simply ignored.
const helpers = () => {
  const send = vi.fn().mockResolvedValue(undefined);
  return { to: vi.fn((_channel: unknown, _target: unknown) => ({ send })), send, waitUntil: vi.fn() };
};

describe("handleHookRequest", () => {
  it("accepts a signed request and hands the run to Slack", async () => {
    const h = helpers();
    const res = await handleHookRequest(request(), {
      jobs, slack, params: { job: "feedback_triage" }, secret, nowMs, ...h,
    });

    expect(res.status).toBe(202);
    expect(h.waitUntil).toHaveBeenCalledTimes(1);
    const [channel, target] = h.to.mock.calls[0];
    const [message] = h.send.mock.calls[0];
    expect(channel).toBe(slack);
    expect(target).toEqual({ channelId: "C0SUCCESS" });
    expect(message).toContain("[proactive:job:feedback_triage]");
    expect(message).toContain('"message": "cannot upload"');
  });

  it("rejects an unsigned request with 401 and starts nothing", async () => {
    const h = helpers();
    const res = await handleHookRequest(request({ signature: null }), {
      jobs, slack, params: { job: "feedback_triage" }, secret, nowMs, ...h,
    });
    expect(res.status).toBe(401);
    expect(h.to).not.toHaveBeenCalled();
  });

  it("rejects a tampered body with 401", async () => {
    const h = helpers();
    const tampered = request();
    const res = await handleHookRequest(
      new Request(tampered.url, { method: "POST", headers: tampered.headers, body: body.replace("f1", "f2") }),
      { jobs, slack, params: { job: "feedback_triage" }, secret, nowMs, ...h },
    );
    expect(res.status).toBe(401);
    expect(h.to).not.toHaveBeenCalled();
  });

  it("returns 503 when no secret is configured, rather than accepting anything", async () => {
    const h = helpers();
    const res = await handleHookRequest(request(), {
      jobs, slack, params: { job: "feedback_triage" }, secret: undefined, nowMs, ...h,
    });
    expect(res.status).toBe(503);
    expect(h.to).not.toHaveBeenCalled();
  });

  it("returns 404 for an unknown job", async () => {
    const h = helpers();
    const res = await handleHookRequest(request(), {
      jobs, slack, params: { job: "no_such_job" }, secret, nowMs, ...h,
    });
    expect(res.status).toBe(404);
    expect(h.to).not.toHaveBeenCalled();
  });

  it("returns 400 for a signed but unparseable body", async () => {
    const h = helpers();
    const res = await handleHookRequest(request({ body: "not json" }), {
      jobs, slack, params: { job: "feedback_triage" }, secret, nowMs, ...h,
    });
    expect(res.status).toBe(400);
    expect(h.to).not.toHaveBeenCalled();
  });

  it("answers 401, not 404, for a bad signature on an unknown job — no id enumeration", async () => {
    const h = helpers();
    const res = await handleHookRequest(request({ signature: "sha256=deadbeef" }), {
      jobs, slack, params: { job: "no_such_job" }, secret, nowMs, ...h,
    });
    expect(res.status).toBe(401);
    expect(h.to).not.toHaveBeenCalled();
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
    expect(h.to).not.toHaveBeenCalled();
  });

  it("bounds the body by BYTES, not JS string length — a multi-byte body can exceed the cap while .length does not", async () => {
    // Each "€" is 1 UTF-16 code unit (raw.length) but 3 UTF-8 bytes. 400,000 of them:
    // .length ≈ 400,040 (well under MAX_HOOK_BODY_BYTES=1,048,576), byte length ≈
    // 1,200,040 (well over it). A `.length`-based check would accept this.
    const h = helpers();
    const raw = JSON.stringify({ job: "feedback_triage", note: "€".repeat(400_000) });
    expect(raw.length).toBeLessThan(1_048_576);
    expect(Buffer.byteLength(raw, "utf8")).toBeGreaterThan(1_048_576);
    const req = request({ body: raw });
    const res = await handleHookRequest(req, {
      jobs, slack, params: { job: "feedback_triage" }, secret, nowMs, ...h,
    });
    expect(res.status).toBe(413);
    expect(h.to).not.toHaveBeenCalled();
  });

  it("decodes multi-byte UTF-8 exactly like req.text() would, so the signature still verifies", async () => {
    // Not oversized — proves the streaming reader's TextDecoder produces the same
    // string req.text() would, including a char split across a chunk boundary
    // (the reader in handleHookRequest reads in whatever chunk sizes the platform
    // hands back; this body is small enough to likely arrive in one chunk, but the
    // signature — computed over the exact raw text — is the strongest possible
    // proof of byte-for-byte fidelity either way).
    const h = helpers();
    const raw = JSON.stringify({ job: "feedback_triage", note: "café €100 日本語" });
    const req = request({ body: raw });
    const res = await handleHookRequest(req, {
      jobs, slack, params: { job: "feedback_triage" }, secret, nowMs, ...h,
    });
    expect(res.status).toBe(202);
    const [message] = h.send.mock.calls[0];
    expect(message).toContain("café €100 日本語");
  });

  it("rejects a chunked/streamed oversized body without buffering the whole thing", async () => {
    // No content-length header (a real chunked request has none), and the stream
    // never ends — if handleHookRequest still buffered the whole body (e.g. via
    // req.text()), this would hang until the test times out instead of failing
    // fast with 413. A bounded number of pulls, and a cancelled reader, prove the
    // read stopped as soon as the cap was crossed.
    const h = helpers();
    const chunk = new Uint8Array(65_536).fill(97); // 64 KiB of 'a'
    let pulls = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    const req = new Request("https://example.test/eve/v1/hooks/feedback_triage", {
      method: "POST",
      headers: new Headers({ "content-type": "application/json" }),
      body: stream,
      duplex: "half",
    } as RequestInit);
    const res = await handleHookRequest(req, {
      jobs, slack, params: { job: "feedback_triage" }, secret, nowMs, ...h,
    });
    expect(res.status).toBe(413);
    expect(h.to).not.toHaveBeenCalled();
    expect(cancelled).toBe(true);
    // MAX_HOOK_BODY_BYTES (1_048_576) / 65_536-byte chunks = 16; a couple more is
    // fine, but nowhere near "kept pulling forever".
    expect(pulls).toBeLessThan(64);
  });

  it("treats a null body as empty rather than throwing", async () => {
    const h = helpers();
    const emptyRaw = "";
    // No `body` key at all: req.body is null, distinct from an empty-string body.
    const req = new Request("https://example.test/eve/v1/hooks/feedback_triage", {
      method: "POST",
      headers: new Headers({
        "content-type": "application/json",
        "x-deskmate-signature": signHookBody(secret, ts, emptyRaw),
        "x-deskmate-timestamp": ts,
      }),
    });
    expect(req.body).toBeNull();
    const res = await handleHookRequest(req, {
      jobs, slack, params: { job: "feedback_triage" }, secret, nowMs, ...h,
    });
    // Empty body isn't valid JSON, so this fails at parse — the point is that it
    // gets there at all instead of throwing on a null req.body.
    expect(res.status).toBe(400);
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
    expect(h.to).not.toHaveBeenCalled();
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
