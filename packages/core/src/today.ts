/**
 * The current-date note injected into every turn.
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
 */
export function todayNote(now: Date = new Date()): string {
  const date = now.toISOString().slice(0, 10);
  return (
    `[today] The current date is ${date} (UTC). Resolve every relative window, such as ` +
    `"yesterday" or "last 7 days", against this date and not against any date you remember. ` +
    `If the resolved window returns no data, report that it was empty. Do not re-anchor to ` +
    `whatever dates happen to appear in the data and present the result as the window asked for.`
  );
}
