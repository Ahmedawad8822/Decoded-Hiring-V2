import { sql } from "drizzle-orm";

import { getDb, publicRateLimits } from "@/lib/db";

const MINUTE_MS = 60_000;

function clampInteger(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function fixedWindowStart(now: Date, windowMinutes: number): number {
  const windowMs = windowMinutes * MINUTE_MS;
  return Math.floor(now.getTime() / windowMs) * windowMs;
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
 * Atomically consumes one slot from a fixed-window public mutation budget.
 *
 * The INSERT/ON CONFLICT UPDATE is one SQLite write statement. Under
 * concurrent requests D1 serializes the row update, and the WHERE predicate
 * prevents count from crossing maxCount. A rejected consume returns no row.
 */
export async function consumePublicFixedWindowLimit(params: {
  scopeKey: string;
  now: Date;
  windowMinutes: number;
  maxCount: number;
}): Promise<boolean> {
  const windowMinutes = clampInteger(params.windowMinutes, 1, 60);
  const maxCount = clampInteger(params.maxCount, 1, 500);
  const windowStart = fixedWindowStart(params.now, windowMinutes);
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
        windowStart,
        count: sql<number>`CASE
          WHEN ${publicRateLimits.windowStart} = ${windowStart}
          THEN ${publicRateLimits.count} + 1
          ELSE 1
        END`,
        updatedAt: params.now,
      },
      where: sql`
        ${publicRateLimits.windowStart} != ${windowStart}
        OR ${publicRateLimits.count} < ${maxCount}
      `,
    })
    .returning({
      count: publicRateLimits.count,
      windowStart: publicRateLimits.windowStart,
    })
    .get();

  return Boolean(admitted);
}
