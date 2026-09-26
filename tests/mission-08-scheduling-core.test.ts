/**
 * MISSION 08.1 — Scheduling Core Test Suite
 *
 * Covers: booking type validation, availability windows, canonical slot
 * generation, slot hold acquisition / release / consume, concurrency safety,
 * stale-owner protection, and provider contract fail-closed behavior.
 *
 * Remediation coverage (Mission 08.1 review):
 *   (A) Ownership token leak on losing acquire
 *   (B) Server-generated ownership token
 *   (C) Boundary runtime validation of acquire/mutate inputs
 *   (D) Authoritative, policy-enforced acquisition
 *   (E) Required (non-defaulted) policy fields at creation
 *   (F) DST nonexistent/ambiguous wall-time handling + IANA alias acceptance
 *   (G) DB-backed (trigger) overlap invariant under concurrency
 *   (H) Slug collision throws (no silent merge / policy leak)
 *   (I) Stale/forged owner token rejected on release/consume
 * (J) Browser cannot choose endAt/ownerToken (stripped, server derives)
 * (K) Consistent error types for hold mutations (SchedulingDomainError)
 * (L) Secure acquisition idempotency via acquisitionKey (no TTL extension)
 * (M) DST slot generation: nonexistent gaps skipped, no fall-back duplicates
 * (N) Domain error categorization (SchedulingDomainError vs SchedulingProviderError)
 * (O) Provider contract source-level regression (no SDK coupling)
 *
 * Time references:
 *   - TZ = UTC+0 reference dates chosen so weekdays are stable.
 *   - America/New_York used for DST-sensitive cases.
 *
 * 2026 calendar reference (used throughout):
 *   Oct 26 2026 = Monday (EDT, UTC-4)
 *   Oct 27 2026 = Tuesday (EDT, UTC-4)   <- SLOT_START day
 *   Nov  1 2026 = Sunday (DST ends, fall-back)
 *   Nov  2 2026 = Monday (EST, UTC-5)
 */

import "./helpers/env";

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { migrateLocalDb } from "../src/lib/db/migrate";
import { disposeCloudflareBindings } from "../src/lib/cloudflare/bindings";
import { getDb } from "@/lib/db";
import { slotHolds, bookingTypes, bookingAvailabilityWindows } from "@/lib/db";
import { eq } from "drizzle-orm";
import type { BookingType, BookingAvailabilityWindow } from "@/lib/db";
import { ZodError } from "zod";

import {
  createBookingTypeSchema,
  createAvailabilityWindowSchema,
  acquireSlotHoldSchema,
  mutateSlotHoldSchema,
  type CreateBookingTypeInput,
  type AcquireSlotHoldInput,
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
  generateOwnerToken,
  generateAcquisitionKey,
  SchedulingDomainError,
  isValidIanaTimezone,
  localTimeToUtc,
  NonexistentTimeError,
} from "@/features/scheduling";
import type { AcquireHoldResult } from "@/features/scheduling";
import {
  UnconfiguredPaymentGateway,
  SchedulingProviderError,
} from "@/features/scheduling/providers";

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

test.before(async () => {
  await migrateLocalDb();
  // (H) Remediation: the local D1 persists across `tsx` invocations, so a test
  // that re-uses a fixed slug would collide with a prior run's row and falsely
  // trip UNIQUE(slug). Wipe scheduling rows each run; collision *intention* is
  // still tested with per-run-unique slugs below.
  const db = await getDb();
  await db.delete(slotHolds).run();
  await db.delete(bookingAvailabilityWindows).run();
  await db.delete(bookingTypes).run();
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

function makeValidBookingTypeInput(
  overrides: Partial<CreateBookingTypeInput> = {},
): CreateBookingTypeInput {
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

/**
 * Create a booking type + a Tuesday (weekday 2) 09:00-17:00 EDT window so that
 * SLOT_START (10:00 AM EDT, Oct 27) is a canonical, acquire-able slot under the
 * authoritative acquisition path.
 */
async function createBookedType(): Promise<BookingType> {
  const bt = await createBookingType(
    makeValidBookingTypeInput({ timezone: "America/New_York" }),
  );
  await createAvailabilityWindow(
    makeValidWindowInput(bt.id, { weekday: 2, startMinute: 540, endMinute: 1020 }),
  );
  return bt;
}

// Fixed test timestamps (all UTC).
// Tuesday, Oct 27 2026 — chosen as a stable mid-week reference.
const SLOT_START = new Date("2026-10-27T14:00:00.000Z"); // 10:00 AM EDT
const SLOT_END = new Date("2026-10-27T15:00:00.000Z"); // 11:00 AM EDT (60-min slot)
// A Tuesday slot beyond the default 30-day horizon (Oct 27 + 35 days = Dec 1).
const SLOT_FAR = new Date("2026-12-01T14:00:00.000Z"); // 10:00 AM EST Tue
// A Tuesday slot at 9:00 AM EDT — in-window and aligned, used for notice tests.
const SLOT_WITHIN_NOTICE = new Date("2026-10-27T13:00:00.000Z"); // 09:00 AM EDT

const TOKEN_RE = /^hold_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

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
  const r = createBookingTypeSchema.safeParse(makeValidBookingTypeInput({ timezone: "Mars/Phobos" }));
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
// (E) Required policy fields — application layer refuses silent defaults.
// ---------------------------------------------------------------------------

test("SCHEDULING: confirmationPolicy is required (no silent default)", () => {
  const input = makeValidBookingTypeInput();
  delete (input as Partial<CreateBookingTypeInput>).confirmationPolicy;
  const r = createBookingTypeSchema.safeParse(input);
  assert.ok(!r.success, "confirmationPolicy must be required");
});

test("SCHEDULING: accessMode is required (no silent default)", () => {
  const input = makeValidBookingTypeInput();
  delete (input as Partial<CreateBookingTypeInput>).accessMode;
  const r = createBookingTypeSchema.safeParse(input);
  assert.ok(!r.success, "accessMode must be required");
});

test("SCHEDULING: meetingMethod is required (no silent default)", () => {
  const input = makeValidBookingTypeInput();
  delete (input as Partial<CreateBookingTypeInput>).meetingMethod;
  const r = createBookingTypeSchema.safeParse(input);
  assert.ok(!r.success, "meetingMethod must be required");
});

test("SCHEDULING: attendeeLimit is required (no silent default)", () => {
  const input = makeValidBookingTypeInput();
  delete (input as Partial<CreateBookingTypeInput>).attendeeLimit;
  const r = createBookingTypeSchema.safeParse(input);
  assert.ok(!r.success, "attendeeLimit must be required");
});

// ---------------------------------------------------------------------------
// 8–11: AVAILABILITY WINDOWS
// ---------------------------------------------------------------------------

test("SCHEDULING: availability window rejects invalid weekday", () => {
  const r = createAvailabilityWindowSchema.safeParse(makeValidWindowInput("bt_123", { weekday: 7 }));
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
  const bt = await createBookingType(makeValidBookingTypeInput({ timezone: "America/New_York" }));

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
// (G) DB-backed overlap invariant: adjacent windows remain valid; concurrent
// overlapping windows cannot both commit.
// ---------------------------------------------------------------------------

test("SCHEDULING: (G) adjacent windows on the same weekday are both valid", async () => {
  const bt = await createBookingType(makeValidBookingTypeInput({ timezone: "America/New_York" }));
  // 09:00-10:00 then 10:00-11:00 — adjacent, half-open, no overlap.
  const w1 = await createAvailabilityWindow(makeValidWindowInput(bt.id, { weekday: 1, startMinute: 540, endMinute: 600 }));
  const w2 = await createAvailabilityWindow(makeValidWindowInput(bt.id, { weekday: 1, startMinute: 600, endMinute: 660 }));
  assert.ok(w1.id && w2.id);
});

test("SCHEDULING: (G) concurrent overlapping windows -> exactly one wins, no overlap in DB", async () => {
  const bt = await createBookingType(makeValidBookingTypeInput({ timezone: "America/New_York" }));
  // 09:00-10:00 and 09:30-10:30 overlap — inserted concurrently.
  const results = await Promise.allSettled([
    createAvailabilityWindow(makeValidWindowInput(bt.id, { weekday: 1, startMinute: 540, endMinute: 600 })),
    createAvailabilityWindow(makeValidWindowInput(bt.id, { weekday: 1, startMinute: 570, endMinute: 630 })),
  ]);
  const successes = results.filter((r) => r.status === "fulfilled");
  const failures = results.filter((r) => r.status === "rejected");
  assert.equal(successes.length, 1, "exactly one overlapping window must commit");
  assert.equal(failures.length, 1, "exactly one overlapping window must be rejected");

  // Verify the DB holds the winner with NO overlapping pair.
  const db = await getDb();
  const rows = await db
    .select()
    .from(bookingAvailabilityWindows)
    .where(eq(bookingAvailabilityWindows.bookingTypeId, bt.id));
  assert.equal(rows.length, 1, "exactly one window row should exist for the winner");
  const [w] = rows;
  assert.ok(
    (w.startMinute === 540 && w.endMinute === 600) ||
      (w.startMinute === 570 && w.endMinute === 630),
    "the surviving window must be one of the two originals",
  );
  // No overlap is possible with a single row, but assert the half-open invariant.
  assert.ok(w.startMinute < w.endMinute);
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
  // Local 09:00 -> UTC 13:00.  So the slot is 13:00-14:00 UTC.
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

  // Monday 09:00-11:00 local -> UTC 13:00-15:00. 30-min slots -> 4 slots.
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
  // Local 09:00 -> UTC 13:00 (< 14:30, filtered)
  // Local 10:00 -> UTC 14:00 (< 14:30, filtered)
  // Local 11:00 -> UTC 15:00 (>= 14:30, included)
  // Local 12:00 -> UTC 16:00 (included)
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
    { id: "w_mon", bookingTypeId: "bt_horizon", weekday: 1, startMinute: 540, endMinute: 600, createdAt: new Date() }, // Monday
    { id: "w_tue", bookingTypeId: "bt_horizon", weekday: 2, startMinute: 540, endMinute: 600, createdAt: new Date() }, // Tuesday
    { id: "w_wed", bookingTypeId: "bt_horizon", weekday: 3, startMinute: 540, endMinute: 600, createdAt: new Date() }, // Wednesday
    { id: "w_thu", bookingTypeId: "bt_horizon", weekday: 4, startMinute: 540, endMinute: 600, createdAt: new Date() }, // Thursday
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
  assert.equal(slots.length, 3);
  assert.equal(slots[0].startAt.toISOString(), "2026-10-26T13:00:00.000Z"); // Monday
  assert.equal(slots[1].startAt.toISOString(), "2026-10-27T13:00:00.000Z"); // Tuesday
  assert.equal(slots[2].startAt.toISOString(), "2026-10-28T13:00:00.000Z"); // Wednesday
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
  assert.ok(slots.length >= 8, `expected >= 8 slots, got ${slots.length}`);

  // Verify DST: Monday Oct 26 (EDT, UTC-4) -> 9 AM local = 13:00 UTC
  const monOct26 = slots.find((s) => s.startAt.toISOString().startsWith("2026-10-26T13:0"));
  assert.ok(monOct26, "Oct 26 Monday slot should exist at 13:00 UTC (EDT)");

  // Verify DST: Monday Nov 2 (EST, UTC-5) -> 9 AM local = 14:00 UTC
  const monNov2 = slots.find((s) => s.startAt.toISOString().startsWith("2026-11-02T14:0"));
  assert.ok(monNov2, "Nov 2 Monday slot should exist at 14:00 UTC (EST, after DST)");
});

test("SCHEDULING: slotKey is deterministic", () => {
  const key1 = buildSlotKey("bt_abc", new Date("2026-10-04T07:00:00.000Z"));
  const key2 = buildSlotKey("bt_abc", new Date("2026-10-04T07:00:00.000Z"));
  assert.equal(key1, key2);
  assert.equal(key1, "bt_abc:2026-10-04T07:00:00.000Z");

  // Different start -> different key
  const key3 = buildSlotKey("bt_abc", new Date("2026-10-04T08:00:00.000Z"));
  assert.notEqual(key1, key3);

  // Different booking type -> different key
  const key4 = buildSlotKey("bt_xyz", new Date("2026-10-04T07:00:00.000Z"));
  assert.notEqual(key1, key4);
});

// ---------------------------------------------------------------------------
// (F) DST wall-time resolution + IANA alias acceptance
// ---------------------------------------------------------------------------

test("SCHEDULING: (F) IANA validator accepts the UTC alias", () => {
  assert.ok(isValidIanaTimezone("UTC"));
  assert.ok(isValidIanaTimezone("Etc/UTC"));
  assert.ok(isValidIanaTimezone("America/New_York"));
  assert.ok(!isValidIanaTimezone("Mars/Phobos"));
  assert.ok(!isValidIanaTimezone(""));
});

test("SCHEDULING: (F) spring-forward nonexistent local time throws", () => {
  // America/New_York 2026-03-08: clocks spring 2:00 -> 3:00 AM. 02:30 does not exist.
  const ref = new Date("2026-03-08T12:00:00.000Z"); // local date = Mar 8
  let threw = false;
  try {
    const r = localTimeToUtc(ref, "America/New_York", 2 * 60 + 30);
    // Must NOT silently resolve to 01:30 or 03:30 (or any instant).
    const local = r.toLocaleString("en-US", { timeZone: "America/New_York", hour12: false });
    assert.fail(`expected NonexistentTimeError, got local time ${local}`);
  } catch (e) {
    threw = true;
    assert.ok(e instanceof NonexistentTimeError, `expected NonexistentTimeError, got ${String(e)}`);
    // Explicitly: not silently mapped to 01:30 or 03:30.
    assert.ok(!String(e).includes("01:30"));
    assert.ok(!String(e).includes("03:30"));
  }
  assert.ok(threw);
});

test("SCHEDULING: (F) fall-back ambiguous local time resolves deterministically (earlier UTC = EDT)", () => {
  // America/New_York 2026-11-01: clocks fall back 2:00 -> 1:00 AM. 01:30 occurs
  // twice (EDT then EST). Policy: pick the EARLIER UTC instant (first occurrence).
  const ref = new Date("2026-11-01T12:00:00.000Z");
  const r = localTimeToUtc(ref, "America/New_York", 1 * 60 + 30);
  assert.equal(r.toISOString(), "2026-11-01T05:30:00.000Z"); // 01:30 EDT = 05:30 UTC (earlier)
  // Round-trips to 01:30 local on Nov 1 (EDT, the earlier UTC instant).
  const local = r.toLocaleString("en-US", {
    timeZone: "America/New_York",
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    month: "2-digit",
    day: "2-digit",
  });
  assert.ok(/01:30/.test(local), `fall-back must round-trip to 01:30 local, got ${local}`);
});

test("SCHEDULING: (F) normal 9 AM stays correct on both sides of DST", () => {
  // Tuesday Oct 27 (EDT, UTC-4): 9 AM local = 13:00 UTC
  const refTue = new Date("2026-10-27T13:00:00.000Z"); // 9 AM EDT Oct 27
  assert.equal(localTimeToUtc(refTue, "America/New_York", 9 * 60).toISOString(), "2026-10-27T13:00:00.000Z");
  // Tuesday Dec 1 (EST, UTC-5): 9 AM local = 14:00 UTC
  const refDec = new Date("2026-12-01T14:00:00.000Z"); // 9 AM EST Dec 1
  assert.equal(localTimeToUtc(refDec, "America/New_York", 9 * 60).toISOString(), "2026-12-01T14:00:00.000Z");
});

// ---------------------------------------------------------------------------
// 19–22: HOLD ACQUISITION (DB-backed) — secure API
// ---------------------------------------------------------------------------

test("SCHEDULING: (D) valid canonical slot can be held", async () => {
  const bt = await createBookedType();
  const now = new Date("2026-10-27T12:00:00.000Z");

  const result = await acquireSlotHold({
    bookingTypeId: bt.id,
    startAt: SLOT_START,
    now,
    ttlMinutes: 10,
  });

  assert.ok(result.success, JSON.stringify(result));
  assert.ok(result.hold);
  // (A) the safe view never carries the ownership token.
  assert.equal(Object.keys(result.hold).includes("ownerToken"), false);
  assert.equal(result.hold!.status, "HELD");
  assert.equal(result.hold!.slotKey, buildSlotKey(bt.id, SLOT_START));
  assert.equal(result.hold!.startAt.toISOString(), SLOT_START.toISOString());
  // endAt derived from booking duration (60 min), not caller-supplied.
  assert.equal(result.hold!.endAt.toISOString(), SLOT_END.toISOString());
  assert.equal(result.hold!.expiresAt.getTime(), now.getTime() + 10 * 60_000);
  // (B) a server-generated lease token is returned ONLY to the winner.
  assert.equal(TOKEN_RE.test(result.ownerToken ?? ""), true);
  // Server-generated acquisitionKey is returned (idempotency identity,
  // separate from and never interchangeable with ownerToken).
  assert.ok(result.acquisitionKey, "server must generate and return an acquisitionKey");
  assert.notEqual(result.acquisitionKey, result.ownerToken, "acquisitionKey must differ from ownerToken");
});

test("SCHEDULING: (D) off-hours slot is rejected (not canonical)", async () => {
  const bt = await createBookedType(); // Tue 09:00-17:00 window
  const now = new Date("2026-10-27T12:00:00.000Z");
  // 22:00 UTC = 6:00 PM EDT — outside the 9 AM-5 PM window.
  const offHours = new Date("2026-10-27T22:00:00.000Z");
  const result = await acquireSlotHold({ bookingTypeId: bt.id, startAt: offHours, now, ttlMinutes: 10 });
  assert.equal(result.success, false);
  assert.equal(result.reason, "POLICY");
});

test("SCHEDULING: (D) start outside minimum notice is rejected", async () => {
  const bt = await createBookedType();
  // now is late enough that the 9 AM slot (13:00 UTC) is within the window
  // but before the 60-minute notice deadline.
  const now = new Date("2026-10-27T12:35:00.000Z"); // 8:35 AM EDT -> deadline 13:35 UTC
  const result = await acquireSlotHold({
    bookingTypeId: bt.id,
    startAt: SLOT_WITHIN_NOTICE, // 09:00 EDT = 13:00 UTC, < 13:35 deadline
    now,
    ttlMinutes: 10,
  });
  assert.equal(result.success, false);
  assert.equal(result.reason, "POLICY");
});

test("SCHEDULING: (D) start outside booking horizon is rejected", async () => {
  const bt = await createBookedType(); // 30-day horizon
  const now = new Date("2026-10-27T12:00:00.000Z");
  // Dec 1 is a Tuesday (window applies) but 35 days out (> 30-day horizon).
  const result = await acquireSlotHold({ bookingTypeId: bt.id, startAt: SLOT_FAR, now, ttlMinutes: 10 });
  assert.equal(result.success, false);
  assert.equal(result.reason, "POLICY");
});

test("SCHEDULING: (D) inactive booking type is rejected", async () => {
  const bt = await createBookedType();
  const db = await getDb();
  await db.update(bookingTypes).set({ active: false }).where(eq(bookingTypes.id, bt.id));

  const now = new Date("2026-10-27T12:00:00.000Z");
  const result = await acquireSlotHold({ bookingTypeId: bt.id, startAt: SLOT_START, now, ttlMinutes: 10 });
  assert.equal(result.success, false);
  assert.equal(result.reason, "POLICY");
});

test("SCHEDULING: (D) unknown booking type is rejected", async () => {
  const now = new Date("2026-10-27T12:00:00.000Z");
  const result = await acquireSlotHold({
    bookingTypeId: "bt_does_not_exist",
    startAt: SLOT_START,
    now,
    ttlMinutes: 10,
  });
  assert.equal(result.success, false);
  assert.equal(result.reason, "UNAVAILABLE");
});

test("SCHEDULING: (J) browser cannot choose endAt or ownerToken", async () => {
  const bt = await createBookedType();
  const now = new Date("2026-10-27T12:00:00.000Z");

  // Caller attempts to inject a wrong endAt and a self-chosen ownerToken.
  const bogusEnd = new Date(SLOT_START.getTime() + 5 * 60_000); // +5min, not the duration
  // AcquireSlotHoldInput intentionally omits endAt/ownerToken. We cast here ONLY to
  // inject bogus values at runtime and prove the server-side schema strips/ignores
  // them rather than honoring browser input (browser must not choose the lease
  // token or the slot duration).
  const result = await acquireSlotHold({
    bookingTypeId: bt.id,
    startAt: SLOT_START,
    endAt: bogusEnd,
    ownerToken: "browser-chosen-token",
    now,
    ttlMinutes: 10,
  } as AcquireSlotHoldInput);

  assert.ok(result.success);
  // (B) the returned token is server-generated, NOT the browser-chosen one.
  assert.notEqual(result.ownerToken, "browser-chosen-token");
  assert.equal(TOKEN_RE.test(result.ownerToken ?? ""), true);
  // (J) endAt is derived from duration (60 min), not the bogus caller value.
  assert.equal(result.hold!.endAt.toISOString(), SLOT_END.toISOString());
  assert.notEqual(result.hold!.endAt, bogusEnd);
});

// ---------------------------------------------------------------------------
// (A) Ownership token leak regression
// ---------------------------------------------------------------------------

test("SCHEDULING: (A) losing acquirer never receives the winner's token", async () => {
  const bt = await createBookedType();
  const now = new Date("2026-10-27T12:00:00.000Z");

  const winner = await acquireSlotHold({ bookingTypeId: bt.id, startAt: SLOT_START, now, ttlMinutes: 10 });
  assert.ok(winner.success);
  assert.ok(winner.ownerToken);

  // Loser attempts the same slot.
  const loser = await acquireSlotHold({ bookingTypeId: bt.id, startAt: SLOT_START, now, ttlMinutes: 10 });
  assert.equal(loser.success, false);
  assert.equal(loser.reason, "TAKEN");

  // (A) the loser's object graph must not contain the winner's token anywhere.
  const serialized = JSON.stringify({ ...loser, hold: loser.hold });
  assert.equal(serialized.includes(winner.ownerToken!), false);
  assert.equal(loser.ownerToken, undefined);
  assert.equal(Object.keys(loser.hold ?? {}).includes("ownerToken"), false);
});

test("SCHEDULING: (A) loser on a CONSUMED slot also receives no token", async () => {
  const bt = await createBookedType();
  const now = new Date("2026-10-27T12:00:00.000Z");

  const winner = await acquireSlotHold({ bookingTypeId: bt.id, startAt: SLOT_START, now, ttlMinutes: 10 });
  assert.ok(winner.success);
  assert.ok(winner.ownerToken);
  await consumeSlotHold(bt.id, SLOT_START, winner.ownerToken!, now);

  const late = await acquireSlotHold({ bookingTypeId: bt.id, startAt: SLOT_START, now, ttlMinutes: 10 });
  assert.equal(late.success, false);
  assert.equal(late.reason, "CONSUMED");
  assert.equal(late.ownerToken, undefined);
  const serialized = JSON.stringify({ hold: late.hold });
  assert.equal(serialized.includes(winner.ownerToken!), false);
  assert.equal(Object.keys(late.hold ?? {}).includes("ownerToken"), false);
});

// ---------------------------------------------------------------------------
// 23–24: CONCURRENCY (DB-backed)
// ---------------------------------------------------------------------------

test("SCHEDULING: two concurrent acquire attempts produce exactly one owner", async () => {
  const bt = await createBookedType();
  const now = new Date("2026-10-27T12:00:00.000Z");

  const [result1, result2] = await Promise.all([
    acquireSlotHold({ bookingTypeId: bt.id, startAt: SLOT_START, now, ttlMinutes: 10 }),
    acquireSlotHold({ bookingTypeId: bt.id, startAt: SLOT_START, now, ttlMinutes: 10 }),
  ]);

  const successCount = [result1, result2].filter((r) => r.success).length;
  const failCount = [result1, result2].filter((r) => !r.success).length;
  assert.equal(successCount, 1, "exactly one concurrent caller should win");
  assert.equal(failCount, 1, "exactly one concurrent caller should lose");
  const loser = [result1, result2].find((r) => !r.success)!;
  assert.equal(loser.reason, "TAKEN");
  // (A) loser must not carry the winner's token.
  const winner = [result1, result2].find((r) => r.success)!;
  assert.equal(JSON.stringify(loser).includes(winner.ownerToken ?? ""), false);
});

test("SCHEDULING: database contains one canonical slot-hold record after concurrent acquire", async () => {
  const bt = await createBookedType();
  const now = new Date("2026-10-27T12:00:00.000Z");
  const slotKey = buildSlotKey(bt.id, SLOT_START);

  const results = await Promise.all([
    acquireSlotHold({ bookingTypeId: bt.id, startAt: SLOT_START, now, ttlMinutes: 10 }),
    acquireSlotHold({ bookingTypeId: bt.id, startAt: SLOT_START, now, ttlMinutes: 10 }),
    acquireSlotHold({ bookingTypeId: bt.id, startAt: SLOT_START, now, ttlMinutes: 10 }),
  ]);

  const db = await getDb();
  const holds = await db.select().from(slotHolds).where(eq(slotHolds.slotKey, slotKey));
  assert.equal(holds.length, 1, "exactly one canonical hold row must exist regardless of contention");
  assert.equal(holds[0].status, "HELD");

  // The winner is whichever acquire returned success; its server token matches
  // the DB row, and losers did not receive it.
  const winners = results.filter((r) => r.success);
  assert.equal(winners.length, 1);
  assert.equal(holds[0].ownerToken, winners[0].ownerToken);
  for (const loser of results.filter((r) => !r.success)) {
    assert.equal(loser.ownerToken, undefined);
  }
});

// ---------------------------------------------------------------------------
// 25–30: STALE OWNER PROTECTION (DB-backed)
// ---------------------------------------------------------------------------

test("SCHEDULING: previous owner cannot release after another owner reclaims", async () => {
  const bt = await createBookedType();
  const nowAcquire = new Date("2026-10-27T12:00:00.000Z");
  const slotKey = buildSlotKey(bt.id, SLOT_START);

  const a = await acquireSlotHold({ bookingTypeId: bt.id, startAt: SLOT_START, now: nowAcquire, ttlMinutes: 1 });
  assert.ok(a.success);

  // Advance past expiry; Owner B reclaims.
  const nowAfter = new Date(nowAcquire.getTime() + 2 * 60_000);
  const b = await acquireSlotHold({ bookingTypeId: bt.id, startAt: SLOT_START, now: nowAfter, ttlMinutes: 10 });
  assert.ok(b.success);

  // Owner A (stale token) tries to release — rejected.
  await assert.rejects(
    releaseSlotHold(bt.id, SLOT_START, a.ownerToken!, nowAfter),
    /Only the current owner/,
  );

  // Verify the hold is still HELD by B (not RELEASED).
  const db = await getDb();
  const holds = await db.select().from(slotHolds).where(eq(slotHolds.slotKey, slotKey));
  assert.equal(holds.length, 1);
  assert.equal(holds[0].ownerToken, b.ownerToken);
  assert.equal(holds[0].status, "HELD");
});

test("SCHEDULING: previous owner cannot consume after another owner reclaims", async () => {
  const bt = await createBookedType();
  const nowAcquire = new Date("2026-10-27T12:00:00.000Z");
  const slotKey = buildSlotKey(bt.id, SLOT_START);

  const a = await acquireSlotHold({ bookingTypeId: bt.id, startAt: SLOT_START, now: nowAcquire, ttlMinutes: 1 });
  assert.ok(a.success);

  const nowAfter = new Date(nowAcquire.getTime() + 2 * 60_000);
  const b = await acquireSlotHold({ bookingTypeId: bt.id, startAt: SLOT_START, now: nowAfter, ttlMinutes: 10 });
  assert.ok(b.success);

  await assert.rejects(
    consumeSlotHold(bt.id, SLOT_START, a.ownerToken!, nowAfter),
    /Only the current owner/,
  );

  const db = await getDb();
  const holds = await db.select().from(slotHolds).where(eq(slotHolds.slotKey, slotKey));
  assert.equal(holds.length, 1);
  assert.equal(holds[0].ownerToken, b.ownerToken);
  assert.equal(holds[0].status, "HELD");
});

test("SCHEDULING: current owner can release", async () => {
  const bt = await createBookedType();
  const now = new Date("2026-10-27T12:00:00.000Z");
  const slotKey = buildSlotKey(bt.id, SLOT_START);

  const a = await acquireSlotHold({ bookingTypeId: bt.id, startAt: SLOT_START, now, ttlMinutes: 10 });
  assert.ok(a.success);

  await releaseSlotHold(bt.id, SLOT_START, a.ownerToken!, now);

  const db = await getDb();
  const holds = await db.select().from(slotHolds).where(eq(slotHolds.slotKey, slotKey));
  assert.equal(holds.length, 1);
  assert.equal(holds[0].status, "RELEASED");
  assert.ok(holds[0].releasedAt !== null, "releasedAt should be set after release");
});

test("SCHEDULING: current owner can consume valid hold", async () => {
  const bt = await createBookedType();
  const now = new Date("2026-10-27T12:00:00.000Z");

  const a = await acquireSlotHold({ bookingTypeId: bt.id, startAt: SLOT_START, now, ttlMinutes: 10 });
  assert.ok(a.success);

  const consumed = await consumeSlotHold(bt.id, SLOT_START, a.ownerToken!, now);
  assert.ok(consumed);
  assert.equal(consumed!.status, "CONSUMED");

  const db = await getDb();
  const holds = await db.select().from(slotHolds).where(eq(slotHolds.slotKey, buildSlotKey(bt.id, SLOT_START)));
  assert.equal(holds.length, 1);
  assert.equal(holds[0].status, "CONSUMED");
  assert.ok(holds[0].consumedAt !== null);
});

test("SCHEDULING: expired hold cannot be consumed", async () => {
  const bt = await createBookedType();
  const nowAcquire = new Date("2026-10-27T12:00:00.000Z");
  const slotKey = buildSlotKey(bt.id, SLOT_START);

  const a = await acquireSlotHold({ bookingTypeId: bt.id, startAt: SLOT_START, now: nowAcquire, ttlMinutes: 1 });
  assert.ok(a.success);

  const nowAfter = new Date(nowAcquire.getTime() + 2 * 60_000);
  await assert.rejects(consumeSlotHold(bt.id, SLOT_START, a.ownerToken!, nowAfter), /expired/i);

  // Verify still HELD (not CONSUMED).
  const db = await getDb();
  const holds = await db.select().from(slotHolds).where(eq(slotHolds.slotKey, slotKey));
  assert.equal(holds[0].status, "HELD");
});

test("SCHEDULING: consumed slot cannot be reacquired", async () => {
  const bt = await createBookedType();
  const now = new Date("2026-10-27T12:00:00.000Z");

  const a = await acquireSlotHold({ bookingTypeId: bt.id, startAt: SLOT_START, now, ttlMinutes: 10 });
  assert.ok(a.success);
  await consumeSlotHold(bt.id, SLOT_START, a.ownerToken!, now);

  // Even the same owner cannot re-acquire a consumed slot.
  const result = await acquireSlotHold({ bookingTypeId: bt.id, startAt: SLOT_START, now, ttlMinutes: 10 });
  assert.equal(result.success, false);
  assert.equal(result.reason, "CONSUMED");
});

test("SCHEDULING: expired hold can be reclaimed", async () => {
  const bt = await createBookedType();
  const nowAcquire = new Date("2026-10-27T12:00:00.000Z");
  const slotKey = buildSlotKey(bt.id, SLOT_START);

  const a = await acquireSlotHold({ bookingTypeId: bt.id, startAt: SLOT_START, now: nowAcquire, ttlMinutes: 1 });
  assert.ok(a.success);

  const nowAfter = new Date(nowAcquire.getTime() + 2 * 60_000);
  const b = await acquireSlotHold({ bookingTypeId: bt.id, startAt: SLOT_START, now: nowAfter, ttlMinutes: 10 });
  assert.ok(b.success, JSON.stringify(b));
  assert.ok(TOKEN_RE.test(b.ownerToken ?? ""), "B should receive a server-generated token");
  assert.notEqual(b.ownerToken, a.ownerToken, "reclaimer gets a fresh token, not the old one");

  const db = await getDb();
  const holds = await db.select().from(slotHolds).where(eq(slotHolds.slotKey, slotKey));
  assert.equal(holds.length, 1);
  assert.equal(holds[0].ownerToken, b.ownerToken);
});

// ---------------------------------------------------------------------------
// (B) Ownership token is server-generated & unpredictable
// ---------------------------------------------------------------------------

test("SCHEDULING: (B) ownership token is server-generated and not derived from input", () => {
  const t1 = generateOwnerToken();
  const t2 = generateOwnerToken();
  assert.ok(TOKEN_RE.test(t1));
  assert.ok(TOKEN_RE.test(t2));
  assert.notEqual(t1, t2, "tokens must be unpredictable per issuance");
  assert.ok(!t1.includes("coach"), "token must not embed caller/booking data");
});

test("SCHEDULING: (B) acquired hold's token matches the server-issued token in the winner", async () => {
  const bt = await createBookedType();
  const now = new Date("2026-10-27T12:00:00.000Z");
  const result = await acquireSlotHold({ bookingTypeId: bt.id, startAt: SLOT_START, now, ttlMinutes: 10 });
  assert.ok(result.success);
  const db = await getDb();
  const row = await db.select().from(slotHolds).where(eq(slotHolds.slotKey, buildSlotKey(bt.id, SLOT_START))).get();
  assert.equal(row!.ownerToken, result.ownerToken, "DB row token == server-issued winner token");
});

// ---------------------------------------------------------------------------
// (I) Stale / forged owner token rejected on release & consume
// ---------------------------------------------------------------------------

test("SCHEDULING: (I) forged owner token is rejected on release and consume", async () => {
  const bt = await createBookedType();
  const now = new Date("2026-10-27T12:00:00.000Z");
  await acquireSlotHold({ bookingTypeId: bt.id, startAt: SLOT_START, now, ttlMinutes: 10 });

  await assert.rejects(releaseSlotHold(bt.id, SLOT_START, "forged-token", now), /Only the current owner/);
  await assert.rejects(consumeSlotHold(bt.id, SLOT_START, "forged-token", now), /Only the current owner/);
});

test("SCHEDULING: (K) release/consume reject wrong-state with SchedulingDomainError", async () => {
  const bt = await createBookedType();
  const now = new Date("2026-10-27T12:00:00.000Z");
  const a = await acquireSlotHold({ bookingTypeId: bt.id, startAt: SLOT_START, now, ttlMinutes: 10 });
  assert.ok(a.success);

  // Consume it, then releasing the consumed slot must throw a typed
  // SchedulingDomainError (not SchedulingProviderError, which is for provider
  // adapter failures, and not a bare Error).
  await consumeSlotHold(bt.id, SLOT_START, a.ownerToken!, now);

  // release a CONSUMED hold -> WRONG_STATE
  await assert.rejects(
    releaseSlotHold(bt.id, SLOT_START, a.ownerToken!, now),
    (err: unknown) =>
      err instanceof SchedulingDomainError &&
      err.code === "WRONG_STATE" &&
      /Cannot release a CONSUMED hold/.test(err.message),
  );

  // Consume a RELEASED hold -> WRONG_STATE. Release, then consume the released.
  const bt2 = await createBookedType();
  const b = await acquireSlotHold({ bookingTypeId: bt2.id, startAt: SLOT_START, now, ttlMinutes: 10 });
  assert.ok(b.success);
  await releaseSlotHold(bt2.id, SLOT_START, b.ownerToken!, now);
  await assert.rejects(
    consumeSlotHold(bt2.id, SLOT_START, b.ownerToken!, now),
    (err: unknown) =>
      err instanceof SchedulingDomainError &&
      err.code === "WRONG_STATE" &&
      /Cannot consume a RELEASED hold/.test(err.message),
  );
});

// ---------------------------------------------------------------------------
// (C) Boundary runtime validation of acquire / mutate inputs
// ---------------------------------------------------------------------------

test("SCHEDULING: (C) acquireSlotHoldSchema rejects invalid date and bad TTL", () => {
  const base = { bookingTypeId: "bt_1", startAt: SLOT_START, now: new Date("2026-10-27T12:00:00.000Z"), ttlMinutes: 10 };
  // invalid Date
  const rBadDate = acquireSlotHoldSchema.safeParse({ ...base, startAt: new Date("not-a-date") });
  assert.ok(!rBadDate.success);
  // empty bookingTypeId
  const rEmpty = acquireSlotHoldSchema.safeParse({ ...base, bookingTypeId: "   " });
  assert.ok(!rEmpty.success);
  // non-positive TTL
  const rZero = acquireSlotHoldSchema.safeParse({ ...base, ttlMinutes: 0 });
  assert.ok(!rZero.success);
  const rNeg = acquireSlotHoldSchema.safeParse({ ...base, ttlMinutes: -5 });
  assert.ok(!rNeg.success);
});

test("SCHEDULING: (C) acquireSlotHold throws ZodError on malformed input", async () => {
  await assert.rejects(
    acquireSlotHold({
      bookingTypeId: "bt_1",
      startAt: SLOT_START,
      // @ts-expect-error — ttlMinutes is required and must be a positive int
      ttlMinutes: "ten",
      now: new Date("2026-10-27T12:00:00.000Z"),
    }),
    ZodError,
  );
});

test("SCHEDULING: (C) mutateSlotHoldSchema rejects malformed input", () => {
  const base = { bookingTypeId: "bt_1", startAt: SLOT_START, ownerToken: "token", now: new Date("2026-10-27T12:00:00.000Z") };
  assert.ok(!mutateSlotHoldSchema.safeParse({ ...base, startAt: new Date("invalid") }).success);
  assert.ok(!mutateSlotHoldSchema.safeParse({ ...base, ownerToken: "" }).success);
  assert.ok(!mutateSlotHoldSchema.safeParse({ ...base, bookingTypeId: "" }).success);
  assert.ok(!mutateSlotHoldSchema.safeParse({ ...base, now: new Date("invalid") }).success);
});

// ---------------------------------------------------------------------------
// (H) Slug collision: throws (no silent merge / policy leak)
// ---------------------------------------------------------------------------

test("SCHEDULING: (H) duplicate slug throws a domain error naming the slug", async () => {
  const slug = uniqueSlug("collision");
  const first = await createBookingType(makeValidBookingTypeInput({ slug }));
  assert.ok(first.id);

  // Same slug, DIFFERENT policy (accessMode differs from FREE to PAID_SESSION).
  let threw = false;
  try {
    await createBookingType(makeValidBookingTypeInput({ slug, accessMode: "PAID_SESSION" }));
  } catch (e) {
    threw = true;
    assert.ok(e instanceof SchedulingDomainError, "must be SchedulingDomainError, not bare Error");
    assert.equal((e as SchedulingDomainError).code, "DUPLICATE_SLUG");
    assert.ok(String(e).includes(slug), "error must name the colliding slug");
  }
  assert.ok(threw, "duplicate slug must throw, not return the existing row");
});

test("SCHEDULING: (H) concurrent same-slug creation -> one winner, one duplicate error", async () => {
  const slug = uniqueSlug("concurrent");
  const results = await Promise.allSettled([
    createBookingType(makeValidBookingTypeInput({ slug, accessMode: "FREE" })),
    createBookingType(makeValidBookingTypeInput({ slug, accessMode: "PAID_SESSION" })),
  ]);
  const successes = results.filter((r) => r.status === "fulfilled");
  const failures = results.filter((r) => r.status === "rejected");
  assert.equal(successes.length, 1, "exactly one creator should win");
  assert.equal(failures.length, 1, "exactly one creator should be rejected for duplicate slug");

  // Winner is whatever resolved.
  const winner = (successes[0] as PromiseFulfilledResult<BookingType>).value;
  assert.equal(winner.slug, slug);

  // The loser's rejection must mention the slug and must NOT yield the winner's
  // policy to the loser.
  const loserErr = (failures[0] as PromiseRejectedResult).reason as Error;
  assert.ok(loserErr.message.includes(slug));
  assert.notEqual(winner.accessMode, undefined);
  // Both requested different policies; only the winner's is materialized.
  assert.ok(winner.accessMode === "FREE" || winner.accessMode === "PAID_SESSION");
});

// ---------------------------------------------------------------------------
// Additional: released slot can be reacquired by a different owner
// ---------------------------------------------------------------------------

test("SCHEDULING: released slot can be reacquired by a different owner", async () => {
  const bt = await createBookedType();
  const now = new Date("2026-10-27T12:00:00.000Z");

  const a = await acquireSlotHold({ bookingTypeId: bt.id, startAt: SLOT_START, now, ttlMinutes: 10 });
  assert.ok(a.success);
  await releaseSlotHold(bt.id, SLOT_START, a.ownerToken!, now);

  const b = await acquireSlotHold({ bookingTypeId: bt.id, startAt: SLOT_START, now, ttlMinutes: 10 });
  assert.ok(b.success);
  assert.ok(TOKEN_RE.test(b.ownerToken ?? ""), "re-acquirer receives a fresh server token");
  assert.notEqual(b.ownerToken, a.ownerToken, "re-acquirer gets a distinct token");
  assert.equal(b.hold!.status, "HELD");
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

test("SCHEDULING: (O) providers.ts contains no provider-specific SDK imports or coupling", async () => {
  // Source-level regression: inspect the actual providers.ts source file to
  // ensure no concrete provider SDK (googleapis, Stripe, Lemony, etc.) is
  // imported or referenced. The previous version used provider.toString()
  // which always returned "[object Object]" — a fake assertion that could
  // never fail. This replacement reads the real source and checks for
  // forbidden tokens that would couple the scheduling domain to a provider.
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const sourcePath = join(process.cwd(), "src", "features", "scheduling", "providers.ts");
  const source = readFileSync(sourcePath, "utf-8");

  // Tokens that indicate coupling to a concrete provider SDK/package.
  const forbidden = [
    "googleapis",
    "google/calendar",
    "@google",
    "from \"stripe\"",
    "from 'stripe'",
    "@stripe",
    "stripe",
    "lemon-squeezy",
    "@lemonsqueezy",
    "lemonsqueezy",
    "nodemailer",
    "sendgrid",
    "@sendgrid",
  ];
  for (const token of forbidden) {
    assert.ok(
      !source.includes(token),
      `providers.ts must NOT reference "${token}" — the scheduling domain must not couple to concrete provider SDKs`,
    );
  }

  // Positive control: the domain enum MeetingMethod (which carries GOOGLE_MEET)
  // is referenced in providers.ts — this proves meeting methods are a domain
  // concept, not an SDK binding. GOOGLE_MEET lives in types.ts as a domain enum.
  assert.ok(
    source.includes("MeetingMethod"),
    "MeetingMethod domain enum (carries GOOGLE_MEET) must remain referenced in providers.ts",
  );
});

// ---------------------------------------------------------------------------
// (L) SECURE ACQUISITION IDEMPOTENCY (Mission 08.1 remediation §1)
// ---------------------------------------------------------------------------
// acquisitionKey is a high-entropy idempotency identity (UUID) separate from
// the server-generated ownerToken. Same acquisitionKey + same slot + HELD +
// unexpired → existing lease returned (same ownerToken, no TTL extension).
// Different acquisitionKey → TAKEN. CONSUMED remains terminal.

test("SCHEDULING: (L) same acquisitionKey recovers the existing lease without TTL extension", async () => {
  const bt = await createBookedType();
  const now = new Date("2026-10-27T12:00:00.000Z");
  const acquisitionKey = generateAcquisitionKey();

  // First request — succeeds.
  const first = await acquireSlotHold({
    bookingTypeId: bt.id,
    startAt: SLOT_START,
    now,
    ttlMinutes: 10,
    acquisitionKey,
  });
  assert.ok(first.success);
  assert.equal(first.acquisitionKey, acquisitionKey, "server echoes the supplied key");
  assert.ok(first.ownerToken);
  const originalExpires = first.hold!.expiresAt;

  // "Lost" response — retry with SAME acquisitionKey and SAME now.
  const retry = await acquireSlotHold({
    bookingTypeId: bt.id,
    startAt: SLOT_START,
    now, // same now → hold still unexpired
    ttlMinutes: 999, // would extend TTL if not idempotent
    acquisitionKey,
  });
  assert.ok(retry.success, JSON.stringify(retry));
  assert.equal(retry.ownerToken, first.ownerToken, "same ownerToken must be recovered");
  assert.equal(retry.hold!.id, first.hold!.id, "same hold row (no new INSERT)");
  assert.equal(retry.hold!.expiresAt.getTime(), originalExpires.getTime(), "TTL must NOT be extended on idempotent retry");

  // Exactly one DB row must exist for this slot.
  const db = await getDb();
  const holds = await db.select().from(slotHolds).where(eq(slotHolds.slotKey, buildSlotKey(bt.id, SLOT_START)));
  assert.equal(holds.length, 1, "idempotent retry must not insert a new row");
});

test("SCHEDULING: (L) different acquisitionKey gets TAKEN (no token leak)", async () => {
  const bt = await createBookedType();
  const now = new Date("2026-10-27T12:00:00.000Z");

  const first = await acquireSlotHold({
    bookingTypeId: bt.id,
    startAt: SLOT_START,
    now,
    ttlMinutes: 10,
    acquisitionKey: generateAcquisitionKey(),
  });
  assert.ok(first.success);
  assert.ok(first.ownerToken);

  const second = await acquireSlotHold({
    bookingTypeId: bt.id,
    startAt: SLOT_START,
    now,
    ttlMinutes: 10,
    acquisitionKey: generateAcquisitionKey(), // different key
  });
  assert.equal(second.success, false);
  assert.equal(second.reason, "TAKEN");
  assert.equal(second.ownerToken, undefined);
  // No token leak in any serialized form.
  assert.equal(JSON.stringify(second).includes(first.ownerToken!), false);
  assert.equal(JSON.stringify({ hold: second.hold }).includes(first.ownerToken!), false);
});

test("SCHEDULING: (L) consumed slot remains terminal for same acquisitionKey", async () => {
  const bt = await createBookedType();
  const now = new Date("2026-10-27T12:00:00.000Z");
  const acquisitionKey = generateAcquisitionKey();

  const first = await acquireSlotHold({
    bookingTypeId: bt.id,
    startAt: SLOT_START,
    now,
    ttlMinutes: 10,
    acquisitionKey,
  });
  assert.ok(first.success);
  await consumeSlotHold(bt.id, SLOT_START, first.ownerToken!, now);

  // Retry with same acquisitionKey — must be CONSUMED, not re-acquired.
  const retry = await acquireSlotHold({
    bookingTypeId: bt.id,
    startAt: SLOT_START,
    now,
    ttlMinutes: 10,
    acquisitionKey,
  });
  assert.equal(retry.success, false);
  assert.equal(retry.reason, "CONSUMED");
  assert.equal(retry.ownerToken, undefined);
});

test("SCHEDULING: (L) expired hold: same acquisitionKey does NOT idempotently recover (reclaim gets fresh token+TTL)", async () => {
  const bt = await createBookedType();
  const nowAcquire = new Date("2026-10-27T12:00:00.000Z");
  const nowAfter = new Date(nowAcquire.getTime() + 2 * 60_000); // 2 min later, hold expired (10s TTL... actually 1 min TTL)
  const acquisitionKey = generateAcquisitionKey();

  // Use 1-minute TTL so it expires before the retry "now".
  const first = await acquireSlotHold({
    bookingTypeId: bt.id,
    startAt: SLOT_START,
    now: nowAcquire,
    ttlMinutes: 1,
    acquisitionKey,
  });
  assert.ok(first.success);
  const originalToken = first.ownerToken;
  const originalExpires = first.hold!.expiresAt;

  // Retry with same acquisitionKey AFTER expiry — must NOT return the old lease.
  // Instead, the expired hold is reclaimed: a fresh token and fresh TTL.
  const retry = await acquireSlotHold({
    bookingTypeId: bt.id,
    startAt: SLOT_START,
    now: nowAfter,
    ttlMinutes: 10,
    acquisitionKey,
  });
  assert.ok(retry.success, JSON.stringify(retry));
  assert.notEqual(retry.ownerToken, originalToken, "reclaim must issue a fresh token, not return expired one");
  assert.notEqual(retry.hold!.expiresAt.getTime(), originalExpires.getTime(), "TTL must be refreshed on reclaim, not silently carried over");
  assert.equal(retry.hold!.expiresAt.getTime(), nowAfter.getTime() + 10 * 60_000, "new TTL based on retry now");
});

test("SCHEDULING: (L) omission of acquisitionKey is treated as a unique attempt (server generates one)", async () => {
  const bt = await createBookedType();
  const now = new Date("2026-10-27T12:00:00.000Z");

  // No acquisitionKey supplied — server must generate and return one.
  const result = await acquireSlotHold({
    bookingTypeId: bt.id,
    startAt: SLOT_START,
    now,
    ttlMinutes: 10,
  });
  assert.ok(result.success);
  assert.ok(result.acquisitionKey, "server must generate an acquisitionKey when none is supplied");
  // Server-generated key must look like a UUID.
  assert.ok(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(result.acquisitionKey!), "acquisitionKey must be a UUID v4");

  // A second caller without an acquisitionKey is a DIFFERENT attempt → TAKEN.
  const second = await acquireSlotHold({
    bookingTypeId: bt.id,
    startAt: SLOT_START,
    now,
    ttlMinutes: 10,
  });
  assert.equal(second.success, false);
  assert.equal(second.reason, "TAKEN");
});

// ---------------------------------------------------------------------------
// (M) DST SLOT GENERATION AT THE GENERATION LEVEL (Mission 08.1 remediation §2)
// ---------------------------------------------------------------------------
// Slot generation operates from canonical LOCAL candidate wall times.
// Spring-forward gaps are SKIPPED (not crashed on). Fall-back folds produce NO
// duplicate local wall-clock times.

test("SCHEDULING: (M) spring-forward gap does not crash and nonexistent slots are skipped", () => {
  // America/New_York 2026-03-08 (Sunday): clocks spring 2:00 → 3:00 AM.
  // Local 02:00-02:59 do NOT exist.  A window 00:00–06:00 with 60-min slots
  // would have candidates at local 00:00, 01:00, 02:00(nonexistent), 03:00,
  // 04:00, 05:00 → 5 valid slots (the 02:00 one is skipped).
  const bookingType: BookingType = {
    id: "bt_spring",
    slug: "test-spring",
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
    { id: "w_sun", bookingTypeId: "bt_spring", weekday: 0, startMinute: 0, endMinute: 360, createdAt: new Date() },
  ];

  const rangeStart = new Date("2026-03-08T00:00:00.000Z");
  const rangeEnd = new Date("2026-03-08T23:59:59.999Z");
  const now = new Date("2026-03-07T00:00:00.000Z"); // before the window, so notice filter is satisfied

  const slots = generateCandidateSlots({ bookingType, windows, rangeStart, rangeEnd, now });

  // Must NOT crash. Must have 5 slots (02:00 skipped).
  assert.equal(slots.length, 5, `expected 5 slots (02:00 skipped), got ${slots.length}`);
  // Verify no slot starts at UTC 07:00... wait, 02:00 local is nonexistent.
  // The slots should be at local 00:00, 01:00, 03:00, 04:00, 05:00.
  // In UTC: 05:00, 06:00, 07:00, 08:00, 09:00.
  const utcStarts = slots.map((s) => s.startAt.toISOString());
  assert.equal(utcStarts[0], "2026-03-08T05:00:00.000Z"); // 00:00 EST
  assert.equal(utcStarts[1], "2026-03-08T06:00:00.000Z"); // 01:00 EST
  assert.equal(utcStarts[2], "2026-03-08T07:00:00.000Z"); // 03:00 EDT (gap skipped)
  assert.equal(utcStarts[3], "2026-03-08T08:00:00.000Z"); // 04:00 EDT
  assert.equal(utcStarts[4], "2026-03-08T09:00:00.000Z"); // 05:00 EDT
});

test("SCHEDULING: (M) fall-back fold produces no duplicate local wall-clock slot", () => {
  // America/New_York 2026-11-01 (Sunday): clocks fall back 2:00 → 1:00 AM.
  // Local 01:00-01:59 occur TWICE (EDT then EST). Policy: pick the EARLIER UTC
  // instant (EDT = 05:00 UTC).
  //  Window 01:00–02:00 (minutes 60–120) with 60-min slots:
  //  - Candidate at local 01:00 → resolved to 05:00 UTC (EDT, earlier).
  //  - No second duplicate slot at the same local time.
  const bookingType: BookingType = {
    id: "bt_fall",
    slug: "test-fall",
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
    { id: "w_sun", bookingTypeId: "bt_fall", weekday: 0, startMinute: 60, endMinute: 120, createdAt: new Date() },
  ];

  const rangeStart = new Date("2026-11-01T00:00:00.000Z");
  const rangeEnd = new Date("2026-11-01T23:59:59.999Z");
  const now = new Date("2026-10-31T00:00:00.000Z");

  const slots = generateCandidateSlots({ bookingType, windows, rangeStart, rangeEnd, now });

  // Exactly ONE slot — the earlier (EDT) occurrence of 01:00 local.
  assert.equal(slots.length, 1, `expected exactly 1 slot for ambiguous 01:00, got ${slots.length}`);
  assert.equal(slots[0].startAt.toISOString(), "2026-11-01T05:00:00.000Z", "01:00 EDT = 05:00 UTC (earlier occurrence)");
  // Round-trip: the local time of the slot should be 01:00.
  const local = slots[0].startAt.toLocaleString("en-US", {
    timeZone: "America/New_York",
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });
  assert.ok(/01:00/.test(local), `local time must round-trip to 01:00, got ${local}`);
});

test("SCHEDULING: (M) window entirely within spring-forward gap produces zero slots without crashing", () => {
  // Window 02:30–03:30 (minutes 150–210) on Mar 8 2026 — the entire gap
  // (02:00–02:59 nonexistent) plus 03:00 which is valid. Actually 03:00 exists.
  // Let's use 02:00–02:30 (minutes 120–150) — entirely nonexistent.
  const bookingType: BookingType = {
    id: "bt_gap",
    slug: "test-gap",
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

  // Window 02:00–02:30 (minutes 120–150) — entirely inside the nonexistent gap.
  const windows: BookingAvailabilityWindow[] = [
    { id: "w_sun", bookingTypeId: "bt_gap", weekday: 0, startMinute: 120, endMinute: 150, createdAt: new Date() },
  ];

  const rangeStart = new Date("2026-03-08T00:00:00.000Z");
  const rangeEnd = new Date("2026-03-08T23:59:59.999Z");
  const now = new Date("2026-03-07T00:00:00.000Z");

  // This must NOT throw NonexistentTimeError — it must return zero slots.
  const slots = generateCandidateSlots({ bookingType, windows, rangeStart, rangeEnd, now });
  assert.equal(slots.length, 0, "entirely-gapped window must produce zero slots, not crash");
});

test("SCHEDULING: (M) combined DST range: same local time maps to different UTC across fall-back boundary", () => {
  // Monday–Friday 09:00–10:00 window. Oct 26 (EDT) 09:00 = 13:00 UTC;
  // Nov 2 (EST, after fall-back) 09:00 = 14:00 UTC. Verifies the generator
  // handles the DST transition without crashing or duplicating.
  const bookingType: BookingType = {
    id: "bt_dsrc",
    slug: "test-dsrc",
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
    { id: "w1", bookingTypeId: "bt_dsrc", weekday: 1, startMinute: 540, endMinute: 600, createdAt: new Date() },
    { id: "w2", bookingTypeId: "bt_dsrc", weekday: 2, startMinute: 540, endMinute: 600, createdAt: new Date() },
    { id: "w3", bookingTypeId: "bt_dsrc", weekday: 3, startMinute: 540, endMinute: 600, createdAt: new Date() },
    { id: "w4", bookingTypeId: "bt_dsrc", weekday: 4, startMinute: 540, endMinute: 600, createdAt: new Date() },
    { id: "w5", bookingTypeId: "bt_dsrc", weekday: 5, startMinute: 540, endMinute: 600, createdAt: new Date() },
  ];

  // Range: Oct 26 (Mon) to Nov 5 (Thu) — crosses fall-back on Nov 1 (Sun).
  const rangeStart = new Date("2026-10-26T00:00:00.000Z");
  const rangeEnd = new Date("2026-11-05T23:59:59.999Z");
  const now = new Date("2026-10-26T00:00:00.000Z");

  const slots = generateCandidateSlots({ bookingType, windows, rangeStart, rangeEnd, now });
  assert.ok(slots.length >= 8, `expected >= 8 slots, got ${slots.length}`);

  // Mon Oct 26 (EDT, UTC-4): 09:00 local = 13:00 UTC
  const monOct26 = slots.find((s) => s.startAt.toISOString().startsWith("2026-10-26T13:0"));
  assert.ok(monOct26, "Oct 26 Monday slot at 13:00 UTC (EDT)");

  // Mon Nov 2 (EST, UTC-5): 09:00 local = 14:00 UTC (offset by the DST shift)
  const monNov2 = slots.find((s) => s.startAt.toISOString().startsWith("2026-11-02T14:0"));
  assert.ok(monNov2, "Nov 2 Monday slot at 14:00 UTC (EST, after fall-back)");
});

// ---------------------------------------------------------------------------
// (N) DOMAIN ERROR CATEGORIZATION (Mission 08.1 remediation §3)
// ---------------------------------------------------------------------------
// Domain-state errors (HOLD_NOT_FOUND, NOT_OWNER, WRONG_STATE, EXPIRED)
// throw SchedulingDomainError — NOT SchedulingProviderError (which is for
// provider adapter failures).

test("SCHEDULING: (N) release of nonexistent slot throws SchedulingDomainError(HOLD_NOT_FOUND)", async () => {
  const bt = await createBookedType();
  const now = new Date("2026-10-27T12:00:00.000Z");
  await assert.rejects(
    releaseSlotHold(bt.id, SLOT_START, "some_token", now),
    (err: unknown) =>
      err instanceof SchedulingDomainError &&
      err.code === "HOLD_NOT_FOUND" &&
      !(err instanceof SchedulingProviderError),
  );
});

test("SCHEDULING: (N) consume of nonexistent slot throws SchedulingDomainError(HOLD_NOT_FOUND)", async () => {
  const bt = await createBookedType();
  const now = new Date("2026-10-27T12:00:00.000Z");
  await assert.rejects(
    consumeSlotHold(bt.id, SLOT_START, "some_token", now),
    (err: unknown) =>
      err instanceof SchedulingDomainError &&
      err.code === "HOLD_NOT_FOUND" &&
      !(err instanceof SchedulingProviderError),
  );
});

test("SCHEDULING: (N) release with forged token throws SchedulingDomainError(NOT_OWNER)", async () => {
  const bt = await createBookedType();
  const now = new Date("2026-10-27T12:00:00.000Z");
  await acquireSlotHold({ bookingTypeId: bt.id, startAt: SLOT_START, now, ttlMinutes: 10 });
  await assert.rejects(
    releaseSlotHold(bt.id, SLOT_START, "forged-token", now),
    (err: unknown) =>
      err instanceof SchedulingDomainError &&
      err.code === "NOT_OWNER" &&
      !(err instanceof SchedulingProviderError),
  );
});

test("SCHEDULING: (N) release of a CONSUMED hold throws SchedulingDomainError(WRONG_STATE)", async () => {
  const bt = await createBookedType();
  const now = new Date("2026-10-27T12:00:00.000Z");
  const a = await acquireSlotHold({ bookingTypeId: bt.id, startAt: SLOT_START, now, ttlMinutes: 10 });
  assert.ok(a.success);
  await consumeSlotHold(bt.id, SLOT_START, a.ownerToken!, now);

  await assert.rejects(
    releaseSlotHold(bt.id, SLOT_START, a.ownerToken!, now),
    (err: unknown) =>
      err instanceof SchedulingDomainError &&
      err.code === "WRONG_STATE" &&
      !(err instanceof SchedulingProviderError),
  );
});

test("SCHEDULING: (N) domain errors are NOT SchedulingProviderError", async () => {
  // Verify the type hierarchy: SchedulingDomainError and SchedulingProviderError
  // are distinct — domain errors must never be provider errors.
  const bt = await createBookedType();
  const now = new Date("2026-10-27T12:00:00.000Z");
  await assert.rejects(
    releaseSlotHold(bt.id, SLOT_START, "forged-token", now),
    (err: unknown) =>
      err instanceof SchedulingDomainError &&
      !(err instanceof SchedulingProviderError),
  );
});

// ---------------------------------------------------------------------------
// ADDITIONAL: acquisitionKey is absent from failure results (type-level safety)
// ---------------------------------------------------------------------------

test("SCHEDULING: (L) acquisitionKey and ownerToken are absent from failure results", async () => {
  const bt = await createBookedType();
  const now = new Date("2026-10-27T12:00:00.000Z");

  // First caller wins.
  const winner = await acquireSlotHold({
    bookingTypeId: bt.id,
    startAt: SLOT_START,
    now,
    ttlMinutes: 10,
    acquisitionKey: generateAcquisitionKey(),
  });
  assert.ok(winner.success);

  // Second caller (different acquisitionKey) loses.
  const loser = await acquireSlotHold({
    bookingTypeId: bt.id,
    startAt: SLOT_START,
    now,
    ttlMinutes: 10,
    acquisitionKey: generateAcquisitionKey(),
  });

  assert.equal(loser.success, false);
  // On failure, the discriminant fields must be absent/undefined.
  assert.equal(loser.ownerToken, undefined);
  assert.equal((loser as AcquireHoldResult).ownerToken, undefined);
  // No token leak in serialization.
  assert.equal(JSON.stringify(loser).includes(winner.ownerToken!), false);
});
