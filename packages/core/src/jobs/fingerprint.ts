/**
 * Deduplication for recurring jobs. The issue tracker IS the ledger: every issue a
 * job files carries the JOB_LABEL and a fingerprint marker, so the next run can find
 * what it already reported without any storage of its own.
 */

/** The label every job-filed issue carries, so a job can scope its search. */
export const JOB_LABEL = "deskmate-job";

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MARKER_RE = /<!--\s*deskmate-fingerprint:\s*([a-z0-9]+(?:-[a-z0-9]+)*)\s*-->/;

/** The marker to embed in an issue body. Throws on a slug that could not be found again. */
export function fingerprintMarker(slug: string): string {
  if (!SLUG_RE.test(slug)) {
    throw new Error(`fingerprint slug "${slug}" must be kebab-case (lowercase words joined by single dashes)`);
  }
  return `<!-- deskmate-fingerprint: ${slug} -->`;
}

/** The slug carried by an issue body, or null when it carries none. */
export function parseFingerprint(body: string): string | null {
  return body.match(MARKER_RE)?.[1] ?? null;
}
