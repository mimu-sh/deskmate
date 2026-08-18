import { describe, it, expect } from "vitest";
import { buildJobMessage, type JobSpec } from "../src/jobs/message.js";

const spec = (over: Partial<JobSpec> = {}): JobSpec => ({
  jobId: "conversation_review",
  deskmate: "product_analyst",
  displayName: "Product Analyst",
  brief: "Read yesterday's conversations and report what broke.",
  ceiling: "digest",
  maxItems: 3,
  window: "24h",
  ...over,
});

describe("buildJobMessage", () => {
  it("opens with the routing directive naming the deskmate", () => {
    expect(buildJobMessage(spec())).toContain(
      "[routing] Delegate to the `product_analyst` deskmate (Product Analyst).",
    );
  });

  it("tags the run with the job id and the window for a cron job", () => {
    expect(buildJobMessage(spec())).toContain("[proactive:job:conversation_review] window: last 24h");
  });

  it("omits the window for a webhook job and inlines the payload as JSON", () => {
    const msg = buildJobMessage(spec({ window: undefined }), { id: "f1", message: "cannot upload" });
    expect(msg).not.toContain("window:");
    expect(msg).toContain('"message": "cannot upload"');
  });

  it("includes the brief verbatim", () => {
    expect(buildJobMessage(spec())).toContain("Read yesterday's conversations and report what broke.");
  });

  it("forbids external records at the digest ceiling", () => {
    const msg = buildJobMessage(spec());
    expect(msg).toContain("Do NOT create issues, pull requests, or any other external record");
    expect(msg).not.toContain("deskmate-fingerprint");
  });

  it("permits a bounded number of issues at the issue ceiling", () => {
    const msg = buildJobMessage(spec({ ceiling: "issue", maxItems: 2 }));
    expect(msg).toContain("file at most 2 issue(s)");
    expect(msg).toContain("Do not open pull requests");
  });

  it("permits one handoff at the pr ceiling and keeps the approval gate", () => {
    const msg = buildJobMessage(spec({ ceiling: "pr", handoff: "fullstack_engineer" }));
    expect(msg).toContain("hand at most ONE well-scoped item to the `fullstack_engineer` deskmate");
    expect(msg).toContain("approval gate still applies");
  });

  it("includes the dedup protocol above the digest ceiling", () => {
    const msg = buildJobMessage(spec({ ceiling: "issue" }));
    expect(msg).toContain("label:deskmate-job");
    expect(msg).toContain("<!-- deskmate-fingerprint: some-stable-slug -->");
    expect(msg).toContain("add a comment to THAT issue");
  });

  it("always permits finishing silently", () => {
    for (const ceiling of ["digest", "issue"] as const) {
      expect(buildJobMessage(spec({ ceiling }))).toContain("finish silently without posting");
    }
  });

  it("refuses to render a pr ceiling with no handoff, rather than naming `undefined`", () => {
    expect(() => buildJobMessage(spec({ ceiling: "pr" }))).toThrow(/no handoff deskmate/);
  });

  it("keeps the pr ceiling cumulative — it may still file issues", () => {
    const msg = buildJobMessage(spec({ ceiling: "pr", handoff: "fullstack_engineer", maxItems: 2 }));
    expect(msg).toContain("file at most 2 issue(s)");
    expect(msg).toContain("hand at most ONE well-scoped item");
  });

  it("includes the dedup protocol at the pr ceiling too", () => {
    const msg = buildJobMessage(spec({ ceiling: "pr", handoff: "fullstack_engineer" }));
    expect(msg).toContain("label:deskmate-job");
  });

  it("permits finishing silently at the pr ceiling", () => {
    expect(buildJobMessage(spec({ ceiling: "pr", handoff: "fullstack_engineer" })))
      .toContain("finish silently without posting");
  });

  it("does not leak one ceiling's permissions into another", () => {
    const digest = buildJobMessage(spec());
    expect(digest).not.toContain("file at most");
    expect(digest).not.toContain("hand at most");
    const issue = buildJobMessage(spec({ ceiling: "issue" }));
    expect(issue).not.toContain("hand at most");
  });
});
