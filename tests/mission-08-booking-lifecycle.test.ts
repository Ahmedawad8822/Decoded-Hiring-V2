/**
 * MISSION 08.2 — Booking Lifecycle & Approval
 *
 * Regression targets:
 * - request idempotency and one-booking-per-hold-generation
 * - explicit Ahmed/admin approval policy
 * - atomic hold consumption + confirmation
 * - stale/reclaimed hold ownership protection
 * - fail-closed paid modes
 * - server-authoritative CAS transitions
 * - decline/cancel/complete lifecycle
 * - auditable reschedule
 * - concurrent approval does not duplicate confirmation/audit
 */

import "./helpers/env";

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { eq } from "drizzle-orm";

import { migrateLocalDb } from "../src/lib/db/migrate";
import { disposeCloudflareBindings } from "../src/lib/cloudflare/bindings";
import {
  bookingAvailabilityWindows,
  bookingHistory,
  bookings,
  bookingTypes,
  slotHolds,
  type BookingType,
} from "@/lib/db";
import { getDb } from "@/lib/db";
import {
  acquireSlotHold,
  approveBooking,
  cancelBooking,
  completeBooking,
  createAvailabilityWindow,
  createBookingRequest,
  createBookingType,
  declineBooking,
  generateAcquisitionKey,
  getBookingHistory,
  rescheduleBooking,
  SchedulingDomainError,
} from "@/features/scheduling";
import type { CreateBookingTypeInput } from "@/features/scheduling";

const NOW = new Date("2026-10-27T12:00:00.000Z");
const SLOT_A = new Date("2026-10-27T14:00:00.000Z"); // Tue 10:00 EDT
const SLOT_B = new Date("2026-10-27T15:00:00.000Z"); // Tue 11:00 EDT
const ADMIN = { id: "ahmed-admin", role: "admin" as const };
const NON_ADMIN = { id: "not-admin", role: "system" as const };

let seq = 0;
function slug(prefix = "booking"): string {
  return `${prefix}-${Date.now().toString(36)}-${seq++}`;
}

function typeInput(
  overrides: Partial<CreateBookingTypeInput> = {},
): CreateBookingTypeInput {
  return {
    slug: slug(),
    title: "Coaching",
    durationMinutes: 60,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    minimumNoticeMinutes: 0,
    bookingHorizonDays: 30,
    timezone: "America/New_York",
    confirmationPolicy: "AHMED_APPROVAL",
    accessMode: "FREE",
    meetingMethod: "TO_BE_CONFIRMED",
    attendeeLimit: 1,
    ...overrides,
  };
}

async function makeType(
  overrides: Partial<CreateBookingTypeInput> = {},
): Promise<BookingType> {
  const bt = await createBookingType(typeInput(overrides));
  await createAvailabilityWindow({
    bookingTypeId: bt.id,
    weekday: 2,
    startMinute: 540,
    endMinute: 1020,
  });
  return bt;
}

async function holdSlot(
  bookingTypeId: string,
  startAt = SLOT_A,
  now = NOW,
  ttlMinutes = 10,
) {
  const acquisitionKey = generateAcquisitionKey();
  const result = await acquireSlotHold({
    bookingTypeId,
    startAt,
    now,
    ttlMinutes,
    acquisitionKey,
  });
  assert.ok(result.success, JSON.stringify(result));
  return {
    hold: result.hold,
    ownerToken: result.ownerToken,
    acquisitionKey: result.acquisitionKey,
  };
}

async function requestFromHold(
  bt: BookingType,
  h: Awaited<ReturnType<typeof holdSlot>>,
  requestKey = crypto.randomUUID(),
  now = NOW,
) {
  return createBookingRequest({
    bookingTypeId: bt.id,
    holdId: h.hold.id,
    holdAcquisitionKey: h.acquisitionKey,
    requestKey,
    requesterName: "Ahmed Test",
    requesterEmail: "AHMED@example.com",
    now,
  });
}

test.before(async () => {
  await migrateLocalDb();
  const db = await getDb();
  await db.delete(bookingHistory).run();
  await db.delete(bookings).run();
  await db.delete(slotHolds).run();
  await db.delete(bookingAvailabilityWindows).run();
  await db.delete(bookingTypes).run();
});

test.after(async () => {
  await disposeCloudflareBindings();
});

test("BOOKING 08.2: FREE AUTO_CONFIRM consumes exact hold and confirms atomically", async () => {
  const bt = await makeType({ confirmationPolicy: "AUTO_CONFIRM", accessMode: "FREE" });
  const h = await holdSlot(bt.id);
  const booking = await requestFromHold(bt, h);

  assert.equal(booking.status, "CONFIRMED");
  assert.equal(booking.version, 2);
  assert.ok(booking.confirmedAt);

  const db = await getDb();
  const hold = await db.select().from(slotHolds).where(eq(slotHolds.id, h.hold.id)).get();
  assert.equal(hold?.status, "CONSUMED");
  assert.equal(hold?.acquisitionKey, h.acquisitionKey);

  const history = await getBookingHistory(booking.id);
  assert.deepEqual(history.map((x) => x.action), ["REQUESTED", "AUTO_CONFIRMED"]);
});

test("BOOKING 08.2: AHMED_APPROVAL stays pending until explicit admin approval", async () => {
  const bt = await makeType({ confirmationPolicy: "AHMED_APPROVAL" });
  const h = await holdSlot(bt.id);
  const pending = await requestFromHold(bt, h);
  assert.equal(pending.status, "PENDING_APPROVAL");

  const approved = await approveBooking({
    bookingId: pending.id,
    expectedVersion: pending.version,
    actor: ADMIN,
    now: NOW,
  });
  assert.equal(approved.status, "CONFIRMED");
  assert.equal(approved.approvedBy, ADMIN.id);
  assert.ok(approved.approvedAt);

  const history = await getBookingHistory(pending.id);
  assert.deepEqual(history.map((x) => x.action), ["REQUESTED", "APPROVED"]);
});

test("BOOKING 08.2: approval rejects non-admin actor", async () => {
  const bt = await makeType();
  const h = await holdSlot(bt.id);
  const pending = await requestFromHold(bt, h);

  await assert.rejects(
    approveBooking({
      bookingId: pending.id,
      expectedVersion: pending.version,
      actor: NON_ADMIN,
      now: NOW,
    }),
    (error: unknown) =>
      error instanceof SchedulingDomainError &&
      error.code === "AUTHORIZATION_REQUIRED",
  );
});

test("BOOKING 08.2: duplicate requestKey returns the existing business result", async () => {
  const bt = await makeType();
  const h = await holdSlot(bt.id);
  const key = crypto.randomUUID();

  const first = await requestFromHold(bt, h, key);
  const second = await requestFromHold(bt, h, key);
  assert.equal(second.id, first.id);

  const db = await getDb();
  const rows = await db.select().from(bookings).where(eq(bookings.requestKey, key)).all();
  assert.equal(rows.length, 1);
});

test("BOOKING 08.2: same hold generation cannot create two bookings even with different request keys", async () => {
  const bt = await makeType();
  const h = await holdSlot(bt.id);

  const first = await requestFromHold(bt, h, crypto.randomUUID());
  const second = await requestFromHold(bt, h, crypto.randomUUID());
  assert.equal(second.id, first.id);

  const db = await getDb();
  const rows = await db.select().from(bookings).where(eq(bookings.holdId, h.hold.id)).all();
  assert.equal(rows.length, 1);
});

test("BOOKING 08.2: reclaimed hold generation makes old approval stale", async () => {
  const bt = await makeType();
  const initial = await holdSlot(bt.id, SLOT_A, NOW, 1);
  const pending = await requestFromHold(bt, initial);

  const afterExpiry = new Date(NOW.getTime() + 2 * 60_000);
  const replacement = await holdSlot(bt.id, SLOT_A, afterExpiry, 10);
  assert.notEqual(replacement.acquisitionKey, initial.acquisitionKey);
  assert.equal(replacement.hold.id, initial.hold.id, "08.1 reclaims the same hold row");

  await assert.rejects(
    approveBooking({
      bookingId: pending.id,
      expectedVersion: pending.version,
      actor: ADMIN,
      now: afterExpiry,
    }),
    (error: unknown) =>
      error instanceof SchedulingDomainError &&
      error.code === "HOLD_GENERATION_MISMATCH",
  );

  const db = await getDb();
  const current = await db.select().from(slotHolds).where(eq(slotHolds.id, replacement.hold.id)).get();
  assert.equal(current?.status, "HELD", "stale approval must not consume the replacement lease");
});

test("BOOKING 08.2: paid AUTO_CONFIRM fails closed and does not consume the hold", async () => {
  const bt = await makeType({
    confirmationPolicy: "AUTO_CONFIRM",
    accessMode: "PAID_SESSION",
  });
  const h = await holdSlot(bt.id);
  const booking = await requestFromHold(bt, h);

  assert.equal(booking.status, "REQUESTED");
  const db = await getDb();
  const hold = await db.select().from(slotHolds).where(eq(slotHolds.id, h.hold.id)).get();
  assert.equal(hold?.status, "HELD");
});

test("BOOKING 08.2: decline releases only its own pending hold generation", async () => {
  const bt = await makeType();
  const h = await holdSlot(bt.id);
  const pending = await requestFromHold(bt, h);

  const declined = await declineBooking({
    bookingId: pending.id,
    expectedVersion: pending.version,
    actor: ADMIN,
    now: NOW,
    reason: "Not a fit",
  });
  assert.equal(declined.status, "DECLINED");

  const db = await getDb();
  const hold = await db.select().from(slotHolds).where(eq(slotHolds.id, h.hold.id)).get();
  assert.equal(hold?.status, "RELEASED");
});

test("BOOKING 08.2: cancel confirmed booking preserves terminal consumed hold", async () => {
  const bt = await makeType({ confirmationPolicy: "AUTO_CONFIRM" });
  const h = await holdSlot(bt.id);
  const confirmed = await requestFromHold(bt, h);

  const cancelled = await cancelBooking({
    bookingId: confirmed.id,
    expectedVersion: confirmed.version,
    actor: ADMIN,
    now: new Date(NOW.getTime() + 60_000),
    reason: "Client cancelled",
  });
  assert.equal(cancelled.status, "CANCELLED");

  const db = await getDb();
  const hold = await db.select().from(slotHolds).where(eq(slotHolds.id, h.hold.id)).get();
  assert.equal(hold?.status, "CONSUMED");
});

test("BOOKING 08.2: confirmed booking can be completed", async () => {
  const bt = await makeType({ confirmationPolicy: "AUTO_CONFIRM" });
  const h = await holdSlot(bt.id);
  const confirmed = await requestFromHold(bt, h);

  const completed = await completeBooking({
    bookingId: confirmed.id,
    expectedVersion: confirmed.version,
    actor: ADMIN,
    now: new Date(NOW.getTime() + 2 * 60_000),
  });
  assert.equal(completed.status, "COMPLETED");
  assert.ok(completed.completedAt);
});

test("BOOKING 08.2: reschedule consumes new hold and preserves old/new slot audit", async () => {
  const bt = await makeType({ confirmationPolicy: "AUTO_CONFIRM" });
  const firstHold = await holdSlot(bt.id, SLOT_A);
  const confirmed = await requestFromHold(bt, firstHold);
  const secondHold = await holdSlot(bt.id, SLOT_B);

  const moved = await rescheduleBooking({
    bookingId: confirmed.id,
    expectedVersion: confirmed.version,
    actor: ADMIN,
    newHoldId: secondHold.hold.id,
    newHoldAcquisitionKey: secondHold.acquisitionKey,
    now: NOW,
    reason: "Client requested later time",
  });

  assert.equal(moved.status, "CONFIRMED");
  assert.equal(moved.slotKey, secondHold.hold.slotKey);
  assert.equal(moved.holdId, secondHold.hold.id);

  const db = await getDb();
  const nextHold = await db.select().from(slotHolds).where(eq(slotHolds.id, secondHold.hold.id)).get();
  assert.equal(nextHold?.status, "CONSUMED");

  const history = await getBookingHistory(moved.id);
  const event = history.find((x) => x.action === "RESCHEDULED");
  assert.ok(event?.detail);
  const detail = JSON.parse(event!.detail!);
  assert.equal(detail.old.slotKey, confirmed.slotKey);
  assert.equal(detail.next.slotKey, secondHold.hold.slotKey);
});

test("BOOKING 08.2: stale expectedVersion is rejected before state mutation", async () => {
  const bt = await makeType();
  const h = await holdSlot(bt.id);
  const pending = await requestFromHold(bt, h);

  await assert.rejects(
    declineBooking({
      bookingId: pending.id,
      expectedVersion: pending.version + 99,
      actor: ADMIN,
      now: NOW,
    }),
    (error: unknown) =>
      error instanceof SchedulingDomainError &&
      error.code === "CONCURRENT_MODIFICATION",
  );
});

test("BOOKING 08.2: concurrent approvals produce one confirmation audit", async () => {
  const bt = await makeType();
  const h = await holdSlot(bt.id);
  const pending = await requestFromHold(bt, h);

  const results = await Promise.allSettled([
    approveBooking({
      bookingId: pending.id,
      expectedVersion: pending.version,
      actor: ADMIN,
      now: NOW,
    }),
    approveBooking({
      bookingId: pending.id,
      expectedVersion: pending.version,
      actor: ADMIN,
      now: NOW,
    }),
  ]);

  assert.ok(results.some((r) => r.status === "fulfilled"));

  const db = await getDb();
  const final = await db.select().from(bookings).where(eq(bookings.id, pending.id)).get();
  assert.equal(final?.status, "CONFIRMED");

  const history = await getBookingHistory(pending.id);
  assert.equal(history.filter((x) => x.action === "APPROVED").length, 1);
});

test("BOOKING 08.2: migration journal/snapshot include unique 0013 booking lifecycle identity", async () => {
  const { readFileSync, existsSync } = await import("node:fs");
  const { join } = await import("node:path");
  const journal = JSON.parse(
    readFileSync(join(process.cwd(), "drizzle", "migrations", "meta", "_journal.json"), "utf8"),
  );
  const tags = journal.entries.map((x: { tag: string }) => x.tag);
  assert.equal(tags.filter((x: string) => x.startsWith("0013_")).length, 1);
  assert.ok(tags.includes("0013_booking_lifecycle"));
  assert.ok(
    existsSync(join(process.cwd(), "drizzle", "migrations", "meta", "0013_snapshot.json")),
  );
});
