// ============================================================================
// BOOKING LIFECYCLE SERVICE (Mission 08.2)
// ----------------------------------------------------------------------------
// Server-authoritative booking transitions layered on top of Mission 08.1 hold
// leases. A booking binds to a specific lease generation with
// (holdId, holdAcquisitionKey), because slot_holds rows are reclaimed in place.
//
// Critical confirmation/reschedule paths use D1 batch transactions. Each
// transition writes a unique transitionKey into the booking row and the audit
// INSERT is conditioned on that exact key. A losing concurrent worker therefore
// cannot write a false/duplicate audit entry.
//
// Paid/manual/disabled modes are deliberately fail-closed in 08.2. Commerce
// activation arrives in later Mission 08 slices; only FREE bookings may cross
// into CONFIRMED here.
// ============================================================================

import { and, asc, eq } from "drizzle-orm";
import {
  bookingHistory,
  bookings,
  bookingTypes,
  slotHolds,
  type Booking,
  type BookingHistory,
  type BookingHistoryAction,
  type BookingStatus,
  type SlotHold,
} from "@/lib/db";
import { getDb } from "@/lib/db";
import { getD1Database } from "@/lib/cloudflare/bindings";
import { isUniqueConstraintError } from "@/lib/db/sqlite-errors";
import { SchedulingDomainError } from "./errors";
import {
  bookingDecisionSchema,
  bookingTransitionSchema,
  createBookingRequestSchema,
  rescheduleBookingSchema,
  type BookingActor,
  type BookingDecisionInput,
  type BookingTransitionInput,
  type CreateBookingRequestInput,
  type RescheduleBookingInput,
} from "./booking-schemas";

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().slice(0, 12)}`;
}

function transitionKey(): string {
  return `tr_${crypto.randomUUID()}`;
}

function toUnixSeconds(value: Date): number {
  return Math.floor(value.getTime() / 1000);
}

function assertAdmin(actor: BookingActor): void {
  if (actor.role !== "admin") {
    throw new SchedulingDomainError(
      "This booking transition requires an authenticated admin actor.",
      "AUTHORIZATION_REQUIRED",
    );
  }
}

function assertVersion(booking: Booking, expectedVersion: number): void {
  if (booking.version !== expectedVersion) {
    throw new SchedulingDomainError(
      `Booking version mismatch: expected ${expectedVersion}, current ${booking.version}.`,
      "CONCURRENT_MODIFICATION",
    );
  }
}

function assertBoundHold(booking: Booking, hold: SlotHold | undefined): SlotHold {
  if (!hold) {
    throw new SchedulingDomainError(
      "The booking's slot hold no longer exists.",
      "HOLD_NOT_FOUND",
    );
  }
  if (
    hold.id !== booking.holdId ||
    hold.bookingTypeId !== booking.bookingTypeId ||
    hold.slotKey !== booking.slotKey ||
    hold.acquisitionKey !== booking.holdAcquisitionKey
  ) {
    throw new SchedulingDomainError(
      "The booking no longer owns the slot-hold generation it was created from.",
      "HOLD_GENERATION_MISMATCH",
    );
  }
  return hold;
}

function assertLiveBoundHold(booking: Booking, hold: SlotHold | undefined, now: Date): SlotHold {
  const bound = assertBoundHold(booking, hold);
  if (bound.status !== "HELD") {
    throw new SchedulingDomainError(
      `Expected a HELD slot lease, found ${bound.status}.`,
      "WRONG_STATE",
    );
  }
  if (bound.expiresAt <= now) {
    throw new SchedulingDomainError(
      "The booking's slot hold has expired.",
      "EXPIRED",
    );
  }
  return bound;
}

function historyDetail(input: Record<string, unknown>): string {
  return JSON.stringify(input);
}

export async function getBookingById(id: string): Promise<Booking | undefined> {
  const db = await getDb();
  return db.select().from(bookings).where(eq(bookings.id, id)).get();
}

export async function getBookingByRequestKey(requestKey: string): Promise<Booking | undefined> {
  const db = await getDb();
  return db.select().from(bookings).where(eq(bookings.requestKey, requestKey)).get();
}

export async function getBookingHistory(bookingId: string): Promise<BookingHistory[]> {
  const db = await getDb();
  return db
    .select()
    .from(bookingHistory)
    .where(eq(bookingHistory.bookingId, bookingId))
    .orderBy(asc(bookingHistory.createdAt))
    .all();
}

async function getBookingWithTypeAndHold(id: string): Promise<{
  booking: Booking;
  bookingType: typeof bookingTypes.$inferSelect;
  hold: SlotHold | undefined;
}> {
  const db = await getDb();
  const booking = await db.select().from(bookings).where(eq(bookings.id, id)).get();
  if (!booking) {
    throw new SchedulingDomainError("Booking not found.", "BOOKING_NOT_FOUND");
  }
  const bookingType = await db
    .select()
    .from(bookingTypes)
    .where(eq(bookingTypes.id, booking.bookingTypeId))
    .get();
  if (!bookingType) {
    throw new SchedulingDomainError(
      "Booking type not found for this booking.",
      "BOOKING_TYPE_NOT_FOUND",
    );
  }
  const hold = await db.select().from(slotHolds).where(eq(slotHolds.id, booking.holdId)).get();
  return { booking, bookingType, hold };
}

async function findByHoldGeneration(
  holdId: string,
  holdAcquisitionKey: string,
): Promise<Booking | undefined> {
  const db = await getDb();
  return db
    .select()
    .from(bookings)
    .where(
      and(
        eq(bookings.holdId, holdId),
        eq(bookings.holdAcquisitionKey, holdAcquisitionKey),
      ),
    )
    .get();
}

/**
 * Create the durable booking request for one exact hold generation.
 *
 * Duplicate requestKey returns the original booking. A second requestKey that
 * targets the same (holdId, acquisitionKey) also collapses to the existing
 * booking via the DB unique backstop.
 */
export async function createBookingRequest(
  input: CreateBookingRequestInput,
): Promise<Booking> {
  const parsed = createBookingRequestSchema.parse(input);
  const db = await getDb();

  const byRequest = await getBookingByRequestKey(parsed.requestKey);
  if (byRequest) return byRequest;

  const bookingType = await db
    .select()
    .from(bookingTypes)
    .where(eq(bookingTypes.id, parsed.bookingTypeId))
    .get();
  if (!bookingType || !bookingType.active) {
    throw new SchedulingDomainError(
      "Booking type is unavailable.",
      "BOOKING_TYPE_NOT_FOUND",
    );
  }

  const hold = await db.select().from(slotHolds).where(eq(slotHolds.id, parsed.holdId)).get();
  if (!hold) {
    throw new SchedulingDomainError("Slot hold not found.", "HOLD_NOT_FOUND");
  }
  if (
    hold.bookingTypeId !== parsed.bookingTypeId ||
    hold.acquisitionKey !== parsed.holdAcquisitionKey
  ) {
    throw new SchedulingDomainError(
      "The supplied hold generation does not own this booking attempt.",
      "HOLD_GENERATION_MISMATCH",
    );
  }
  if (hold.status !== "HELD") {
    throw new SchedulingDomainError(
      `Cannot create a booking from a ${hold.status} hold.`,
      "WRONG_STATE",
    );
  }
  if (hold.expiresAt <= parsed.now) {
    throw new SchedulingDomainError(
      "Cannot create a booking from an expired hold.",
      "EXPIRED",
    );
  }

  const existingGeneration = await findByHoldGeneration(
    parsed.holdId,
    parsed.holdAcquisitionKey,
  );
  if (existingGeneration) return existingGeneration;

  const id = newId("bk");
  const initialStatus: BookingStatus =
    bookingType.confirmationPolicy === "AHMED_APPROVAL"
      ? "PENDING_APPROVAL"
      : "REQUESTED";
  const auditId = newId("bkh");

  const value = {
    id,
    bookingTypeId: bookingType.id,
    holdId: hold.id,
    holdAcquisitionKey: parsed.holdAcquisitionKey,
    requestKey: parsed.requestKey,
    requesterName: parsed.requesterName,
    requesterEmail: parsed.requesterEmail.toLowerCase(),
    requesterPhone: parsed.requesterPhone ?? null,
    notes: parsed.notes ?? null,
    slotKey: hold.slotKey,
    startAt: hold.startAt,
    endAt: hold.endAt,
    timezone: bookingType.timezone,
    status: initialStatus,
    version: 1,
    transitionKey: null,
    createdAt: parsed.now,
    updatedAt: parsed.now,
  } as const;

  try {
    await db.batch([
      db.insert(bookings).values(value),
      db.insert(bookingHistory).values({
        id: auditId,
        bookingId: id,
        action: "REQUESTED",
        fromStatus: null,
        toStatus: initialStatus,
        actorId: null,
        detail: historyDetail({
          requestKey: parsed.requestKey,
          confirmationPolicy: bookingType.confirmationPolicy,
          holdId: hold.id,
          holdAcquisitionKey: parsed.holdAcquisitionKey,
        }),
        createdAt: parsed.now,
      }),
    ]);
  } catch (error: unknown) {
    if (isUniqueConstraintError(error)) {
      const retryByRequest = await getBookingByRequestKey(parsed.requestKey);
      if (retryByRequest) return retryByRequest;
      const retryByGeneration = await findByHoldGeneration(
        parsed.holdId,
        parsed.holdAcquisitionKey,
      );
      if (retryByGeneration) return retryByGeneration;
    }
    throw error;
  }

  const created = await getBookingById(id);
  if (!created) {
    throw new Error("Booking insert committed but row could not be re-read.");
  }

  // AUTO_CONFIRM is allowed to cross the confirmation boundary only for FREE.
  // Paid/manual/disabled modes stay REQUESTED until later commerce slices
  // provide authoritative payment/manual-access state.
  if (
    bookingType.confirmationPolicy === "AUTO_CONFIRM" &&
    bookingType.accessMode === "FREE"
  ) {
    return confirmBoundBooking(
      {
        bookingId: created.id,
        expectedVersion: created.version,
        actor: { id: "system:auto-confirm", role: "system" },
        now: parsed.now,
      },
      "AUTO_CONFIRMED",
    );
  }

  return created;
}

async function confirmBoundBooking(
  input: BookingTransitionInput,
  action: Extract<BookingHistoryAction, "AUTO_CONFIRMED" | "APPROVED" | "CONFIRMED">,
): Promise<Booking> {
  const parsed = bookingTransitionSchema.parse(input);
  const { booking, bookingType, hold } = await getBookingWithTypeAndHold(parsed.bookingId);

  if (booking.status === "CONFIRMED") return booking;
  assertVersion(booking, parsed.expectedVersion);

  if (booking.status !== "REQUESTED" && booking.status !== "PENDING_APPROVAL") {
    throw new SchedulingDomainError(
      `Cannot confirm a booking in ${booking.status} state.`,
      "INVALID_TRANSITION",
    );
  }

  if (bookingType.confirmationPolicy === "AHMED_APPROVAL") {
    if (action !== "APPROVED") {
      throw new SchedulingDomainError(
        "This booking requires explicit Ahmed/admin approval.",
        "APPROVAL_REQUIRED",
      );
    }
    assertAdmin(parsed.actor);
  } else if (parsed.actor.role === "system") {
    if (
      bookingType.confirmationPolicy !== "AUTO_CONFIRM" ||
      action !== "AUTO_CONFIRMED"
    ) {
      throw new SchedulingDomainError(
        "System actors may only execute AUTO_CONFIRM policy.",
        "AUTHORIZATION_REQUIRED",
      );
    }
  } else {
    assertAdmin(parsed.actor);
  }

  if (bookingType.accessMode !== "FREE") {
    throw new SchedulingDomainError(
      `Booking access mode ${bookingType.accessMode} cannot be confirmed before commerce/payment state is authoritative.`,
      "PAYMENT_REQUIRED",
    );
  }

  const liveHold = assertLiveBoundHold(booking, hold, parsed.now);
  const token = transitionKey();
  const targetVersion = booking.version + 1;
  const nowSec = toUnixSeconds(parsed.now);
  const d1 = await getD1Database();
  const approved = action === "APPROVED";

  const claim = d1
    .prepare(
      `UPDATE bookings
       SET version = version + 1, transition_key = ?, updated_at = ?
       WHERE id = ? AND status = ? AND version = ?`,
    )
    .bind(token, nowSec, booking.id, booking.status, booking.version);

  const consume = d1
    .prepare(
      `UPDATE slot_holds
       SET status = 'CONSUMED', consumed_at = ?, updated_at = ?
       WHERE id = ?
         AND booking_type_id = ?
         AND slot_key = ?
         AND acquisition_key = ?
         AND status = 'HELD'
         AND expires_at > ?
         AND EXISTS (
           SELECT 1 FROM bookings
           WHERE id = ? AND transition_key = ? AND version = ?
         )`,
    )
    .bind(
      nowSec,
      nowSec,
      liveHold.id,
      booking.bookingTypeId,
      booking.slotKey,
      booking.holdAcquisitionKey,
      nowSec,
      booking.id,
      token,
      targetVersion,
    );

  const approvalSql = approved
    ? ", approved_by = ?, approved_at = ?"
    : "";
  const confirmArgs: unknown[] = [
    nowSec,
    nowSec,
    ...(approved ? [parsed.actor.id, nowSec] : []),
    booking.id,
    token,
    targetVersion,
    booking.status,
    liveHold.id,
    booking.holdAcquisitionKey,
  ];
  const confirm = d1
    .prepare(
      `UPDATE bookings
       SET status = 'CONFIRMED',
           confirmed_at = ?,
           updated_at = ?
           ${approvalSql}
       WHERE id = ?
         AND transition_key = ?
         AND version = ?
         AND status = ?
         AND EXISTS (
           SELECT 1 FROM slot_holds
           WHERE id = ?
             AND acquisition_key = ?
             AND status = 'CONSUMED'
         )`,
    )
    .bind(...confirmArgs);

  const audit = d1
    .prepare(
      `INSERT INTO booking_history
         (id, booking_id, action, from_status, to_status, actor_id, detail, created_at)
       SELECT ?, id, ?, ?, 'CONFIRMED', ?, ?, ?
       FROM bookings
       WHERE id = ? AND transition_key = ? AND version = ? AND status = 'CONFIRMED'`,
    )
    .bind(
      newId("bkh"),
      action,
      booking.status,
      parsed.actor.id,
      historyDetail({
        holdId: liveHold.id,
        holdAcquisitionKey: booking.holdAcquisitionKey,
        slotKey: booking.slotKey,
      }),
      nowSec,
      booking.id,
      token,
      targetVersion,
    );

  await d1.batch([claim, consume, confirm, audit]);

  const updated = await getBookingById(booking.id);
  if (
    updated?.status === "CONFIRMED" &&
    updated.version === targetVersion &&
    updated.transitionKey === token
  ) {
    return updated;
  }

  const db = await getDb();
  const currentHold = await db.select().from(slotHolds).where(eq(slotHolds.id, liveHold.id)).get();
  if (!currentHold) {
    throw new SchedulingDomainError("Slot hold disappeared during confirmation.", "HOLD_NOT_FOUND");
  }
  if (currentHold.acquisitionKey !== booking.holdAcquisitionKey) {
    throw new SchedulingDomainError(
      "The slot lease was reclaimed before confirmation.",
      "HOLD_GENERATION_MISMATCH",
    );
  }
  if (currentHold.status === "HELD" && currentHold.expiresAt <= parsed.now) {
    throw new SchedulingDomainError("The slot hold expired before confirmation.", "EXPIRED");
  }
  throw new SchedulingDomainError(
    "Booking confirmation lost a concurrent state transition.",
    "CONCURRENT_MODIFICATION",
  );
}

export async function confirmBooking(input: BookingTransitionInput): Promise<Booking> {
  return confirmBoundBooking(input, "CONFIRMED");
}

export async function approveBooking(input: BookingTransitionInput): Promise<Booking> {
  const parsed = bookingTransitionSchema.parse(input);
  assertAdmin(parsed.actor);
  return confirmBoundBooking(parsed, "APPROVED");
}

async function simpleTerminalTransition(params: {
  input: BookingDecisionInput;
  allowed: BookingStatus[];
  toStatus: Extract<BookingStatus, "DECLINED" | "CANCELLED" | "COMPLETED">;
  action: Extract<BookingHistoryAction, "DECLINED" | "CANCELLED" | "COMPLETED">;
}): Promise<Booking> {
  const parsed = bookingDecisionSchema.parse(params.input);
  assertAdmin(parsed.actor);
  const { booking } = await getBookingWithTypeAndHold(parsed.bookingId);
  if (booking.status === params.toStatus) return booking;
  assertVersion(booking, parsed.expectedVersion);
  if (!params.allowed.includes(booking.status)) {
    throw new SchedulingDomainError(
      `Cannot transition booking from ${booking.status} to ${params.toStatus}.`,
      "INVALID_TRANSITION",
    );
  }

  const token = transitionKey();
  const targetVersion = booking.version + 1;
  const nowSec = toUnixSeconds(parsed.now);
  const d1 = await getD1Database();

  const statusFields =
    params.toStatus === "DECLINED"
      ? ", declined_by = ?, declined_at = ?"
      : params.toStatus === "CANCELLED"
        ? ", cancelled_by = ?, cancelled_at = ?"
        : ", completed_at = ?";
  const actorFields =
    params.toStatus === "COMPLETED"
      ? [nowSec]
      : [parsed.actor.id, nowSec];

  const mutate = d1
    .prepare(
      `UPDATE bookings
       SET status = ?,
           version = version + 1,
           transition_key = ?,
           updated_at = ?
           ${statusFields}
       WHERE id = ? AND status = ? AND version = ?`,
    )
    .bind(
      params.toStatus,
      token,
      nowSec,
      ...actorFields,
      booking.id,
      booking.status,
      booking.version,
    );

  const maybeRelease = d1
    .prepare(
      `UPDATE slot_holds
       SET status = 'RELEASED', released_at = ?, updated_at = ?
       WHERE id = ?
         AND acquisition_key = ?
         AND status = 'HELD'
         AND EXISTS (
           SELECT 1 FROM bookings
           WHERE id = ? AND transition_key = ? AND version = ? AND status = ?
         )`,
    )
    .bind(
      nowSec,
      nowSec,
      booking.holdId,
      booking.holdAcquisitionKey,
      booking.id,
      token,
      targetVersion,
      params.toStatus,
    );

  const audit = d1
    .prepare(
      `INSERT INTO booking_history
         (id, booking_id, action, from_status, to_status, actor_id, detail, created_at)
       SELECT ?, id, ?, ?, ?, ?, ?, ?
       FROM bookings
       WHERE id = ? AND transition_key = ? AND version = ? AND status = ?`,
    )
    .bind(
      newId("bkh"),
      params.action,
      booking.status,
      params.toStatus,
      parsed.actor.id,
      historyDetail({ reason: parsed.reason ?? null }),
      nowSec,
      booking.id,
      token,
      targetVersion,
      params.toStatus,
    );

  // Releasing only affects a still-HELD lease generation. CONFIRMED bookings
  // have CONSUMED holds, so cancellation/completion cannot accidentally mutate
  // the terminal 08.1 hold state.
  await d1.batch([mutate, maybeRelease, audit]);

  const updated = await getBookingById(booking.id);
  if (
    updated?.status === params.toStatus &&
    updated.version === targetVersion &&
    updated.transitionKey === token
  ) {
    return updated;
  }
  throw new SchedulingDomainError(
    "Booking transition lost a concurrent modification.",
    "CONCURRENT_MODIFICATION",
  );
}

export async function declineBooking(input: BookingDecisionInput): Promise<Booking> {
  return simpleTerminalTransition({
    input,
    allowed: ["REQUESTED", "PENDING_APPROVAL"],
    toStatus: "DECLINED",
    action: "DECLINED",
  });
}

export async function cancelBooking(input: BookingDecisionInput): Promise<Booking> {
  return simpleTerminalTransition({
    input,
    allowed: ["REQUESTED", "PENDING_APPROVAL", "CONFIRMED"],
    toStatus: "CANCELLED",
    action: "CANCELLED",
  });
}

export async function completeBooking(input: BookingDecisionInput): Promise<Booking> {
  return simpleTerminalTransition({
    input,
    allowed: ["CONFIRMED"],
    toStatus: "COMPLETED",
    action: "COMPLETED",
  });
}

/**
 * Reschedule a confirmed booking onto a new exact hold generation.
 *
 * The previous slot is never erased from business history: the RESCHEDULED
 * audit detail stores complete old/new slot + hold identities. The booking row
 * moves to the new canonical slot only after the new hold is consumed inside
 * the same D1 batch transaction.
 */
export async function rescheduleBooking(
  input: RescheduleBookingInput,
): Promise<Booking> {
  const parsed = rescheduleBookingSchema.parse(input);
  assertAdmin(parsed.actor);
  const { booking } = await getBookingWithTypeAndHold(parsed.bookingId);
  assertVersion(booking, parsed.expectedVersion);
  if (booking.status !== "CONFIRMED") {
    throw new SchedulingDomainError(
      `Only CONFIRMED bookings can be rescheduled; found ${booking.status}.`,
      "INVALID_TRANSITION",
    );
  }

  const db = await getDb();
  const newHold = await db
    .select()
    .from(slotHolds)
    .where(eq(slotHolds.id, parsed.newHoldId))
    .get();
  if (!newHold) {
    throw new SchedulingDomainError("New slot hold not found.", "HOLD_NOT_FOUND");
  }
  if (
    newHold.bookingTypeId !== booking.bookingTypeId ||
    newHold.acquisitionKey !== parsed.newHoldAcquisitionKey
  ) {
    throw new SchedulingDomainError(
      "The new slot hold generation does not belong to this booking type/request.",
      "HOLD_GENERATION_MISMATCH",
    );
  }
  if (newHold.slotKey === booking.slotKey) {
    throw new SchedulingDomainError(
      "Reschedule target must be a different canonical slot.",
      "INVALID_TRANSITION",
    );
  }
  if (newHold.status !== "HELD") {
    throw new SchedulingDomainError(
      `Cannot reschedule onto a ${newHold.status} hold.`,
      "WRONG_STATE",
    );
  }
  if (newHold.expiresAt <= parsed.now) {
    throw new SchedulingDomainError("The new slot hold has expired.", "EXPIRED");
  }

  const token = transitionKey();
  const targetVersion = booking.version + 1;
  const nowSec = toUnixSeconds(parsed.now);
  const d1 = await getD1Database();

  const claim = d1
    .prepare(
      `UPDATE bookings
       SET version = version + 1, transition_key = ?, updated_at = ?
       WHERE id = ? AND status = 'CONFIRMED' AND version = ?`,
    )
    .bind(token, nowSec, booking.id, booking.version);

  const consume = d1
    .prepare(
      `UPDATE slot_holds
       SET status = 'CONSUMED', consumed_at = ?, updated_at = ?
       WHERE id = ?
         AND booking_type_id = ?
         AND acquisition_key = ?
         AND status = 'HELD'
         AND expires_at > ?
         AND EXISTS (
           SELECT 1 FROM bookings
           WHERE id = ? AND transition_key = ? AND version = ? AND status = 'CONFIRMED'
         )`,
    )
    .bind(
      nowSec,
      nowSec,
      newHold.id,
      booking.bookingTypeId,
      parsed.newHoldAcquisitionKey,
      nowSec,
      booking.id,
      token,
      targetVersion,
    );

  const move = d1
    .prepare(
      `UPDATE bookings
       SET hold_id = ?,
           hold_acquisition_key = ?,
           slot_key = ?,
           start_at = ?,
           end_at = ?,
           updated_at = ?
       WHERE id = ?
         AND transition_key = ?
         AND version = ?
         AND status = 'CONFIRMED'
         AND EXISTS (
           SELECT 1 FROM slot_holds
           WHERE id = ? AND acquisition_key = ? AND status = 'CONSUMED'
         )`,
    )
    .bind(
      newHold.id,
      parsed.newHoldAcquisitionKey,
      newHold.slotKey,
      toUnixSeconds(newHold.startAt),
      toUnixSeconds(newHold.endAt),
      nowSec,
      booking.id,
      token,
      targetVersion,
      newHold.id,
      parsed.newHoldAcquisitionKey,
    );

  const audit = d1
    .prepare(
      `INSERT INTO booking_history
         (id, booking_id, action, from_status, to_status, actor_id, detail, created_at)
       SELECT ?, id, 'RESCHEDULED', 'CONFIRMED', 'CONFIRMED', ?, ?, ?
       FROM bookings
       WHERE id = ?
         AND transition_key = ?
         AND version = ?
         AND status = 'CONFIRMED'
         AND hold_id = ?
         AND hold_acquisition_key = ?`,
    )
    .bind(
      newId("bkh"),
      parsed.actor.id,
      historyDetail({
        reason: parsed.reason ?? null,
        old: {
          holdId: booking.holdId,
          holdAcquisitionKey: booking.holdAcquisitionKey,
          slotKey: booking.slotKey,
          startAt: booking.startAt.toISOString(),
          endAt: booking.endAt.toISOString(),
        },
        next: {
          holdId: newHold.id,
          holdAcquisitionKey: parsed.newHoldAcquisitionKey,
          slotKey: newHold.slotKey,
          startAt: newHold.startAt.toISOString(),
          endAt: newHold.endAt.toISOString(),
        },
      }),
      nowSec,
      booking.id,
      token,
      targetVersion,
      newHold.id,
      parsed.newHoldAcquisitionKey,
    );

  await d1.batch([claim, consume, move, audit]);

  const updated = await getBookingById(booking.id);
  if (
    updated?.status === "CONFIRMED" &&
    updated.version === targetVersion &&
    updated.transitionKey === token &&
    updated.holdId === newHold.id &&
    updated.holdAcquisitionKey === parsed.newHoldAcquisitionKey
  ) {
    return updated;
  }

  const currentNewHold = await db
    .select()
    .from(slotHolds)
    .where(eq(slotHolds.id, newHold.id))
    .get();
  if (currentNewHold?.acquisitionKey !== parsed.newHoldAcquisitionKey) {
    throw new SchedulingDomainError(
      "The target slot lease was reclaimed during reschedule.",
      "HOLD_GENERATION_MISMATCH",
    );
  }
  if (currentNewHold?.status === "HELD" && currentNewHold.expiresAt <= parsed.now) {
    throw new SchedulingDomainError(
      "The target slot hold expired during reschedule.",
      "EXPIRED",
    );
  }
  throw new SchedulingDomainError(
    "Reschedule lost a concurrent state transition.",
    "CONCURRENT_MODIFICATION",
  );
}
