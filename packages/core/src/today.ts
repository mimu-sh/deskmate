import { defineDynamic, defineInstructions } from "eve/instructions";

/**
 * The current-date note pinned into every turn.
 *
 * Without it a deskmate resolves relative windows against whatever "today" the model
 * absorbed in training. In production that was 2025-07-15 while the real date was
 * 2026-09-05, so "yesterday" resolved fourteen months out and the analyst reported the
 * live data as future-dated, blaming the ingestion pipeline for correct events.
 *
 * That run recovered only because the wrong window returned zero rows, which was
 * obviously wrong. A window that returned SOME rows would have been answered
 * confidently and silently wrong, so the note also forbids the re-anchoring that
 * rescued it: a resolved window with no data is a fact to report, not a cue to go
 * hunting for dates that do have data.
 *
 * The full timestamp is deliberate, not just the calendar date. Job windows are
 * hour-based (`window: "24h"`), and at any time other than midnight a bare date leaves
 * many different 24-hour intervals to choose from.
 */
export function todayNote(now: Date = new Date()): string {
  const iso = now.toISOString();
  return (
    `[today] The current UTC time is ${iso} (date ${iso.slice(0, 10)}). Resolve every ` +
    `relative window, such as "yesterday", "last 24h" or "last 7 days", against this ` +
    `timestamp and not against any date you remember. State the absolute start and end ` +
    `you resolved when you report on a window. If the resolved window returns no data, ` +
    `report that it was empty. Do not re-anchor to whatever dates happen to appear in ` +
    `the data and present the result as the window asked for.`
  );
}

/**
 * A per-turn instructions entry carrying {@link todayNote}.
 *
 * Resolved at `turn.started` so a long-lived session and a warm machine both get the
 * real time rather than whenever the module was first loaded. `deskmate sync` emits
 * this for the agent root AND for every subagent, because a delegated deskmate is its
 * own agent root: the front desk is told it "cannot see this conversation's history",
 * so anything injected only at the root never reaches the deskmate doing the work.
 */
export function createTodayInstructions() {
  return defineDynamic({
    events: {
      "turn.started": async () => defineInstructions({ markdown: todayNote() }),
    },
  });
}
