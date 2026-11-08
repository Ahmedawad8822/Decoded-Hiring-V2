import { count, eq, gte, inArray, lt, max } from "drizzle-orm";
import { z } from "zod";

import { getD1Database } from "@/lib/cloudflare/bindings";
import { businessEvents, getDb } from "@/lib/db";
import {
  BUSINESS_EVENT_NAMES,
  type BusinessEventCounts,
  type BusinessEventInput,
  type BusinessEventName,
  type BusinessEventSummary,
} from "./types";

/**
 * Retention for the business-event ledger, measured on `occurred_at`.
 * POLICY DEFAULT: review retention and consent for each deployment (see
 * Docs/ANALYTICS-EVENTS.md): 400 days keeps a full year of year-over-year comparison plus a
 * margin. Must stay >= the 365-day maximum summary window. Change it here
 * once the retention policy is decided.
 */
export const BUSINESS_EVENT_RETENTION_DAYS = 400;

/** Upper bound on rows deleted by one pruning call (bounded D1 write work). */
export const BUSINESS_EVENT_PRUNE_BATCH = 500;

/** Chance that a successful event write also runs one bounded pruning pass. */
export const BUSINESS_EVENT_PRUNE_PROBABILITY = 0.01;

const DAY_MS = 24 * 60 * 60 * 1000;

function randomUnitInterval(): number {
  const buffer = new Uint32Array(1);
  crypto.getRandomValues(buffer);
  return buffer[0] / 2 ** 32;
}

// TEST-ONLY seam: forces (or suppresses) the opportunistic pruning pass.
let pruneSampler: () => number = randomUnitInterval;

export function setBusinessEventPruneSamplerForTest(
  sampler: (() => number) | null,
): void {
  pruneSampler = sampler ?? randomUnitInterval;
}

const eventNameSchema = z.enum(BUSINESS_EVENT_NAMES);
const metadataValueSchema = z.union([
  z.string().max(80),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
const inputSchema = z.object({
  dedupeKey: z.string().trim().min(1).max(240),
  eventName: eventNameSchema,
  subjectType: z
    .enum(["OFFER", "BOOKING_TYPE", "BOOKING", "ORDER", "PUBLIC"])
    .optional(),
  subjectId: z.string().trim().max(180).nullable().optional(),
  offerId: z.string().trim().max(180).nullable().optional(),
  bookingTypeId: z.string().trim().max(180).nullable().optional(),
  bookingId: z.string().trim().max(180).nullable().optional(),
  orderId: z.string().trim().max(180).nullable().optional(),
  route: z.string().trim().max(180).nullable().optional(),
  surface: z.string().trim().max(120).nullable().optional(),
  metadata: z.record(z.string().max(80), metadataValueSchema).optional(),
  occurredAt: z.date().optional(),
});

const FORBIDDEN_METADATA_KEY =
  /(email|name|phone|note|answer|message|description|reason|candidate|company|title|text|content)/i;

function safeMetadata(
  metadata: Record<string, string | number | boolean | null> | undefined,
): string {
  if (!metadata) return "{}";
  for (const key of Object.keys(metadata)) {
    if (FORBIDDEN_METADATA_KEY.test(key)) {
      throw new Error(
        `Sensitive/free-text analytics metadata key is not allowed: ${key}`,
      );
    }
  }
  return JSON.stringify(metadata);
}

function eventId(): string {
  return `bev_${crypto.randomUUID().slice(0, 18)}`;
}

function unixSeconds(value: Date): number {
  return Math.floor(value.getTime() / 1000);
}

export async function recordBusinessEvent(
  input: BusinessEventInput,
): Promise<void> {
  const parsed = inputSchema.parse(input);
  const occurredAt = parsed.occurredAt ?? new Date();
  const db = await getDb();
  await db
    .insert(businessEvents)
    .values({
      id: eventId(),
      dedupeKey: parsed.dedupeKey,
      eventName: parsed.eventName,
      subjectType: parsed.subjectType ?? null,
      subjectId: parsed.subjectId ?? null,
      offerId: parsed.offerId ?? null,
      bookingTypeId: parsed.bookingTypeId ?? null,
      bookingId: parsed.bookingId ?? null,
      orderId: parsed.orderId ?? null,
      route: parsed.route ?? null,
      surface: parsed.surface ?? null,
      metadata: safeMetadata(parsed.metadata),
      occurredAt: unixSeconds(occurredAt),
      createdAt: unixSeconds(new Date()),
    })
    .onConflictDoNothing({ target: businessEvents.dedupeKey })
    .run();

  if (pruneSampler() < BUSINESS_EVENT_PRUNE_PROBABILITY) {
    await pruneAfterWrite(new Date());
  }
}

/** Best-effort pruning; a failure is logged and never reaches the writer. */
async function pruneAfterWrite(now: Date): Promise<void> {
  try {
    await pruneExpiredBusinessEvents(now);
  } catch (error) {
    console.error(
      "[analytics] business-event pruning failed; write unaffected:",
      (error as Error)?.message ?? String(error),
    );
  }
}

/**
 * Deletes up to `limit` events whose `occurred_at` is older than the
 * retention. One statement touching at most `limit` rows, so the write cost
 * per call is bounded; a bigger backlog drains over later calls. Uses the
 * occurred_at index (migration 0023). The DELETE is keyed by primary key
 * through IN (subquery) because D1 does not enable DELETE ... LIMIT.
 * Returns the rows deleted.
 */
export async function pruneExpiredBusinessEvents(
  now: Date,
  opts?: { limit?: number; retentionDays?: number },
): Promise<number> {
  const limit = Math.max(
    1,
    Math.min(1000, Math.trunc(opts?.limit ?? BUSINESS_EVENT_PRUNE_BATCH)),
  );
  const retentionDays = Math.max(
    1,
    Math.trunc(opts?.retentionDays ?? BUSINESS_EVENT_RETENTION_DAYS),
  );
  const cutoffSeconds = unixSeconds(
    new Date(now.getTime() - retentionDays * DAY_MS),
  );
  const db = await getDb();
  const expired = db
    .select({ id: businessEvents.id })
    .from(businessEvents)
    .where(lt(businessEvents.occurredAt, cutoffSeconds))
    .orderBy(businessEvents.occurredAt)
    .limit(limit);
  const result = await db
    .delete(businessEvents)
    .where(inArray(businessEvents.id, expired))
    .run();
  return result.meta.changes ?? 0;
}

export async function recordBusinessEventBestEffort(
  input: BusinessEventInput,
): Promise<boolean> {
  try {
    await recordBusinessEvent(input);
    return true;
  } catch {
    return false;
  }
}

async function reconcileBookingEvents(sinceSeconds: number): Promise<void> {
  const d1 = await getD1Database();

  await d1
    .prepare(
      `INSERT OR IGNORE INTO business_events
       (id, dedupe_key, event_name, subject_type, subject_id,
        booking_type_id, booking_id, metadata, occurred_at, created_at)
       SELECT
         'bev_recon_' || h.id,
         'booking-history:' || h.id || ':booking_requested',
         'booking_requested',
         'BOOKING',
         h.booking_id,
         b.booking_type_id,
         h.booking_id,
         '{}',
         h.created_at,
         CAST(strftime('%s','now') AS INTEGER)
       FROM booking_history h
       JOIN bookings b ON b.id = h.booking_id
       WHERE h.action = 'REQUESTED'
         AND h.created_at >= ?
`,
    )
    .bind(sinceSeconds)
    .run();

  await d1
    .prepare(
      `INSERT OR IGNORE INTO business_events
       (id, dedupe_key, event_name, subject_type, subject_id,
        booking_type_id, booking_id, metadata, occurred_at, created_at)
       SELECT
         'bev_recon_' || h.id || '_approved',
         'booking-history:' || h.id || ':booking_approved',
         'booking_approved',
         'BOOKING',
         h.booking_id,
         b.booking_type_id,
         h.booking_id,
         '{}',
         h.created_at,
         CAST(strftime('%s','now') AS INTEGER)
       FROM booking_history h
       JOIN bookings b ON b.id = h.booking_id
       WHERE h.action = 'APPROVED'
         AND h.created_at >= ?
`,
    )
    .bind(sinceSeconds)
    .run();

  await d1
    .prepare(
      `INSERT OR IGNORE INTO business_events
       (id, dedupe_key, event_name, subject_type, subject_id,
        booking_type_id, booking_id, metadata, occurred_at, created_at)
       SELECT
         'bev_recon_' || h.id || '_confirmed',
         'booking-history:' || h.id || ':booking_confirmed',
         'booking_confirmed',
         'BOOKING',
         h.booking_id,
         b.booking_type_id,
         h.booking_id,
         '{}',
         h.created_at,
         CAST(strftime('%s','now') AS INTEGER)
       FROM booking_history h
       JOIN bookings b ON b.id = h.booking_id
       WHERE h.to_status = 'CONFIRMED'
         AND h.action IN ('AUTO_CONFIRMED','APPROVED','CONFIRMED')
         AND h.created_at >= ?
`,
    )
    .bind(sinceSeconds)
    .run();

  for (const mapping of [
    ["DECLINED", "booking_declined"],
    ["CANCELLED", "booking_cancelled"],
    ["RESCHEDULED", "booking_rescheduled"],
  ] as const) {
    await d1
      .prepare(
        `INSERT OR IGNORE INTO business_events
         (id, dedupe_key, event_name, subject_type, subject_id,
          booking_type_id, booking_id, metadata, occurred_at, created_at)
         SELECT
           'bev_recon_' || h.id || ?,
           'booking-history:' || h.id || ?,
           ?,
           'BOOKING',
           h.booking_id,
           b.booking_type_id,
           h.booking_id,
           '{}',
           h.created_at,
           CAST(strftime('%s','now') AS INTEGER)
         FROM booking_history h
         JOIN bookings b ON b.id = h.booking_id
         WHERE h.action = ?
           AND h.created_at >= ?
`,
      )
      .bind(
        `_${mapping[1]}`,
        `:${mapping[1]}`,
        mapping[1],
        mapping[0],
        sinceSeconds,
      )
      .run();
  }
}

async function reconcileOrderEvents(sinceSeconds: number): Promise<void> {
  const d1 = await getD1Database();

  await d1
    .prepare(
      `INSERT OR IGNORE INTO business_events
       (id, dedupe_key, event_name, subject_type, subject_id,
        offer_id, booking_type_id, booking_id, order_id, metadata,
        occurred_at, created_at)
       SELECT
         'bev_recon_' || h.id || '_checkout',
         'order-history:' || h.id || ':checkout_started',
         'checkout_started',
         'ORDER',
         h.order_id,
         o.offer_id,
         o.booking_type_id,
         o.booking_id,
         h.order_id,
         '{}',
         h.created_at,
         CAST(strftime('%s','now') AS INTEGER)
       FROM order_history h
       JOIN orders o ON o.id = h.order_id
       WHERE h.from_status IS NULL
         AND h.to_status = 'PENDING'
         AND h.created_at >= ?
`,
    )
    .bind(sinceSeconds)
    .run();

  await d1
    .prepare(
      `INSERT OR IGNORE INTO business_events
       (id, dedupe_key, event_name, subject_type, subject_id,
        offer_id, booking_type_id, booking_id, order_id, metadata,
        occurred_at, created_at)
       SELECT
         'bev_recon_' || h.id || '_payment_confirmed',
         'order-history:' || h.id || ':payment_confirmed',
         'payment_confirmed',
         'ORDER',
         h.order_id,
         o.offer_id,
         o.booking_type_id,
         o.booking_id,
         h.order_id,
         json_object('source', lower(h.source)),
         h.created_at,
         CAST(strftime('%s','now') AS INTEGER)
       FROM order_history h
       JOIN orders o ON o.id = h.order_id
       WHERE h.to_status = 'PAID'
         AND h.created_at >= ?
`,
    )
    .bind(sinceSeconds)
    .run();

  await d1
    .prepare(
      `INSERT OR IGNORE INTO business_events
       (id, dedupe_key, event_name, subject_type, subject_id,
        offer_id, booking_type_id, booking_id, order_id, metadata,
        occurred_at, created_at)
       SELECT
         'bev_recon_' || h.id || '_payment_failed',
         'order-history:' || h.id || ':payment_failed',
         'payment_failed',
         'ORDER',
         h.order_id,
         o.offer_id,
         o.booking_type_id,
         o.booking_id,
         h.order_id,
         json_object('source', lower(h.source)),
         h.created_at,
         CAST(strftime('%s','now') AS INTEGER)
       FROM order_history h
       JOIN orders o ON o.id = h.order_id
       WHERE h.to_status = 'FAILED'
         AND h.created_at >= ?
`,
    )
    .bind(sinceSeconds)
    .run();
}

/**
 * Re-derives business events from booking_history and order_history with
 * INSERT OR IGNORE on the shared history-based dedupe keys, so it never
 * duplicates a live row. This WRITES: call it only from write paths (when a
 * live event write failed) or the admin action, never from a read.
 * `since` is clamped to the retention horizon so pruned rows are not
 * resurrected; it defaults to that horizon.
 */
export async function reconcileDurableBusinessEvents(params?: {
  since?: Date;
}): Promise<void> {
  const horizonSeconds = unixSeconds(
    new Date(Date.now() - BUSINESS_EVENT_RETENTION_DAYS * DAY_MS),
  );
  const sinceSeconds = Math.max(
    horizonSeconds,
    params?.since ? unixSeconds(params.since) : 0,
  );
  await reconcileBookingEvents(sinceSeconds);
  await reconcileOrderEvents(sinceSeconds);
}

/**
 * Recovery hook for write paths: after a live event write failed, re-derive
 * the recent window from the durable histories. Never throws.
 */
export async function reconcileRecentBusinessEventsBestEffort(
  windowDays = 2,
): Promise<boolean> {
  try {
    await reconcileDurableBusinessEvents({
      since: new Date(Date.now() - windowDays * DAY_MS),
    });
    return true;
  } catch {
    return false;
  }
}

function isBusinessEventName(value: string): value is BusinessEventName {
  return (BUSINESS_EVENT_NAMES as readonly string[]).includes(value);
}

function emptyCounts(): BusinessEventCounts {
  return Object.fromEntries(
    BUSINESS_EVENT_NAMES.map((name) => [name, 0]),
  ) as BusinessEventCounts;
}

export async function getBusinessEventSummary(params?: {
  windowDays?: number;
  now?: Date;
}): Promise<BusinessEventSummary> {
  const now = params?.now ?? new Date();
  const windowDays = Math.max(1, Math.min(params?.windowDays ?? 30, 365));
  const windowStart = new Date(
    now.getTime() - windowDays * 24 * 60 * 60 * 1000,
  );
  // Read-only: reconciliation is an explicit write (see
  // reconcileDurableBusinessEvents), never run here.
  const db = await getDb();
  const rows = await db
    .select({
      eventName: businessEvents.eventName,
      total: count(),
      lastOccurredAt: max(businessEvents.occurredAt),
    })
    .from(businessEvents)
    .where(gte(businessEvents.occurredAt, unixSeconds(windowStart)))
    .groupBy(businessEvents.eventName)
    .all();

  const counts = emptyCounts();
  let total = 0;
  let lastEventSeconds: number | null = null;
  for (const row of rows) {
    if (!isBusinessEventName(row.eventName)) continue;
    const value = Number(row.total ?? 0);
    counts[row.eventName] = value;
    total += value;
    const last = row.lastOccurredAt == null ? null : Number(row.lastOccurredAt);
    if (last != null && (lastEventSeconds == null || last > lastEventSeconds)) {
      lastEventSeconds = last;
    }
  }

  return {
    windowDays,
    windowStart: windowStart.toISOString(),
    generatedAt: now.toISOString(),
    total,
    counts,
    lastEventAt:
      lastEventSeconds == null
        ? null
        : new Date(lastEventSeconds * 1000).toISOString(),
  };
}

export async function countBusinessEvents(
  eventName: BusinessEventName,
): Promise<number> {
  const db = await getDb();
  const row = await db
    .select({ total: count() })
    .from(businessEvents)
    .where(eq(businessEvents.eventName, eventName))
    .get();
  return Number(row?.total ?? 0);
}
