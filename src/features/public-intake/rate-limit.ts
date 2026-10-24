import { eq, inArray, lt, sql } from "drizzle-orm";

import { getDb, publicRateLimits } from "@/lib/db";

const MINUTE_MS = 60_000;

/**
 * Pruning retention. A fixed-window row whose window started longer ago than
 * this is dead: the next consume for that scope sees `windowStart + windowMs
 * <= now` and starts a fresh window exactly as if the row were absent, and a
 * rejection (the only path that reads windowStart back) needs an active window.
 * This is safe as long as every windowMs passed to consumeFixedWindowMs is
 * <= RATE_LIMIT_RETENTION_MS. The largest windows in use are the public intake
 * clamp (60 minutes, consumePublicFixedWindowLimit) and Better Auth (60 s,
 * src/lib/auth/rate-limit.ts), so 24 hours leaves a 24x margin.
 * If a longer window is ever introduced, raise this constant first.
 */
export const RATE_LIMIT_RETENTION_MS = 24 * 60 * MINUTE_MS;

/** Upper bound on rows deleted by one pruning call (bounded D1 write work). */
export const RATE_LIMIT_PRUNE_BATCH = 500;

/** Chance that a consume call also runs one bounded pruning pass. */
export const RATE_LIMIT_PRUNE_PROBABILITY = 0.01;

function clampInteger(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function randomUnitInterval(): number {
  const buffer = new Uint32Array(1);
  crypto.getRandomValues(buffer);
  return buffer[0] / 2 ** 32;
}

// TEST-ONLY seam: lets the regression suite force (or suppress) the
// opportunistic pruning pass deterministically. Production never sets it.
let pruneSampler: () => number = randomUnitInterval;

export function setRateLimitPruneSamplerForTest(
  sampler: (() => number) | null,
): void {
  pruneSampler = sampler ?? randomUnitInterval;
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
  const result = await consumeFixedWindowDecision(params);
  if (pruneSampler() < RATE_LIMIT_PRUNE_PROBABILITY) {
    await pruneAfterConsume(params.now);
  }
  return result;
}

/**
 * Best-effort opportunistic pruning. Awaited so it is deterministic under
 * test, but a failure is logged and never reaches the admit/deny result.
 */
async function pruneAfterConsume(now: Date): Promise<void> {
  try {
    await pruneExpiredRateLimits(now);
  } catch (error) {
    console.error(
      "[rate-limit] expired-row pruning failed; decision unaffected:",
      (error as Error)?.message ?? String(error),
    );
  }
}

/**
 * Deletes up to `limit` fixed-window rows whose window started more than
 * `retentionMs` before `now`. Each call is one statement touching at most
 * `limit` rows, so the write cost per call is bounded. Expired rows that
 * exceed one batch are removed by later calls. Returns the rows deleted.
 *
 * Uses the window_start index (migration 0019), so the subquery is an ordered
 * range scan. The DELETE is keyed by scope_key (the primary key) through
 * IN (subquery), because SQLite's DELETE ... LIMIT needs a compile flag that
 * D1 does not enable.
 */
export async function pruneExpiredRateLimits(
  now: Date,
  opts?: { limit?: number; retentionMs?: number },
): Promise<number> {
  const limit = clampInteger(opts?.limit ?? RATE_LIMIT_PRUNE_BATCH, 1, 1000);
  const retentionMs = Math.max(1, Math.trunc(opts?.retentionMs ?? RATE_LIMIT_RETENTION_MS));
  const cutoffMs = now.getTime() - retentionMs;
  const db = await getDb();

  const expired = db
    .select({ scopeKey: publicRateLimits.scopeKey })
    .from(publicRateLimits)
    .where(lt(publicRateLimits.windowStart, cutoffMs))
    .orderBy(publicRateLimits.windowStart)
    .limit(limit);

  const result = await db
    .delete(publicRateLimits)
    .where(inArray(publicRateLimits.scopeKey, expired))
    .run();
  return result.meta.changes ?? 0;
}

async function consumeFixedWindowDecision(params: {
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
