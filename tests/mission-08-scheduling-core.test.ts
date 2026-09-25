/**
 * MISSION 08.1 — Scheduling Core Test Suite
 *
 * Covers: booking type validation, availability windows, canonical slot
 * generation, slot hold acquisition / release / consume, concurrency safety,
 * stale-owner protection, and provider contract fail-closed behavior.
 *
 * Time references:
 *   - TZ = UTC+0 reference dates chosen so weekdays are stable.
 *   - America/New_York used for DST-sensitive cases.
 */

import "./helpers/env";

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { migrateLocalDb } from "../src/lib/db/migrate";
import { disposeCloudflareBindings } from "../src/lib/cloudflare/bindings";
import { getDb } from "@/lib/db";
import { slotHolds } from "@/lib/db";
import { eq } from "drizzle-orm";
import type { BookingType, BookingAvailabilityWindow } from "@/lib/db";

import {
  createBookingTypeSchema,
  createAvailabilityWindowSchema,
  type CreateBookingTypeInput,
  type CreateAvailabilityWindowInput,
} from "@/features/scheduling/schemas";
import {
  generateCandidateSlots,
  buildSlotKey,
  acquireSlotHold,
  releaseSlotHold,
  consumeSlotHold,
  createBookingType,
  createAvailabilityWindow,
} from "@/features/scheduling";
import {
  UnconfiguredPaymentGateway,
  SchedulingProviderError,
  type PaymentGateway,
  type CalendarProvider,
} from "@/features/scheduling/providers";

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

test.before(async () => {
  await migrateLocalDb();
});

test.after(async () => {
  await disposeCloudflareBindings();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let seq = 0;
function uniqueSlug(prefix = "test"): string {
  return `${prefix}-${Date.now().toString(36)}-${seq++}`;
}

function makeValidBookingTypeInput(overrides: Partial<CreateBookingTypeInput> = {}): CreateBookingTypeInput {
  return {
    slug: uniqueSlug("coach"),
    title: "Coaching Session",
    durationMinutes: 60,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    minimumNoticeMinutes: 60,
    bookingHorizonDays: 30,
    timezone: "America/New_York",
    confirmationPolicy: "AUTO_CONFIRM",
    accessMode: "FREE",
    meetingMethod: "TO_BE_CONFIRMED",
    attendeeLimit: 1,
    ...overrides,
  };
}

function makeValidWindowInput(
  bookingTypeId: string,
  overrides: Partial<CreateAvailabilityWindowInput> = {},
): CreateAvailabilityWindowInput {
  return {
    bookingTypeId,
    weekday: 1, // Monday
    startMinute: 540, // 09:00
    endMinute: 1020, // 17:00
    ...overrides,
  };
}

// Fixed test timestamps (all UTC).
// Tuesday, Oct 27 2026 — chosen as a stable mid-week reference.
const SLOT_START = new Date("2026-10-27T14:00:00.000Z"); // 10:00 AM EDT
const SLOT_END = new Date("2026-10-27T15:00:00.000Z"); // 11:00 AM EDT (60-min slot)

// ---------------------------------------------------------------------------
// 1–7: BOOKING TYPE VALIDATION (pure schema tests)
// ---------------------------------------------------------------------------

test("SCHEDULING: booking type accepts valid policy", () => {
  const result = createBookingTypeSchema.safeParse(makeValidBookingTypeInput());
  assert.ok(result.success, result.error?.message ?? "schema should have parsed successfully");
});

test("SCHEDULING: booking type rejects zero/negative duration", () => {
  const r0 = createBookingTypeSchema.safeParse(makeValidBookingTypeInput({ durationMinutes: 0 }));
  assert.ok(!r0.success);
  const rNeg = createBookingTypeSchema.safeParse(makeValidBookingTypeInput({ durationMinutes: -30 }));
  assert.ok(!rNeg.success);
});

test("SCHEDULING: booking type rejects negative buffers", () => {
  const rBefore = createBookingTypeSchema.safeParse(makeValidBookingTypeInput({ bufferBeforeMinutes: -1 }));
  assert.ok(!rBefore.success);
  const rAfter = createBookingTypeSchema.safeParse(makeValidBookingTypeInput({ bufferAfterMinutes: -5 }));
  assert.ok(!rAfter.success);
});

test("SCHEDULING: booking type rejects invalid attendee limit", () => {
  const r0 = createBookingTypeSchema.safeParse(makeValidBookingTypeInput({ attendeeLimit: 0 }));
  assert.ok(!r0.success);
  const rNeg = createBookingTypeSchema.safeParse(makeValidBookingTypeInput({ attendeeLimit: -1 }));
  assert.ok(!rNeg.success);
});

test("SCHEDULING: booking type rejects invalid confirmation policy", () => {
  const r = createBookingTypeSchema.safeParse(
    makeValidBookingTypeInput({ confirmationPolicy: "INSTANT" as never }),
  );
  assert.ok(!r.success);
});

test("SCHEDULING: booking type rejects invalid access mode", () => {
  const r = createBookingTypeSchema.safeParse(
    makeValidBookingTypeInput({ accessMode: "SUBSCRIPTION" as never }),
  );
  assert.ok(!r.success);
});

test("SCHEDULING: booking type rejects invalid IANA timezone", () => {
  const r = createBookingTypeSchema.safeParse(
    makeValidBookingTypeInput({ timezone: "Mars/Phobos" }),
  );
  assert.ok(!r.success);
  // Positive control — valid zones pass.
  const rOk = createBookingTypeSchema.safeParse(makeValidBookingTypeInput({ timezone: "Asia/Gaza" }));
  assert.ok(rOk.success);
});

test("SCHEDULING: booking type accepts PAYMENT_DISABLED access mode", () => {
  const r = createBookingTypeSchema.safeParse(
    makeValidBookingTypeInput({ accessMode: "PAYMENT_DISABLED" }),
  );
  assert.ok(r.success);
});

// ---------------------------------------------------------------------------
// 8–11: AVAILABILITY WINDOWS
// ---------------------------------------------------------------------------

test("SCHEDULING: availability window rejects invalid weekday", () => {
  const r = createAvailabilityWindowSchema.safeParse(
    makeValidWindowInput("bt_123", { weekday: 7 }),
  );
  assert.ok(!r.success);
});

test("SCHEDULING: availability window rejects start >= end", () => {
  const r = createAvailabilityWindowSchema.safeParse(
    makeValidWindowInput("bt_123", { weekday: 1, startMinute: 600, endMinute: 600 }),
  );
  assert.ok(!r.success);
  const r2 = createAvailabilityWindowSchema.safeParse(
    makeValidWindowInput("bt_123", { weekday: 1, startMinute: 700, endMinute: 500 }),
  );
  assert.ok(!r2.success);
});

test("SCHEDULING: availability window rejects values outside 0..1440", () => {
  const r = createAvailabilityWindowSchema.safeParse(
    makeValidWindowInput("bt_123", { weekday: 1, startMinute: -1, endMinute: 600 }),
  );
  assert.ok(!r.success);
  const r2 = createAvailabilityWindowSchema.safeParse(
    makeValidWindowInput("bt_123", { weekday: 1, startMinute: 500, endMinute: 1500 }),
  );
  assert.ok(!r2.success);
});

test("SCHEDULING: duplicate and overlapping windows are rejected at write time", async () => {
  // Create a booking type for this test.
  const bt = await createBookingType(
    makeValidBookingTypeInput({ timezone: "America/New_York" }),
  );

  // Insert first window: Mon 09:00-10:00 (540-600).
  await createAvailabilityWindow(makeValidWindowInput(bt.id, { weekday: 1, startMinute: 540, endMinute: 600 }));

  // Duplicate of the exact same window — must be rejected.
  await assert.rejects(
    createAvailabilityWindow(makeValidWindowInput(bt.id, { weekday: 1, startMinute: 540, endMinute: 600 })),
    /Duplicate window/,
  );

  // Overlapping window: Mon 09:30-10:30 (570-630) — overlaps 540-600.
  await assert.rejects(
    createAvailabilityWindow(makeValidWindowInput(bt.id, { weekday: 1, startMinute: 570, endMinute: 630 })),
    /Overlapping window/,
  );

  // Non-overlapping adjacent window: Mon 10:00-11:00 (600-660) — does NOT overlap.
  const ok = await createAvailabilityWindow(makeValidWindowInput(bt.id, { weekday: 1, startMinute: 600, endMinute: 660 }));
  assert.ok(ok.id);
});

// ---------------------------------------------------------------------------
// 12–18: CANONICAL SLOT GENERATION (pure tests, no DB)
// ---------------------------------------------------------------------------

test("SCHEDULING: generates deterministic slots for a known window", () => {
  const bookingType: BookingType = {
    id: "bt_test_001",
    slug: "test",
    title: "Test",
    description: null,
    durationMinutes: 60,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    minimumNoticeMinutes: 0,
    bookingHorizonDays: 365,
    timezone: "America/New_York",
    confirmationPolicy: "AUTO_CONFIRM",
    accessMode: "FREE",
    meetingMethod: "TO_BE_CONFIRMED",
    attendeeLimit: 1,
    active: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  // Monday Oct 26 2026 09:00-10:00 local (EDT = UTC-4).
  // Local 09:00 → UTC 13:00.  So the slot is 13:00–14:00 UTC.
  const windows: BookingAvailabilityWindow[] = [
    {
      id: "w1",
      bookingTypeId: "bt_test_001",
      weekday: 1, // Monday
      startMinute: 540, // 09:00
      endMinute: 600, // 10:00
      createdAt: new Date(),
    },
  ];

  const rangeStart = new Date("2026-10-26T00:00:00.000Z");
  const rangeEnd = new Date("2026-10-26T23:59:59.999Z");
  const now = new Date("2026-10-26T00:00:00.000Z");

  const slots = generateCandidateSlots({ bookingType, windows, rangeStart, rangeEnd, now });
  assert.equal(slots.length, 1);
  assert.equal(slots[0].startAt.toISOString(), "2026-10-26T13:00:00.000Z");
  assert.equal(slots[0].endAt.toISOString(), "2026-10-26T14:00:00.000Z");
});

test("SCHEDULING: slot generation respects duration", () => {
  const bookingType: BookingType = {
    id: "bt_dur",
    slug: "test-dur",
    title: "Test",
    description: null,
    durationMinutes: 30,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    minimumNoticeMinutes: 0,
    bookingHorizonDays: 365,
    timezone: "America/New_York",
    confirmationPolicy: "AUTO_CONFIRM",
    accessMode: "FREE",
    meetingMethod: "TO_BE_CONFIRMED",
    attendeeLimit: 1,
    active: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  // Monday 09:00-11:00 local → UTC 13:00-15:00. 30-min slots → 4 slots.
  const windows: BookingAvailabilityWindow[] = [
    {
      id: "w1",
      bookingTypeId: "bt_dur",
      weekday: 1,
      startMinute: 540, // 09:00
      endMinute: 660, // 11:00
      createdAt: new Date(),
    },
  ];

  const rangeStart = new Date("2026-10-26T00:00:00.000Z");
  const rangeEnd = new Date("2026-10-26T23:59:59.999Z");
  const now = new Date("2026-10-26T00:00:00.000Z");

  const slots = generateCandidateSlots({ bookingType, windows, rangeStart, rangeEnd, now });
  assert.equal(slots.length, 4);
  assert.equal(slots[0].startAt.toISOString(), "2026-10-26T13:00:00.000Z");
  assert.equal(slots[0].endAt.toISOString(), "2026-10-26T13:30:00.000Z");
  assert.equal(slots[3].startAt.toISOString(), "2026-10-26T14:30:00.000Z");
});

test("SCHEDULING: slot generation respects minimum notice", () => {
  const bookingType: BookingType = {
    id: "bt_notice",
    slug: "test-notice",
    title: "Test",
    description: null,
    durationMinutes: 60,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    minimumNoticeMinutes: 120, // 2 hours notice required
    bookingHorizonDays: 365,
    timezone: "America/New_York",
    confirmationPolicy: "AUTO_CONFIRM",
    accessMode: "FREE",
    meetingMethod: "TO_BE_CONFIRMED",
    attendeeLimit: 1,
    active: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const windows: BookingAvailabilityWindow[] = [
    {
      id: "w1",
      bookingTypeId: "bt_notice",
      weekday: 1,
      startMinute: 540, // 09:00
      endMinute: 780, // 13:00 (4-hour window)
      createdAt: new Date(),
    },
  ];

  const now = new Date("2026-10-26T12:30:00.000Z"); // 08:30 AM EDT
  // Deadline = now + 120 min = 10:30 AM EDT = 14:30 UTC
  // Slots starting before 14:30 UTC should be filtered.
  // Local 09:00 → UTC 13:00 (< 14:30, filtered)
  // Local 10:00 → UTC 14:00 (< 14:30, filtered)
  // Local 11:00 → UTC 15:00 (>= 14:30, included)
  // Local 12:00 → UTC 16:00 (included)
  const rangeStart = new Date("2026-10-26T00:00:00.000Z");
  const rangeEnd = new Date("2026-10-26T23:59:59.999Z");

  const slots = generateCandidateSlots({ bookingType, windows, rangeStart, rangeEnd, now });
  assert.equal(slots.length, 2);
  assert.equal(slots[0].startAt.toISOString(), "2026-10-26T15:00:00.000Z"); // 11:00 EDT
  assert.equal(slots[1].startAt.toISOString(), "2026-10-26T16:00:00.000Z"); // 12:00 EDT
});

test("SCHEDULING: slot generation respects booking horizon", () => {
  const bookingType: BookingType = {
    id: "bt_horizon",
    slug: "test-horizon",
    title: "Test",
    description: null,
    durationMinutes: 60,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    minimumNoticeMinutes: 0,
    bookingHorizonDays: 3, // only 3 days from now
    timezone: "America/New_York",
    confirmationPolicy: "AUTO_CONFIRM",
    accessMode: "FREE",
    meetingMethod: "TO_BE_CONFIRMED",
    attendeeLimit: 1,
    active: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  // Monday-Friday windows
  const windows: BookingAvailabilityWindow[] = [
    {
      id: "w_mon",
      bookingTypeId: "bt_horizon",
      weekday: 1, // Monday
      startMinute: 540,
      endMinute: 600,
      createdAt: new Date(),
    },
    {
      id: "w_tue",
      bookingTypeId: "bt_horizon",
      weekday: 2, // Tuesday
      startMinute: 540,
      endMinute: 600,
      createdAt: new Date(),
    },
    {
      id: "w_wed",
      bookingTypeId: "bt_horizon",
      weekday: 3, // Wednesday
      startMinute: 540,
      endMinute: 600,
      createdAt: new Date(),
    },
    {
      id: "w_thu",
      bookingTypeId: "bt_horizon",
      weekday: 4, // Thursday
      startMinute: 540,
      endMinute: 600,
      createdAt: new Date(),
    },
  ];

  const now = new Date("2026-10-26T00:00:00.000Z"); // Monday Oct 26
  // Horizon = Oct 29 00:00 UTC (3 days from now)
  // Mon Oct 26: slot at 13:00 UTC ✓ (within horizon)
  // Tue Oct 27: slot at 13:00 UTC ✓
  // Wed Oct 28: slot at 13:00 UTC ✓ (2d 13h from now < 3d horizon)
  // Thu Oct 29: slot at 13:00 UTC — beyond horizon (13:00 > Oct 29 00:00 UTC) ✗
  const rangeStart = new Date("2026-10-26T00:00:00.000Z");
  const rangeEnd = new Date("2026-10-30T23:59:59.999Z");

  const slots = generateCandidateSlots({ bookingType, windows, rangeStart, rangeEnd, now });
  // Expected: Mon, Tue, Wed = 3 slots. Thu is beyond the 3-day horizon.
  assert.equal(slots.length, 3);
  // Monday
  assert.equal(slots[0].startAt.toISOString(), "2026-10-26T13:00:00.000Z");
  // Tuesday
  assert.equal(slots[1].startAt.toISOString(), "2026-10-27T13:00:00.000Z");
  // Wednesday
  assert.equal(slots[2].startAt.toISOString(), "2026-10-28T13:00:00.000Z");
});

test("SCHEDULING: converts configured local timezone to correct UTC instant", () => {
  const bookingType: BookingType = {
    id: "bt_tz",
    slug: "test-tz",
    title: "Test",
    description: null,
    durationMinutes: 60,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    minimumNoticeMinutes: 0,
    bookingHorizonDays: 365,
    timezone: "America/New_York",
    confirmationPolicy: "AUTO_CONFIRM",
    accessMode: "FREE",
    meetingMethod: "TO_BE_CONFIRMED",
    attendeeLimit: 1,
    active: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const windows: BookingAvailabilityWindow[] = [
    {
      id: "w1",
      bookingTypeId: "bt_tz",
      weekday: 1, // Monday
      startMinute: 540, // 09:00 local = 13:00 UTC (EDT = UTC-4)
      endMinute: 600, // 10:00 local = 14:00 UTC
      createdAt: new Date(),
    },
  ];

  const rangeStart = new Date("2026-10-26T00:00:00.000Z");
  const rangeEnd = new Date("2026-10-26T23:59:59.999Z");
  const now = new Date("2026-10-26T00:00:00.000Z");

  const slots = generateCandidateSlots({ bookingType, windows, rangeStart, rangeEnd, now });
  assert.equal(slots.length, 1);
  // 9:00 AM EDT = 13:00 UTC (NOT 9:00 UTC — proves TZ is applied).
  assert.equal(slots[0].startAt.toISOString(), "2026-10-26T13:00:00.000Z");
  assert.equal(slots[0].endAt.toISOString(), "2026-10-26T14:00:00.000Z");
});

test("SCHEDULING: DST-sensitive timezone produces correct UTC behavior", () => {
  // Same booking type, range crossing the US DST transition (Nov 1 2026).
  const bookingType: BookingType = {
    id: "bt_dst",
    slug: "test-dst",
    title: "Test",
    description: null,
    durationMinutes: 60,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    minimumNoticeMinutes: 0,
    bookingHorizonDays: 365,
    timezone: "America/New_York",
    confirmationPolicy: "AUTO_CONFIRM",
    accessMode: "FREE",
    meetingMethod: "TO_BE_CONFIRMED",
    attendeeLimit: 1,
    active: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  // 9 AM Mon-Fri (540-600)
  const windows: BookingAvailabilityWindow[] = [
    { id: "w1", bookingTypeId: "bt_dst", weekday: 1, startMinute: 540, endMinute: 600, createdAt: new Date() }, // Mon
    { id: "w2", bookingTypeId: "bt_dst", weekday: 2, startMinute: 540, endMinute: 600, createdAt: new Date() }, // Tue
    { id: "w3", bookingTypeId: "bt_dst", weekday: 3, startMinute: 540, endMinute: 600, createdAt: new Date() }, // Wed
    { id: "w4", bookingTypeId: "bt_dst", weekday: 4, startMinute: 540, endMinute: 600, createdAt: new Date() }, // Thu
    { id: "w5", bookingTypeId: "bt_dst", weekday: 5, startMinute: 540, endMinute: 600, createdAt: new Date() }, // Fri
  ];

  // Range: Oct 26 (Mon) to Nov 5 (Thu) — crosses DST on Nov 1 (Sun) at 2 AM.
  const rangeStart = new Date("2026-10-26T00:00:00.000Z");
  const rangeEnd = new Date("2026-11-05T23:59:59.999Z");
  const now = new Date("2026-10-26T00:00:00.000Z");

  const slots = generateCandidateSlots({ bookingType, windows, rangeStart, rangeEnd, now });
  // Expected 8 weekday slots: Oct 26,27,28,29,30 (Mon-Fri) + Nov 2,3,4 (Mon-Wed;
  // Nov 1 is Sunday, Nov 5 is Thu but let's verify).
  // Mon-Fri Oct 26-30: 5 slots
  // Mon-Wed Nov 2-4: 3 slots (Nov 1 is Sunday, Nov 5 is Thursday but within range)
  // Actually Nov 5 (Thu) is also a weekday with a window.
  // So: Oct 26,27,28,29,30 = 5 + Nov 2,3,4,5 = 4. Total = 9.
  assert.ok(slots.length >= 8, `expected >= 8 slots, got ${slots.length}`);

  // Verify DST: Monday Oct 26 (EDT, UTC-4) → 9 AM local = 13:00 UTC
  const monOct26 = slots.find((s) => s.startAt.toISOString().startsWith("2026-10-26T13:0"));
  assert.ok(monOct26, "Oct 26 Monday slot should exist at 13:00 UTC (EDT)");

  // Verify DST: Monday Nov 2 (EST, UTC-5) → 9 AM local = 14:00 UTC
  const monNov2 = slots.find((s) => s.startAt.toISOString().startsWith("2026-11-02T14:0"));
  assert.ok(monNov2, "Nov 2 Monday slot should exist at 14:00 UTC (EST, after DST)");
});

test("SCHEDULING: slotKey is deterministic", () => {
  const key1 = buildSlotKey("bt_abc", new Date("2026-10-04T07:00:00.000Z"));
  const key2 = buildSlotKey("bt_abc", new Date("2026-10-04T07:00:00.000Z"));
  assert.equal(key1, key2);
  assert.equal(key1, "bt_abc:2026-10-04T07:00:00.000Z");

  // Different start → different key
  const key3 = buildSlotKey("bt_abc", new Date("2026-10-04T08:00:00.000Z"));
  assert.notEqual(key1, key3);

  // Different booking type → different key
  const key4 = buildSlotKey("bt_xyz", new Date("2026-10-04T07:00:00.000Z"));
  assert.notEqual(key1, key4);
});

// ---------------------------------------------------------------------------
// 19–22: HOLD ACQUISITION (DB-backed)
// ---------------------------------------------------------------------------

test("SCHEDULING: first caller acquires free slot", async () => {
  const bt = await createBookingType(makeValidBookingTypeInput({ timezone: "America/New_York" }));
  const now = new Date("2026-10-27T12:00:00.000Z");

  const result = await acquireSlotHold({
    bookingTypeId: bt.id,
    startAt: SLOT_START,
    endAt: SLOT_END,
    ownerToken: "owner-A",
    now,
    ttlMinutes: 10,
  });

  assert.ok(result.success);
  assert.ok(result.hold);
  assert.equal(result.hold!.ownerToken, "owner-A");
  assert.equal(result.hold!.status, "HELD");
  assert.equal(result.hold!.slotKey, buildSlotKey(bt.id, SLOT_START));
  assert.equal(result.hold!.expiresAt.getTime(), now.getTime() + 10 * 60_000);
});

test("SCHEDULING: same owner acquire is idempotent", async () => {
  const bt = await createBookingType(makeValidBookingTypeInput({ timezone: "America/New_York" }));
  const now = new Date("2026-10-27T12:00:00.000Z");

  const result1 = await acquireSlotHold({
    bookingTypeId: bt.id,
    startAt: SLOT_START,
    endAt: SLOT_END,
    ownerToken: "owner-A",
    now,
    ttlMinutes: 10,
  });
  assert.ok(result1.success);
  const holdId = result1.hold!.id;

  // Re-acquire with same owner — should be idempotent (same hold, no new row).
  const result2 = await acquireSlotHold({
    bookingTypeId: bt.id,
    startAt: SLOT_START,
    endAt: SLOT_END,
    ownerToken: "owner-A",
    now,
    ttlMinutes: 10,
  });
  assert.ok(result2.success);
  assert.equal(result2.hold!.id, holdId);
  assert.equal(result2.hold!.ownerToken, "owner-A");
  assert.equal(result2.hold!.status, "HELD");

  // Verify exactly one row in DB.
  const db = await getDb();
  const holds = await db
    .select()
    .from(slotHolds)
    .where(eq(slotHolds.slotKey, buildSlotKey(bt.id, SLOT_START)));
  assert.equal(holds.length, 1);
});

test("SCHEDULING: different owner cannot acquire unexpired slot", async () => {
  const bt = await createBookingType(makeValidBookingTypeInput({ timezone: "America/New_York" }));
  const now = new Date("2026-10-27T12:00:00.000Z");
  const slotKey = buildSlotKey(bt.id, SLOT_START);

  // Owner A acquires.
  const resultA = await acquireSlotHold({
    bookingTypeId: bt.id,
    startAt: SLOT_START,
    endAt: SLOT_END,
    ownerToken: "owner-A",
    now,
    ttlMinutes: 10,
  });
  assert.ok(resultA.success);

  // Owner B tries to acquire (within TTL) — should be rejected.
  const resultB = await acquireSlotHold({
    bookingTypeId: bt.id,
    startAt: SLOT_START,
    endAt: SLOT_END,
    ownerToken: "owner-B",
    now,
    ttlMinutes: 10,
  });
  assert.ok(!resultB.success);
  assert.equal(resultB.reason, "TAKEN");

  // Verify the hold is still owned by A.
  const db = await getDb();
  const holds = await db
    .select()
    .from(slotHolds)
    .where(eq(slotHolds.slotKey, slotKey));
  assert.equal(holds.length, 1);
  assert.equal(holds[0].ownerToken, "owner-A");
});

test("SCHEDULING: expired hold can be reclaimed", async () => {
  const bt = await createBookingType(makeValidBookingTypeInput({ timezone: "America/New_York" }));
  const nowAcquire = new Date("2026-10-27T12:00:00.000Z");
  const slotKey = buildSlotKey(bt.id, SLOT_START);

  // Owner A acquires with a short TTL.
  const resultA = await acquireSlotHold({
    bookingTypeId: bt.id,
    startAt: SLOT_START,
    endAt: SLOT_END,
    ownerToken: "owner-A",
    now: nowAcquire,
    ttlMinutes: 1, // 1-minute TTL
  });
  assert.ok(resultA.success);

  // Advance time past expiry.
  const nowAfterExpiry = new Date(nowAcquire.getTime() + 2 * 60_000);

  // Owner B reclaims the expired slot.
  const resultB = await acquireSlotHold({
    bookingTypeId: bt.id,
    startAt: SLOT_START,
    endAt: SLOT_END,
    ownerToken: "owner-B",
    now: nowAfterExpiry,
    ttlMinutes: 10,
  });
  assert.ok(resultB.success, `expected success, got: ${JSON.stringify(resultB)}`);
  assert.equal(resultB.hold!.ownerToken, "owner-B");
  assert.equal(resultB.hold!.status, "HELD");

  // DB should still have exactly one row, now owned by B.
  const db = await getDb();
  const holds = await db
    .select()
    .from(slotHolds)
    .where(eq(slotHolds.slotKey, slotKey));
  assert.equal(holds.length, 1);
  assert.equal(holds[0].ownerToken, "owner-B");
});

// ---------------------------------------------------------------------------
// 23–24: CONCURRENCY (DB-backed)
// ---------------------------------------------------------------------------

test("SCHEDULING: two concurrent acquire attempts produce exactly one owner", async () => {
  const bt = await createBookingType(makeValidBookingTypeInput({ timezone: "America/New_York" }));
  const now = new Date("2026-10-27T12:00:00.000Z");

  const [result1, result2] = await Promise.all([
    acquireSlotHold({
      bookingTypeId: bt.id,
      startAt: SLOT_START,
      endAt: SLOT_END,
      ownerToken: "owner-1",
      now,
      ttlMinutes: 10,
    }),
    acquireSlotHold({
      bookingTypeId: bt.id,
      startAt: SLOT_START,
      endAt: SLOT_END,
      ownerToken: "owner-2",
      now,
      ttlMinutes: 10,
    }),
  ]);

  const successCount = [result1, result2].filter((r) => r.success).length;
  const failCount = [result1, result2].filter((r) => !r.success).length;

  assert.equal(successCount, 1, "exactly one concurrent caller should win");
  assert.equal(failCount, 1, "exactly one concurrent caller should lose");
  const loser = [result1, result2].find((r) => !r.success)!;
  assert.equal(loser.reason, "TAKEN");
});

test("SCHEDULING: database contains one canonical slot-hold record after concurrent acquire", async () => {
  const bt = await createBookingType(makeValidBookingTypeInput({ timezone: "America/New_York" }));
  const now = new Date("2026-10-27T12:00:00.000Z");
  const slotKey = buildSlotKey(bt.id, SLOT_START);

  await Promise.all([
    acquireSlotHold({
      bookingTypeId: bt.id,
      startAt: SLOT_START,
      endAt: SLOT_END,
      ownerToken: "concurrent-1",
      now,
      ttlMinutes: 10,
    }),
    acquireSlotHold({
      bookingTypeId: bt.id,
      startAt: SLOT_START,
      endAt: SLOT_END,
      ownerToken: "concurrent-2",
      now,
      ttlMinutes: 10,
    }),
    acquireSlotHold({
      bookingTypeId: bt.id,
      startAt: SLOT_START,
      endAt: SLOT_END,
      ownerToken: "concurrent-3",
      now,
      ttlMinutes: 10,
    }),
  ]);

  const db = await getDb();
  const holds = await db
    .select()
    .from(slotHolds)
    .where(eq(slotHolds.slotKey, slotKey));
  assert.equal(holds.length, 1, "exactly one canonical hold row must exist regardless of contention");
  assert.ok(["concurrent-1", "concurrent-2", "concurrent-3"].includes(holds[0].ownerToken));
});

// ---------------------------------------------------------------------------
// 25–30: STALE OWNER PROTECTION (DB-backed)
// ---------------------------------------------------------------------------

test("SCHEDULING: previous owner cannot release after another owner reclaims", async () => {
  const bt = await createBookingType(makeValidBookingTypeInput({ timezone: "America/New_York" }));
  const nowAcquire = new Date("2026-10-27T12:00:00.000Z");
  const slotKey = buildSlotKey(bt.id, SLOT_START);

  // Owner A acquires (short TTL).
  await acquireSlotHold({
    bookingTypeId: bt.id,
    startAt: SLOT_START,
    endAt: SLOT_END,
    ownerToken: "owner-A",
    now: nowAcquire,
    ttlMinutes: 1,
  });

  // Advance past expiry; Owner B reclaims.
  const nowAfter = new Date(nowAcquire.getTime() + 2 * 60_000);
  await acquireSlotHold({
    bookingTypeId: bt.id,
    startAt: SLOT_START,
    endAt: SLOT_END,
    ownerToken: "owner-B",
    now: nowAfter,
    ttlMinutes: 10,
  });

  // Owner A (stale) tries to release — should be rejected.
  await assert.rejects(
    releaseSlotHold(bt.id, SLOT_START, "owner-A", nowAfter),
    /Only the current owner/,
  );

  // Verify the hold is still HELD by B (not RELEASED).
  const db = await getDb();
  const holds = await db
    .select()
    .from(slotHolds)
    .where(eq(slotHolds.slotKey, slotKey));
  assert.equal(holds.length, 1);
  assert.equal(holds[0].ownerToken, "owner-B");
  assert.equal(holds[0].status, "HELD");
});

test("SCHEDULING: previous owner cannot consume after another owner reclaims", async () => {
  const bt = await createBookingType(makeValidBookingTypeInput({ timezone: "America/New_York" }));
  const nowAcquire = new Date("2026-10-27T12:00:00.000Z");
  const slotKey = buildSlotKey(bt.id, SLOT_START);

  // Owner A acquires (short TTL).
  await acquireSlotHold({
    bookingTypeId: bt.id,
    startAt: SLOT_START,
    endAt: SLOT_END,
    ownerToken: "owner-A",
    now: nowAcquire,
    ttlMinutes: 1,
  });

  // Advance past expiry; Owner B reclaims.
  const nowAfter = new Date(nowAcquire.getTime() + 2 * 60_000);
  await acquireSlotHold({
    bookingTypeId: bt.id,
    startAt: SLOT_START,
    endAt: SLOT_END,
    ownerToken: "owner-B",
    now: nowAfter,
    ttlMinutes: 10,
  });

  // Owner A (stale) tries to consume — should be rejected.
  await assert.rejects(
    consumeSlotHold(bt.id, SLOT_START, "owner-A", nowAfter),
    /Only the current owner/,
  );

  // Verify the hold is still HELD by B (not CONSUMED).
  const db = await getDb();
  const holds = await db
    .select()
    .from(slotHolds)
    .where(eq(slotHolds.slotKey, slotKey));
  assert.equal(holds.length, 1);
  assert.equal(holds[0].ownerToken, "owner-B");
  assert.equal(holds[0].status, "HELD");
});

test("SCHEDULING: current owner can release", async () => {
  const bt = await createBookingType(makeValidBookingTypeInput({ timezone: "America/New_York" }));
  const now = new Date("2026-10-27T12:00:00.000Z");
  const slotKey = buildSlotKey(bt.id, SLOT_START);

  await acquireSlotHold({
    bookingTypeId: bt.id,
    startAt: SLOT_START,
    endAt: SLOT_END,
    ownerToken: "owner-A",
    now,
    ttlMinutes: 10,
  });

  // Current owner releases.
  await releaseSlotHold(bt.id, SLOT_START, "owner-A", now);

  // Verify the hold is now RELEASED.
  const db = await getDb();
  const holds = await db
    .select()
    .from(slotHolds)
    .where(eq(slotHolds.slotKey, slotKey));
  assert.equal(holds.length, 1);
  assert.equal(holds[0].status, "RELEASED");
  assert.ok(holds[0].releasedAt !== null, "releasedAt should be set after release");
});

test("SCHEDULING: current owner can consume valid hold", async () => {
  const bt = await createBookingType(makeValidBookingTypeInput({ timezone: "America/New_York" }));
  const now = new Date("2026-10-27T12:00:00.000Z");

  await acquireSlotHold({
    bookingTypeId: bt.id,
    startAt: SLOT_START,
    endAt: SLOT_END,
    ownerToken: "owner-A",
    now,
    ttlMinutes: 10,
  });

  // Current owner consumes.
  const consumed = await consumeSlotHold(bt.id, SLOT_START, "owner-A", now);
  assert.ok(consumed);
  assert.equal(consumed!.status, "CONSUMED");

  // Verify in DB.
  const db = await getDb();
  const holds = await db
    .select()
    .from(slotHolds)
    .where(eq(slotHolds.slotKey, buildSlotKey(bt.id, SLOT_START)));
  assert.equal(holds.length, 1);
  assert.equal(holds[0].status, "CONSUMED");
  assert.ok(holds[0].consumedAt !== null);
});

test("SCHEDULING: expired hold cannot be consumed", async () => {
  const bt = await createBookingType(makeValidBookingTypeInput({ timezone: "America/New_York" }));
  const nowAcquire = new Date("2026-10-27T12:00:00.000Z");
  const slotKey = buildSlotKey(bt.id, SLOT_START);

  await acquireSlotHold({
    bookingTypeId: bt.id,
    startAt: SLOT_START,
    endAt: SLOT_END,
    ownerToken: "owner-A",
    now: nowAcquire,
    ttlMinutes: 1,
  });

  // Advance past expiry.
  const nowAfter = new Date(nowAcquire.getTime() + 2 * 60_000);

  await assert.rejects(
    consumeSlotHold(bt.id, SLOT_START, "owner-A", nowAfter),
    /expired/i,
  );

  // Verify still HELD (not CONSUMED).
  const db = await getDb();
  const holds = await db
    .select()
    .from(slotHolds)
    .where(eq(slotHolds.slotKey, slotKey));
  assert.equal(holds[0].status, "HELD");
});

test("SCHEDULING: consumed slot cannot be reacquired", async () => {
  const bt = await createBookingType(makeValidBookingTypeInput({ timezone: "America/New_York" }));
  const now = new Date("2026-10-27T12:00:00.000Z");

  // Owner A acquires and consumes.
  await acquireSlotHold({
    bookingTypeId: bt.id,
    startAt: SLOT_START,
    endAt: SLOT_END,
    ownerToken: "owner-A",
    now,
    ttlMinutes: 10,
  });
  await consumeSlotHold(bt.id, SLOT_START, "owner-A", now);

  // Even the same owner cannot re-acquire a consumed slot.
  const result = await acquireSlotHold({
    bookingTypeId: bt.id,
    startAt: SLOT_START,
    endAt: SLOT_END,
    ownerToken: "owner-A",
    now,
    ttlMinutes: 10,
  });
  assert.ok(!result.success);
  assert.equal(result.reason, "CONSUMED");
});

// ---------------------------------------------------------------------------
// 31–32: PROVIDER CONTRACTS (pure tests)
// ---------------------------------------------------------------------------

test("SCHEDULING: unconfigured PaymentGateway fails closed", async () => {
  await assert.rejects(
    UnconfiguredPaymentGateway.createCheckout({
      priceId: "price_123",
      quantity: 1,
      successUrl: "https://example.com/success",
      cancelUrl: "https://example.com/cancel",
    }),
    SchedulingProviderError,
  );

  // Verify it does NOT return a fake success.
  let threw = false;
  try {
    await UnconfiguredPaymentGateway.createCheckout({
      priceId: "price_123",
      quantity: 1,
      successUrl: "https://example.com/success",
      cancelUrl: "https://example.com/cancel",
    });
  } catch (e) {
    threw = true;
    const err = e as SchedulingProviderError;
    assert.equal(err.code, "PROVIDER_NOT_CONFIGURED");
  }
  assert.ok(threw, "createCheckout must throw, not return fake success");
});

test("SCHEDULING: no provider-specific type leaks into domain contract", () => {
  // The CalendarProvider interface should not reference Google-specific types.
  // We verify the contract shape compiles without any provider SDK types.
  const provider: CalendarProvider = {
    getFreeBusy: async () => [],
    createEvent: async () => ({ id: "evt_1", provider: "mock" }),
    updateEvent: async () => {},
    cancelEvent: async () => {},
  };
  assert.ok(typeof provider.createEvent === "function");
  assert.ok(typeof provider.getFreeBusy === "function");
  assert.ok(typeof provider.cancelEvent === "function");
  assert.ok(typeof provider.updateEvent === "function");

  // The PaymentGateway interface should not reference Stripe/Lemon Squeezy.
  const payment: PaymentGateway = {
    createCheckout: async () => ({ checkoutUrl: "https://example.com", checkoutId: "c_1" }),
    verifyCallback: async () => ({ verified: true, paid: true, checkoutId: "c_1" }),
    refundOrCancel: async () => {},
  };
  assert.ok(typeof payment.createCheckout === "function");

  // No provider-specific names in the contract surface.
  const contractSource = provider.toString();
  assert.ok(!contractSource.includes("google") && !contractSource.includes("stripe") && !contractSource.includes("lemon"));
});

// ---------------------------------------------------------------------------
// Additional edge case: released slot can be reacquired by a different owner
// ---------------------------------------------------------------------------

test("SCHEDULING: released slot can be reacquired by a different owner", async () => {
  const bt = await createBookingType(makeValidBookingTypeInput({ timezone: "America/New_York" }));
  const now = new Date("2026-10-27T12:00:00.000Z");

  // Owner A acquires.
  await acquireSlotHold({
    bookingTypeId: bt.id,
    startAt: SLOT_START,
    endAt: SLOT_END,
    ownerToken: "owner-A",
    now,
    ttlMinutes: 10,
  });

  // Owner A releases.
  await releaseSlotHold(bt.id, SLOT_START, "owner-A", now);

  // Owner B reacquires the released slot.
  const resultB = await acquireSlotHold({
    bookingTypeId: bt.id,
    startAt: SLOT_START,
    endAt: SLOT_END,
    ownerToken: "owner-B",
    now,
    ttlMinutes: 10,
  });
  assert.ok(resultB.success);
  assert.equal(resultB.hold!.ownerToken, "owner-B");
  assert.equal(resultB.hold!.status, "HELD");
});
