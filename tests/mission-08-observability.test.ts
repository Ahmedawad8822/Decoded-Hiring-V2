/**
 * Mission 08.8 — Business-event observability + recovery regressions.
 */

import "./helpers/env";

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { eq } from "drizzle-orm";

import { disposeCloudflareBindings, getD1Database } from "../src/lib/cloudflare/bindings";
import { migrateLocalDb } from "../src/lib/db/migrate";
import { getDb, orchestrationEffects } from "../src/lib/db";
import {
  BUSINESS_EVENT_NAMES,
  PUBLIC_ANALYTICS_BUDGET,
  type BusinessEventName,
} from "@/features/analytics/types";
import {
  countBusinessEvents,
  getBusinessEventSummary,
  reconcileDurableBusinessEvents,
  recordBusinessEvent,
} from "@/features/analytics/service";
import { recordPublicOfferCta } from "@/features/analytics/public-actions";
import { createOffer } from "@/features/offers/service";
import {
  acquireSlotHold,
  createAvailabilityWindow,
  createBookingRequest,
  createBookingType,
  generateAcquisitionKey,
} from "@/features/scheduling";
import { createOrder, __commerceTestOnly } from "@/features/commerce/orders";

if (!__commerceTestOnly) {
  throw new Error("Mission 08.8 requires the commerce test seam.");
}
const commerceTest = __commerceTestOnly;

const NOW = new Date("2026-10-27T12:00:00.000Z");
const SLOT = new Date("2026-10-27T14:00:00.000Z");
const PREFIX = `obs-${Date.now().toString(36)}`;
let seq = 0;

function unique(prefix: string): string {
  return `${PREFIX}-${prefix}-${seq++}`;
}

async function rawEvents(whereSql: string, value: string) {
  const d1 = await getD1Database();
  const result = await d1
    .prepare(
      `SELECT event_name AS eventName, metadata, dedupe_key AS dedupeKey
       FROM business_events
       WHERE ${whereSql} = ?
       ORDER BY occurred_at ASC, event_name ASC`,
    )
    .bind(value)
    .all<{ eventName: BusinessEventName; metadata: string; dedupeKey: string }>();
  return result.results ?? [];
}

async function makeAutoConfirmBooking() {
  const bookingType = await createBookingType({
    slug: unique("booking"),
    title: "Observability Booking",
    description: null,
    durationMinutes: 60,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    minimumNoticeMinutes: 0,
    bookingHorizonDays: 30,
    timezone: "America/New_York",
    confirmationPolicy: "AUTO_CONFIRM",
    accessMode: "FREE",
    meetingMethod: "TO_BE_CONFIRMED",
    attendeeLimit: 1,
  });
  await createAvailabilityWindow({
    bookingTypeId: bookingType.id,
    weekday: 2,
    startMinute: 540,
    endMinute: 1020,
  });
  const acquisitionKey = generateAcquisitionKey();
  const held = await acquireSlotHold({
    bookingTypeId: bookingType.id,
    startAt: SLOT,
    now: NOW,
    ttlMinutes: 30,
    acquisitionKey,
  });
  assert.equal(held.success, true);
  if (!held.success) throw new Error("Expected a slot hold.");

  const booking = await createBookingRequest({
    bookingTypeId: bookingType.id,
    holdId: held.hold.id,
    holdAcquisitionKey: held.acquisitionKey,
    requestKey: crypto.randomUUID(),
    requesterName: "Private Person",
    requesterEmail: `${unique("person")}@example.com`,
    requesterPhone: "+201000000000",
    notes: "Sensitive qualification text that must never enter analytics.",
    now: NOW,
  });
  return { bookingType, booking };
}

async function makeManualOrder() {
  const offer = await createOffer({
    kind: "PRODUCT",
    title: "Observability manual product",
    slug: unique("manual-offer"),
    accessMode: "MANUAL_INVOICE",
    currency: "USD",
    amountMinor: 10000,
    active: true,
  });
  const order = await createOrder({
    offerId: offer.id,
    requestKey: crypto.randomUUID(),
    customerEmail: `${unique("buyer")}@example.com`,
    quantity: 1,
    now: NOW,
  });
  return { offer, order };
}

test.before(async () => {
  await migrateLocalDb();
});

test.after(async () => {
  await disposeCloudflareBindings();
});

test("OBS 08.8: event writes are idempotent under concurrent duplicates", async () => {
  const dedupeKey = unique("duplicate");
  const before = await countBusinessEvents("booking_started");

  await Promise.all(
    Array.from({ length: 20 }, () =>
      recordBusinessEvent({
        dedupeKey,
        eventName: "booking_started",
        subjectType: "PUBLIC",
        subjectId: "test-public",
        route: "/coaching",
        surface: "test",
        metadata: { offer_kind: "COACHING" },
        occurredAt: NOW,
      }),
    ),
  );

  const after = await countBusinessEvents("booking_started");
  assert.equal(after - before, 1);

  const rows = await rawEvents("dedupe_key", dedupeKey);
  assert.equal(rows.length, 1);
});

test("OBS 08.8: sensitive/free-text metadata keys are rejected", async () => {
  await assert.rejects(
    recordBusinessEvent({
      dedupeKey: unique("sensitive"),
      eventName: "booking_started",
      metadata: {
        requester_email: "private@example.com",
      },
      occurredAt: NOW,
    }),
    /not allowed/i,
  );
});

test("OBS 08.8: booking lifecycle emits requested + confirmed without PII", async () => {
  const { booking } = await makeAutoConfirmBooking();
  assert.equal(booking.status, "CONFIRMED");

  const rows = await rawEvents("booking_id", booking.id);
  const names = rows.map((row) => row.eventName);
  assert.ok(names.includes("booking_requested"));
  assert.ok(names.includes("booking_confirmed"));

  const serialized = rows.map((row) => row.metadata).join("\n");
  assert.doesNotMatch(serialized, /Private Person/i);
  assert.doesNotMatch(serialized, /example\.com/i);
  assert.doesNotMatch(serialized, /Sensitive qualification/i);
  assert.doesNotMatch(serialized, /201000000000/);

  const beforeReconcile = rows.length;
  await reconcileDurableBusinessEvents({ since: NOW });
  const afterReconcile = await rawEvents("booking_id", booking.id);
  assert.equal(
    afterReconcile.length,
    beforeReconcile,
    "direct and reconstructed booking events must share durable dedupe identity",
  );
});

test("OBS 08.8: recovery preserves repeated same-second booking transitions", async () => {
  const { booking } = await makeAutoConfirmBooking();
  const d1 = await getD1Database();
  const occurredAt = Math.floor((NOW.getTime() + 5_000) / 1000);
  const historyA = `bkh_${unique("same-second-a")}`;
  const historyB = `bkh_${unique("same-second-b")}`;

  await d1.batch([
    d1
      .prepare(
        `INSERT INTO booking_history
         (id, booking_id, action, from_status, to_status, actor_id, detail, created_at)
         VALUES (?, ?, 'RESCHEDULED', 'CONFIRMED', 'CONFIRMED', 'test-admin', '{}', ?)`,
      )
      .bind(historyA, booking.id, occurredAt),
    d1
      .prepare(
        `INSERT INTO booking_history
         (id, booking_id, action, from_status, to_status, actor_id, detail, created_at)
         VALUES (?, ?, 'RESCHEDULED', 'CONFIRMED', 'CONFIRMED', 'test-admin', '{}', ?)`,
      )
      .bind(historyB, booking.id, occurredAt),
  ]);

  await reconcileDurableBusinessEvents({
    since: new Date(occurredAt * 1000),
  });

  const rows = (await rawEvents("booking_id", booking.id)).filter(
    (row) => row.eventName === "booking_rescheduled",
  );
  assert.equal(rows.length, 2);
  assert.deepEqual(
    new Set(rows.map((row) => row.dedupeKey)),
    new Set([
      `booking-history:${historyA}:booking_rescheduled`,
      `booking-history:${historyB}:booking_rescheduled`,
    ]),
  );

  await reconcileDurableBusinessEvents({
    since: new Date(occurredAt * 1000),
  });
  const repeated = (await rawEvents("booking_id", booking.id)).filter(
    (row) => row.eventName === "booking_rescheduled",
  );
  assert.equal(repeated.length, 2, "recovery must remain idempotent");
});

test("OBS 08.8: checkout + manual payment emit durable payment funnel truth", async () => {
  const { order } = await makeManualOrder();
  let rows = await rawEvents("order_id", order.id);
  assert.ok(rows.some((row) => row.eventName === "checkout_started"));

  const paid = await commerceTest.recordManualPayment(
    {
      orderId: order.id,
      expectedVersion: order.version,
      note: "Bank receipt OBS-12345",
      now: new Date(NOW.getTime() + 1000),
    },
    "test-admin",
  );
  assert.equal(paid.status, "PAID");

  rows = await rawEvents("order_id", order.id);
  assert.ok(rows.some((row) => row.eventName === "payment_confirmed"));
  const beforeReconcile = rows.length;
  assert.ok(
    rows.every((row) => row.dedupeKey.startsWith("order-history:")),
    "direct Order telemetry must use durable order_history identity",
  );

  await reconcileDurableBusinessEvents({ since: NOW });
  rows = await rawEvents("order_id", order.id);
  assert.equal(
    rows.length,
    beforeReconcile,
    "direct and reconstructed Order events must share durable dedupe identity",
  );

  const db = await getDb();
  const effect = await db
    .select()
    .from(orchestrationEffects)
    .where(eq(orchestrationEffects.subjectId, order.id))
    .get();
  assert.equal(effect?.effectType, "ORDER_FULFILL");

  const serialized = rows.map((row) => row.metadata).join("\n");
  assert.doesNotMatch(serialized, /example\.com/i);
  assert.doesNotMatch(serialized, /OBS-12345/i);
});

test("OBS 08.8: durable histories reconstruct missing analytics after crash-like loss", async () => {
  const { booking } = await makeAutoConfirmBooking();
  const { order } = await makeManualOrder();
  await commerceTest.recordManualPayment(
    {
      orderId: order.id,
      expectedVersion: order.version,
      note: "Recovery receipt",
      now: new Date(NOW.getTime() + 2000),
    },
    "test-admin",
  );

  const d1 = await getD1Database();
  await d1
    .prepare("DELETE FROM business_events WHERE booking_id = ? OR order_id = ?")
    .bind(booking.id, order.id)
    .run();

  assert.equal((await rawEvents("booking_id", booking.id)).length, 0);
  assert.equal((await rawEvents("order_id", order.id)).length, 0);

  await reconcileDurableBusinessEvents();

  const bookingRows = await rawEvents("booking_id", booking.id);
  assert.ok(bookingRows.some((row) => row.eventName === "booking_requested"));
  assert.ok(bookingRows.some((row) => row.eventName === "booking_confirmed"));

  const orderRows = await rawEvents("order_id", order.id);
  assert.ok(orderRows.some((row) => row.eventName === "checkout_started"));
  assert.ok(orderRows.some((row) => row.eventName === "payment_confirmed"));
});

test("OBS 08.8: public CTA tracking is bounded, idempotent and PII-free", async () => {
  const offer = await createOffer({
    kind: "COACHING",
    title: "Public CTA observability",
    slug: unique("cta-offer"),
    accessMode: "FREE",
    active: true,
  });
  const eventKey = crypto.randomUUID();

  await recordPublicOfferCta({
    eventKey,
    offerSlug: offer.slug,
    route: "/coaching",
    target: "lead",
    surface: "hero-primary",
  });
  await recordPublicOfferCta({
    eventKey,
    offerSlug: offer.slug,
    route: "/coaching",
    target: "lead",
    surface: "hero-primary",
  });

  const rows = await rawEvents("offer_id", offer.id);
  const ctas = rows.filter((row) => row.eventName === "offer_cta_clicked");
  assert.equal(ctas.length, 1);
  assert.match(ctas[0].metadata, /"target":"lead"/);
});

test("OBS 08.8: public CTA route must match Offer kind", async () => {
  const offer = await createOffer({
    kind: "WORKSHOP",
    title: "Route integrity workshop",
    slug: unique("route-workshop"),
    accessMode: "FREE",
    active: true,
  });

  await recordPublicOfferCta({
    eventKey: crypto.randomUUID(),
    offerSlug: offer.slug,
    route: "/coaching",
    target: "lead",
    surface: "hero-primary",
  });

  const rows = await rawEvents("offer_id", offer.id);
  assert.equal(
    rows.filter((row) => row.eventName === "offer_cta_clicked").length,
    0,
  );
});

test("OBS 08.8: anonymous front-funnel telemetry keeps D1 write headroom", () => {
  // A scope-anchored window may begin before the UTC billing boundary and
  // carry unused capacity into the next day, so reserve one extra window.
  const windowsPerDay =
    Math.ceil((24 * 60) / PUBLIC_ANALYTICS_BUDGET.windowMinutes) + 1;
  const worstCaseRowsWritten =
    windowsPerDay * PUBLIC_ANALYTICS_BUDGET.maxCount * 2;

  assert.equal(PUBLIC_ANALYTICS_BUDGET.scopeKey, "analytics:public-funnel");
  assert.equal(PUBLIC_ANALYTICS_BUDGET.windowMinutes, 15);
  assert.ok(
    worstCaseRowsWritten <= 20_000,
    `front-funnel telemetry budget would consume ${worstCaseRowsWritten} D1 row writes/day at saturation`,
  );
});

test("OBS 08.8: summary exposes the complete contracted event vocabulary", async () => {
  const summary = await getBusinessEventSummary({
    windowDays: 30,
    now: new Date("2026-10-28T12:00:00.000Z"),
  });
  assert.equal(summary.windowDays, 30);
  assert.deepEqual(Object.keys(summary.counts).sort(), [...BUSINESS_EVENT_NAMES].sort());
  assert.ok(summary.total >= 0);
});
