import { describe, it, expect } from "vitest";
import { todayNote } from "../src/today.js";

describe("todayNote", () => {
  it("states the given date in UTC", () => {
    expect(todayNote(new Date("2026-09-05T23:41:00Z"))).toContain("2026-09-05");
  });

  it("uses the UTC day, not the local one, either side of midnight", () => {
    // 00:30 UTC is still the previous day in every negative offset; the note must not
    // drift by a day depending on where the machine runs.
    expect(todayNote(new Date("2026-09-05T00:30:00Z"))).toContain("2026-09-05");
    expect(todayNote(new Date("2026-09-05T23:30:00Z"))).toContain("2026-09-05");
  });

  it("forbids re-anchoring to whatever dates the data contains", () => {
    // The production failure recovered by silently re-anchoring. That is the behaviour
    // that turns a wrong date into a confident answer, so the note has to rule it out.
    const note = todayNote(new Date("2026-09-05T00:00:00Z"));
    expect(note).toMatch(/re-anchor/i);
    expect(note).toMatch(/report that it was empty|returns no data/i);
  });

  it("defaults to now when no date is given", () => {
    expect(todayNote()).toContain(new Date().toISOString().slice(0, 10));
  });
});
