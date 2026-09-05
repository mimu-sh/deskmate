import { describe, it, expect, vi, afterEach } from "vitest";
import { todayNote } from "../src/today.js";

// Time is frozen in every case. Comparing todayNote()'s internal `new Date()` against a
// second `new Date()` in the assertion would be flaky across the UTC midnight boundary,
// which is a poor look for the fix that exists to get dates right.
afterEach(() => vi.useRealTimers());

describe("todayNote", () => {
  it("states the given instant in UTC", () => {
    const note = todayNote(new Date("2026-09-05T23:41:00Z"));
    expect(note).toContain("2026-09-05T23:41:00.000Z");
    expect(note).toContain("date 2026-09-05");
  });

  it("uses the UTC day either side of midnight, never the local one", () => {
    expect(todayNote(new Date("2026-09-05T00:30:00Z"))).toContain("date 2026-09-05");
    expect(todayNote(new Date("2026-09-05T23:30:00Z"))).toContain("date 2026-09-05");
  });

  it("carries a time of day, not only a calendar date", () => {
    // Job windows are hour-based ("last 24h"). A bare date leaves 24 different
    // intervals to choose from at any hour other than midnight.
    const morning = todayNote(new Date("2026-09-05T06:00:00Z"));
    const evening = todayNote(new Date("2026-09-05T18:00:00Z"));
    expect(morning).not.toEqual(evening);
  });

  it("forbids re-anchoring to whatever dates the data contains", () => {
    // Re-anchoring is what turned a wrong date into a confident answer in production.
    const note = todayNote(new Date("2026-09-05T00:00:00Z"));
    expect(note).toMatch(/re-anchor/i);
    expect(note).toMatch(/report that it was empty/i);
  });

  it("defaults to now", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-12-25T09:00:00Z"));
    expect(todayNote()).toContain("2026-12-25T09:00:00.000Z");
  });
});
