// The identifier rule for deskmate ids, connection names, and role names: a lowercase
// letter followed by lowercase letters, digits, or underscores. These values become
// directory names, import specifiers, AND filesystem path segments the CLI joins onto
// `cwd` (roles/<id>, connections/<name>) — so a value like "../foo" must be rejected
// BEFORE any fs op (cp/rm), or the CLI could touch paths outside the intended dir.
//
// Mirrors the same rule enforced by `defineTeam` in @deskmate/core; kept CLI-local so
// every CLI command (add/remove/mcp-add) shares one source of truth without importing a
// core internal.
export const IDENTIFIER_RE = /^[a-z][a-z0-9_]*$/;

/** True when `id` is a safe snake_case identifier (see IDENTIFIER_RE). */
export function isValidId(id: string): boolean {
  return IDENTIFIER_RE.test(id);
}

// ── Connection names: the eve ∩ deskmate intersection ───────────────────────────
// Connection names are stricter than deskmate ids/roles because two DIFFERENT rules
// apply to them and only their intersection is safe:
//   • deskmate (this CLI + core's defineTeam) requires snake_case, IDENTIFIER_RE above:
//       /^[a-z][a-z0-9_]*$/   — underscores OK, dashes rejected.
//   • eve's `eve build` derives a connection's name from its filename and requires
//     KEBAB-case (eve's CONNECTION_SLUG_PATTERN):
//       /^[a-z][a-z0-9-]{0,63}$/  — dashes OK, underscores rejected.
// No MULTI-WORD name satisfies both (snake wants `_`, kebab wants `-`), so the only
// portable connection names are single lowercase words. eve also caps the name at 64
// chars ({0,63} after the leading letter), so we match that bound too — otherwise a
// >64-char single word would pass this guard yet still die at `eve build`, the exact
// deploy-time failure this guard exists to prevent. We enforce the full intersection at
// `mcp-add`/`sync` time — with a message that names the conflict — so a bad name fails
// immediately instead of silently at `eve build` (deploy). See connectionNameError.
//
// FOLLOW-UP (full reconciliation, out of this CLI-only change): teach both validators
// to accept eve-compatible kebab-case (a connection-specific rule, NOT the shared
// IDENTIFIER_RE, which also guards ids/roles), quote the connection key in the
// generated `deskmate.config.ts` entry (config-file.ts `renderEntry`), and derive any
// JS-identifier positions (camelCase) safely. That spans @deskmate/core's defineTeam
// too, so it is deliberately deferred.
export const CONNECTION_NAME_RE = /^[a-z][a-z0-9]{0,63}$/;

/**
 * True when `name` is a legal connection name under BOTH deskmate's snake_case rule and
 * eve's kebab-case connection-filename rule — i.e. a single lowercase word of at most 64
 * characters (eve caps connection names at 64).
 */
export function isValidConnectionName(name: string): boolean {
  return CONNECTION_NAME_RE.test(name);
}

/** Shared, actionable error text for an illegal connection name (used by mcp-add and sync). */
export function connectionNameError(name: string): string {
  return (
    `connection name "${name}" must be a single lowercase word (a letter, then letters/digits — ` +
    `no dashes or underscores). deskmate uses snake_case (underscores) but eve's \`eve build\` requires ` +
    `kebab-case connection filenames (dashes), so a multi-word name can't satisfy both and would fail ` +
    `at deploy. Use e.g. "githubwrite" instead of "github_write" or "github-write".`
  );
}
