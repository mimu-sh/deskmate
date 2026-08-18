import { describe, it, expect } from "vitest";
import { signHookBody, verifyHookSignature } from "../src/jobs/signature.js";

const secret = "s3cr3t";
const raw = JSON.stringify({ job: "feedback_triage", data: { id: "f1" } });
const nowMs = 1_760_000_000_000;
const ts = String(Math.floor(nowMs / 1000));
const ok = { raw, secret, signature: signHookBody(secret, ts, raw), timestamp: ts, nowMs };

describe("signHookBody", () => {
  it("prefixes the hex digest with sha256=", () => {
    expect(signHookBody(secret, ts, raw)).toMatch(/^sha256=[0-9a-f]{64}$/);
  });
  it("changes when the body changes", () => {
    expect(signHookBody(secret, ts, raw)).not.toBe(signHookBody(secret, ts, `${raw} `));
  });
  it("changes when the timestamp changes", () => {
    expect(signHookBody(secret, ts, raw)).not.toBe(signHookBody(secret, "1", raw));
  });
});

describe("verifyHookSignature", () => {
  it("accepts a correctly signed request", () => {
    expect(verifyHookSignature(ok)).toBe(true);
  });
  it("rejects a tampered body", () => {
    expect(verifyHookSignature({ ...ok, raw: raw.replace("f1", "f2") })).toBe(false);
  });
  it("rejects a signature made with a different secret", () => {
    expect(verifyHookSignature({ ...ok, signature: signHookBody("other", ts, raw) })).toBe(false);
  });
  it("rejects a stale timestamp beyond the replay window", () => {
    expect(verifyHookSignature({ ...ok, nowMs: nowMs + 301_000 })).toBe(false);
  });
  it("rejects a timestamp too far in the future", () => {
    expect(verifyHookSignature({ ...ok, nowMs: nowMs - 301_000 })).toBe(false);
  });
  it("accepts a timestamp inside the replay window", () => {
    expect(verifyHookSignature({ ...ok, nowMs: nowMs + 299_000 })).toBe(true);
  });
  it.each([
    ["missing signature", { signature: null }],
    ["missing timestamp", { timestamp: null }],
    ["non-numeric timestamp", { timestamp: "not-a-number" }],
    ["signature without the sha256 prefix", { signature: "deadbeef" }],
    ["signature of the wrong length", { signature: "sha256=abc" }],
  ])("rejects %s", (_label, over) => {
    expect(verifyHookSignature({ ...ok, ...(over as object) })).toBe(false);
  });

  // `Number()` alone would accept all of these (whitespace → 0, hex, exponent
  // notation, a leading "+", and decimals) — harmless today only because the
  // replay window rejects them, but `toleranceSec` is caller-tunable, so a
  // consumer that widens it would silently make an out-of-format timestamp
  // reachable. The strict `^\d+$` check must reject them independent of tolerance.
  it.each([
    ["whitespace-only", "   "],
    ["hex", "0x10"],
    ["exponent notation", "1e9"],
    ["a leading plus sign", `+${ts}`],
    ["a decimal", `${ts}.5`],
  ])("rejects a %s timestamp even with an unbounded tolerance", (_label, timestamp) => {
    expect(
      verifyHookSignature({
        ...ok,
        timestamp,
        signature: signHookBody(secret, timestamp, raw),
        toleranceSec: Number.MAX_SAFE_INTEGER,
      }),
    ).toBe(false);
  });
  it("rejects an empty secret rather than trusting an unsigned request", () => {
    expect(verifyHookSignature({ ...ok, secret: "" })).toBe(false);
  });
});
