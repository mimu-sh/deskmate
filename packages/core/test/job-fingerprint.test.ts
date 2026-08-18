import { describe, it, expect } from "vitest";
import { JOB_LABEL, fingerprintMarker, parseFingerprint } from "../src/jobs/fingerprint.js";

describe("fingerprintMarker", () => {
  it("renders an HTML comment carrying the slug", () => {
    expect(fingerprintMarker("whatsapp-image-upload-fails"))
      .toBe("<!-- deskmate-fingerprint: whatsapp-image-upload-fails -->");
  });
  it.each(["Not-Kebab", "trailing-", "has space", "", "under_score"])("rejects %s", (s) => {
    expect(() => fingerprintMarker(s)).toThrow(/kebab-case/);
  });
});

describe("parseFingerprint", () => {
  it("round-trips a rendered marker", () => {
    expect(parseFingerprint(fingerprintMarker("voice-drops-after-30s"))).toBe("voice-drops-after-30s");
  });
  it("finds the marker inside a larger issue body", () => {
    const body = `## Summary\n\nUsers cannot upload.\n\n${fingerprintMarker("upload-broken")}\n`;
    expect(parseFingerprint(body)).toBe("upload-broken");
  });
  it("tolerates loose whitespace", () => {
    expect(parseFingerprint("<!--deskmate-fingerprint:   spaced-out  -->")).toBe("spaced-out");
  });
  it("returns null when no marker is present", () => {
    expect(parseFingerprint("just an ordinary issue body")).toBeNull();
  });
});

describe("JOB_LABEL", () => {
  it("is the label every job-filed issue carries", () => {
    expect(JOB_LABEL).toBe("deskmate-job");
  });
});
