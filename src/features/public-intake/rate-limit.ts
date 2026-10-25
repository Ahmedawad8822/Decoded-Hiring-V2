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
 * Per-client-IP budgets for public intake, checked BEFORE the shared
 * (global / per-kind / per-booking-type) counters so one abusive IP exhausts
 * only its own bucket and never spends the budget real visitors share.
 * Keyed `ip:<endpoint>:<hash>`; raw IPs are never stored.
 */
export const PUBLIC_IP_LIMITS = {
  /** Lead / contact enquiries (email limit is 5 per 15 min). */
  lead: { endpoint: "lead", windowMinutes: 15, maxCount: 10 },
  /** Public booking attempts (email limit is 3 per 15 min). */
  booking: { endpoint: "booking", windowMinutes: 15, maxCount: 8 },
  /** Public analytics events (global budget is 50 per 15 min). */
  analytics: { endpoint: "analytics", windowMinutes: 15, maxCount: 20 },
} as const;

export const UNKNOWN_CLIENT_IP = "unknown";

/** CF-Connecting-IP, else first X-Forwarded-For entry, else "unknown". */
export function resolveClientIp(headers: Pick<Headers, "get">): string {
  const cf = headers.get("cf-connecting-ip")?.trim();
  if (cf) return cf.slice(0, 64);
  const xff = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (xff) return xff.slice(0, 64);
  return UNKNOWN_CLIENT_IP;
}

/** SHA-256(salt + IP) hex, salted with BETTER_AUTH_SECRET. Fails closed. */
export async function hashClientIp(ip: string): Promise<string> {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) {
    throw new Error(
      "Missing BETTER_AUTH_SECRET environment variable; cannot salt client IP hashes.",
    );
  }
  const bytes = new TextEncoder().encode(`dh-intake-ip-v1:${secret}:${ip}`);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    Uint8Array.from(bytes).buffer,
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Salted client-IP hash for the current request, or null when there is no
 * request context (plain tsx tests, scripts), in which case the per-IP check
 * is skipped by callers.
 */
export async function getRequestClientIpHash(): Promise<string | null> {
  let ip: string;
  try {
    const { headers } = await import("next/headers");
    ip = resolveClientIp(await headers());
  } catch {
    return null;
  }
  return hashClientIp(ip);
}

/** Consumes one slot from a client's per-endpoint bucket. */
export async function consumePublicIpLimit(params: {
  ipHash: string;
  limit: { endpoint: string; windowMinutes: number; maxCount: number };
  now: Date;
}): Promise<boolean> {
  return consumePublicFixedWindowLimit({
    scopeKey: `ip:${params.limit.endpoint}:${params.ipHash}`,
    now: params.now,
    windowMinutes: params.limit.windowMinutes,
    maxCount: params.limit.maxCount,
  });
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
  // Pruning assumes no window outlives the retention; fail loudly instead of
  // silently resetting a longer window's counter early.
  if (params.windowMs > RATE_LIMIT_RETENTION_MS) {
    throw new Error(
      `Rate-limit window ${params.windowMs}ms exceeds RATE_LIMIT_RETENTION_MS (${RATE_LIMIT_RETENTION_MS}ms); raise the retention first.`
    );
  }
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
