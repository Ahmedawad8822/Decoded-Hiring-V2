// ============================================================================
// SQLITE ERROR CLASSIFICATION (DB-layer primitive, deliberately narrow)
// ----------------------------------------------------------------------------
// Single small helper — NOT a generic error utility. It recognizes exactly
// one condition: SQLite's UNIQUE-constraint violation, the authoritative
// concurrency backstop enforced by the DB. Domains that rely on a unique
// index (enrollments, course/lesson slugs) use it to decide whether a failed
// insert is a lost uniqueness race. Everything else must propagate.
// ============================================================================

/**
 * True only for SQLite's UNIQUE-constraint violation.
 * Matches the error surfaced by both raw SQLite ("UNIQUE constraint failed:
 * enrollments.user_id, enrollments.course_id") and D1 wire formats
 * ("constraint failed: UNIQUE (enrollments.user_id, ...)" /
 * code SQLITE_CONSTRAINT). Drizzle wraps driver errors in DrizzleQueryError
 * with the original in `cause`, so the chain is unwrapped. Anything not
 * clearly a uniqueness violation returns false so unexpected errors
 * propagate to the caller.
 */
export function isUniqueConstraintError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth += 1) {
    if (matchesUniqueConstraint(current)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

function matchesUniqueConstraint(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { message?: unknown; code?: unknown };
  const code = typeof candidate.code === "string" ? candidate.code.toUpperCase() : "";
  if (code.includes("CONSTRAINT")) {
    // SQLITE_CONSTRAINT / SQLITE_CONSTRAINT_UNIQUE — D1 reports this code.
    return true;
  }
  const message = typeof candidate.message === "string" ? candidate.message.toLowerCase() : "";
  if (!message) return false;
  return (
    message.includes("unique constraint failed") ||
    (message.includes("constraint failed") && message.includes("unique"))
  );
}
