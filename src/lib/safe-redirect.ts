const PROBE_ORIGIN = "http://same-origin.invalid";

/**
 * Same-origin path for a post-auth `?redirect=` value, or the fallback.
 *
 * A bare `startsWith("/") && !startsWith("//")` check is bypassable:
 * browsers normalise `\` to `/` and strip tab/newline characters, so
 * `/\evil.com` and `/\t/evil.com` both navigate off-site. Backslashes and
 * control characters are rejected outright, and the result must still
 * resolve to the same origin as a path-only URL.
 */
export function safeRedirectPath(raw: string | null | undefined, fallback = "/learn"): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return fallback;
  if (raw.includes("\\") || /[\u0000-\u001f\u007f]/.test(raw)) return fallback;
  try {
    const resolved = new URL(raw, PROBE_ORIGIN);
    if (resolved.origin !== PROBE_ORIGIN) return fallback;
    return `${resolved.pathname}${resolved.search}${resolved.hash}`;
  } catch {
    return fallback;
  }
}
