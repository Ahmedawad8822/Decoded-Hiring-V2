import { eq, sql } from "drizzle-orm";

import { getDb, publicRateLimits } from "@/lib/db";

const MINUTE_MS = 60_000;

function clampInteger(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

export async function anonymousRateLimitFingerprint(
  value: string,
): Promise<string> {
  const bytes = new TextEncoder().encode(value.trim().toLowerCase());
  const digest = await crypto.subtle.digest(
    "SHA-256",
    Uint8Array.from(bytes).buffer,
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Atomically consumes one slot from a scope-anchored fixed-window public
 * mutation budget.
 *
 * The first admitted request starts the window. The INSERT/ON CONFLICT UPDATE
 * is one SQLite write statement. Under concurrent requests D1 serializes the
 * row update, and the WHERE predicate prevents count from crossing maxCount.
 * A rejected consume returns no row.
 */
export async function consumePublicFixedWindowLimit(params: {
  scopeKey: string;
  now: Date;
  windowMinutes: number;
  maxCount: number;
}): Promise<boolean> {
  const windowMinutes = clampInteger(params.windowMinutes, 1, 60);
  const maxCount = clampInteger(params.maxCount, 1, 500);
  const result = await consumeFixedWindowMs({
    scopeKey: params.scopeKey,
    now: params.now,
    windowMs: windowMinutes * MINUTE_MS,
    maxCount,
  });
  return result.allowed;
}

/**
 * Same atomic primitive with a millisecond window and no minute clamping.
 * Shared with the Better Auth rate limiter (src/lib/auth/rate-limit.ts).
 * On rejection `retryAfterMs` is read back from the stored window start
 * (informational only; the admit/deny decision is the atomic write).
 */
export async function consumeFixedWindowMs(params: {
  scopeKey: string;
  now: Date;
  windowMs: number;
  maxCount: number;
}): Promise<{ allowed: boolean; retryAfterMs: number }> {
  const windowMs = Math.max(1, Math.trunc(params.windowMs));
  const maxCount = Math.max(1, Math.trunc(params.maxCount));
  const nowMs = params.now.getTime();
  // Scope-anchored fixed window: the first admitted request owns the start.
  // This avoids the synchronized-boundary weakness of wall-clock windows
  // (e.g. max requests at 14:59:59 plus max again at 15:00:00).
  const windowStart = nowMs;
  const db = await getDb();

  const admitted = await db
    .insert(publicRateLimits)
    .values({
      scopeKey: params.scopeKey,
      windowStart,
      count: 1,
      updatedAt: params.now,
    })
    .onConflictDoUpdate({
      target: publicRateLimits.scopeKey,
      set: {
        windowStart: sql<number>`CASE
          WHEN ${publicRateLimits.windowStart} + ${windowMs} <= ${nowMs}
          THEN ${nowMs}
          ELSE ${publicRateLimits.windowStart}
        END`,
        count: sql<number>`CASE
          WHEN ${publicRateLimits.windowStart} + ${windowMs} <= ${nowMs}
          THEN 1
          ELSE ${publicRateLimits.count} + 1
        END`,
        updatedAt: params.now,
      },
      where: sql`
        ${publicRateLimits.windowStart} + ${windowMs} <= ${nowMs}
        OR ${publicRateLimits.count} < ${maxCount}
      `,
    })
    .returning({
      count: publicRateLimits.count,
      windowStart: publicRateLimits.windowStart,
    })
    .get();

  if (admitted) return { allowed: true, retryAfterMs: 0 };

  const current = await db
    .select({ windowStart: publicRateLimits.windowStart })
    .from(publicRateLimits)
    .where(eq(publicRateLimits.scopeKey, params.scopeKey))
    .get();
  const retryAfterMs = current
    ? Math.max(0, current.windowStart + windowMs - nowMs)
    : windowMs;
  return { allowed: false, retryAfterMs };
}
