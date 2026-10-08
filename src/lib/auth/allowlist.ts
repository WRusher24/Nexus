/**
 * Email allowlist for invite-only authentication (M8, Part 2.1).
 *
 * Source: `ALLOWED_EMAILS`, a comma-separated list of email addresses.
 * Comparison is case-insensitive and trims whitespace.
 *
 * Fail-closed rule: an empty allowlist means NO ONE can sign in. This
 * prevents accidental account creation in production if the env var is
 * missing.
 *
 * Development convenience: when `NODE_ENV !== 'production'` AND the allowlist
 * is empty, any email is allowed so local dev works without env setup.
 */

/**
 * Parse `ALLOWED_EMAILS` into a normalised (lower-cased, trimmed) list.
 * Exposed for logging / debugging.
 */
export function getAllowlist(): string[] {
  const raw = process.env.ALLOWED_EMAILS ?? '';
  return raw
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

/** True when `email` may sign in under the current environment. */
export function isEmailAllowed(email: string): boolean {
  const normalized = email.trim().toLowerCase();
  if (normalized.length === 0) return false;

  const allowlist = getAllowlist();
  if (allowlist.length === 0) {
    // Fail closed in production; allow any address in dev/test.
    return process.env.NODE_ENV !== 'production';
  }

  return allowlist.includes(normalized);
}
