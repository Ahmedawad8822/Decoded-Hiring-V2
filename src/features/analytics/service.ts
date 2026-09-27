import { z } from "zod";

import { getD1Database } from "@/lib/cloudflare/bindings";
import {
  BUSINESS_EVENT_NAMES,
  type BusinessEventCounts,
  type BusinessEventInput,
  type BusinessEventName,
  type BusinessEventSummary,
} from "./types";

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
  const d1 = await getD1Database();
  await d1
    .prepare(
      `INSERT OR IGNORE INTO business_events
       (id, dedupe_key, event_name, subject_type, subject_id, offer_id,
        booking_type_id, booking_id, order_id, route, surface, metadata,
        occurred_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      eventId(),
      parsed.dedupeKey,
      parsed.eventName,
      parsed.subjectType ?? null,
      parsed.subjectId ?? null,
      parsed.offerId ?? null,
      parsed.bookingTypeId ?? null,
      parsed.bookingId ?? null,
      parsed.orderId ?? null,
      parsed.route ?? null,
      parsed.surface ?? null,
      safeMetadata(parsed.metadata),
      unixSeconds(occurredAt),
      unixSeconds(new Date()),
    )
    .run();
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

async function reconcileBookingEvents(): Promise<void> {
  const d1 = await getD1Database();

  await d1
    .prepare(
      `INSERT OR IGNORE INTO business_events
       (id, dedupe_key, event_name, subject_type, subject_id,
        booking_type_id, booking_id, metadata, occurred_at, created_at)
       SELECT
         'bev_recon_' || h.id,
         'booking-history:' || h.id || ':requested',
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
       WHERE h.action = 'REQUESTED'`,
    )
    .run();

  await d1
    .prepare(
      `INSERT OR IGNORE INTO business_events
       (id, dedupe_key, event_name, subject_type, subject_id,
        booking_type_id, booking_id, metadata, occurred_at, created_at)
       SELECT
         'bev_recon_' || h.id || '_approved',
         'booking-history:' || h.id || ':approved',
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
       WHERE h.action = 'APPROVED'`,
    )
    .run();

  await d1
    .prepare(
      `INSERT OR IGNORE INTO business_events
       (id, dedupe_key, event_name, subject_type, subject_id,
        booking_type_id, booking_id, metadata, occurred_at, created_at)
       SELECT
         'bev_recon_' || h.id || '_confirmed',
         'booking-history:' || h.id || ':confirmed',
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
         AND h.action IN ('AUTO_CONFIRMED','APPROVED','CONFIRMED')`,
    )
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
         WHERE h.action = ?`,
      )
      .bind(
        `_${mapping[1]}`,
        `:${mapping[1]}`,
        mapping[1],
        mapping[0],
      )
      .run();
  }
}

async function reconcileOrderEvents(): Promise<void> {
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
         AND h.to_status = 'PENDING'`,
    )
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
       WHERE h.to_status = 'PAID'`,
    )
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
       WHERE h.to_status = 'FAILED'`,
    )
    .run();
}

export async function reconcileDurableBusinessEvents(): Promise<void> {
  await reconcileBookingEvents();
  await reconcileOrderEvents();
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
  await reconcileDurableBusinessEvents();
  const now = params?.now ?? new Date();
  const windowDays = Math.max(1, Math.min(params?.windowDays ?? 30, 365));
  const windowStart = new Date(
    now.getTime() - windowDays * 24 * 60 * 60 * 1000,
  );
  const d1 = await getD1Database();
  const result = await d1
    .prepare(
      `SELECT event_name AS eventName, COUNT(*) AS total,
              MAX(occurred_at) AS lastOccurredAt
       FROM business_events
       WHERE occurred_at >= ?
       GROUP BY event_name`,
    )
    .bind(unixSeconds(windowStart))
    .all<{
      eventName: BusinessEventName;
      total: number;
      lastOccurredAt: number | null;
    }>();

  const counts = emptyCounts();
  let total = 0;
  let lastEventSeconds: number | null = null;
  for (const row of result.results ?? []) {
    if (!BUSINESS_EVENT_NAMES.includes(row.eventName)) continue;
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
  const d1 = await getD1Database();
  const row = await d1
    .prepare(
      `SELECT COUNT(*) AS total FROM business_events WHERE event_name = ?`,
    )
    .bind(eventName)
    .first<{ total: number }>();
  return Number(row?.total ?? 0);
}
