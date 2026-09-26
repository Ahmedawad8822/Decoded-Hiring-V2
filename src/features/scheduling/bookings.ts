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
  orders,
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
import { requireAdmin } from "@/lib/auth";
import { getEffectiveBookingAccessPolicy } from "@/features/offers/service";
import { SchedulingDomainError } from "./errors";
import {
  bookingDecisionSchema,
  bookingTransitionSchema,
  createBookingRequestSchema,
  rescheduleBookingSchema,
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

type TrustedBookingActor = {
  id: string;
  role: "admin" | "system";
};

async function resolveAdminActor(): Promise<TrustedBookingActor> {
  try {
    const session = await requireAdmin();
    return { id: session.user.id, role: "admin" };
  } catch (error: unknown) {
    if (
      error instanceof Error &&
      (error.message.startsWith("Unauthorized:") ||
        error.message.startsWith("Forbidden:"))
    ) {
      throw new SchedulingDomainError(
        "This booking operation requires an authenticated admin session.",
        "AUTHORIZATION_REQUIRED",
      );
    }
    // Configuration/DB/runtime failures are operational failures, not auth
    // denials. Preserve them so outages are observable rather than disguised.
    throw error;
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

function assertRequestKeyBinding(
  existing: Booking,
  input: CreateBookingRequestInput,
): Booking {
  if (
    existing.bookingTypeId !== input.bookingTypeId ||
    existing.holdId !== input.holdId ||
    existing.holdAcquisitionKey !== input.holdAcquisitionKey
  ) {
    throw new SchedulingDomainError(
      "This requestKey is already bound to a different booking attempt.",
      "IDEMPOTENCY_CONFLICT",
    );
  }
  return existing;
}

async function getBookingById(id: string): Promise<Booking | undefined> {
  const db = await getDb();
  return db.select().from(bookings).where(eq(bookings.id, id)).get();
}

async function getBookingByRequestKey(requestKey: string): Promise<Booking | undefined> {
  const db = await getDb();
  return db.select().from(bookings).where(eq(bookings.requestKey, requestKey)).get();
}

async function getBookingHistory(bookingId: string): Promise<BookingHistory[]> {
  const db = await getDb();
  return db
    .select()
    .from(bookingHistory)
    .where(eq(bookingHistory.bookingId, bookingId))
    .orderBy(asc(bookingHistory.createdAt))
    .all();
}

export async function getBookingForAdmin(id: string): Promise<Booking | undefined> {
  await resolveAdminActor();
  return getBookingById(id);
}

export async function getBookingHistoryForAdmin(
  bookingId: string,
): Promise<BookingHistory[]> {
  await resolveAdminActor();
  return getBookingHistory(bookingId);
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

async function getBookingOrderPaymentContract(
  bookingId: string,
  bookingTypeId: string,
): Promise<{ exists: boolean; satisfied: boolean }> {
  const db = await getDb();
  const linkedOrders = await db
    .select({
      status: orders.status,
      accessMode: orders.accessMode,
    })
    .from(orders)
    .where(
      and(
        eq(orders.bookingId, bookingId),
        eq(orders.bookingTypeId, bookingTypeId),
      ),
    )
    .all();

  return {
    exists: linkedOrders.length > 0,
    satisfied: linkedOrders.some(
      (candidate) =>
        candidate.status === "PAID" || candidate.status === "FULFILLED",
    ),
  };
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
  if (byRequest) return assertRequestKeyBinding(byRequest, parsed);

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

  const accessPolicy = await getEffectiveBookingAccessPolicy(bookingType);
  if (!accessPolicy.available) {
    throw new SchedulingDomainError(
      "Booking is currently unavailable under its commercial Offer policy.",
      "BOOKING_UNAVAILABLE",
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
      if (retryByRequest) return assertRequestKeyBinding(retryByRequest, parsed);
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

  // AUTO_CONFIRM crosses the confirmation boundary only when the effective
  // commercial policy is FREE. A linked Offer is authoritative; legacy
  // BookingType.accessMode is fallback only when no Offer exists.
  if (
    bookingType.confirmationPolicy === "AUTO_CONFIRM" &&
    accessPolicy.mode === "FREE"
  ) {
    return confirmBoundBooking(
      {
        bookingId: created.id,
        expectedVersion: created.version,
        now: parsed.now,
      },
      "AUTO_CONFIRMED",
      { id: "system:auto-confirm", role: "system" },
    );
  }

  return created;
}

async function confirmBoundBooking(
  input: BookingTransitionInput,
  action: Extract<BookingHistoryAction, "AUTO_CONFIRMED" | "APPROVED" | "CONFIRMED">,
  actor: TrustedBookingActor,
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
  } else if (actor.role === "system") {
    if (
      bookingType.confirmationPolicy !== "AUTO_CONFIRM" ||
      action !== "AUTO_CONFIRMED"
    ) {
      throw new SchedulingDomainError(
        "System actors may only execute AUTO_CONFIRM policy.",
        "AUTHORIZATION_REQUIRED",
      );
    }
  }

  const orderPayment = await getBookingOrderPaymentContract(
    booking.id,
    booking.bookingTypeId,
  );

  if (orderPayment.exists) {
    // Once an Order exists, its immutable booking/payment contract is the
    // authority for this booking attempt. Later Offer edits/deactivation may
    // affect new purchases, but cannot invalidate or free an existing Order.
    if (!orderPayment.satisfied) {
      throw new SchedulingDomainError(
        "A matching internal order must be PAID before this booking can be confirmed.",
        "PAYMENT_REQUIRED",
      );
    }
  } else {
    const accessPolicy = await getEffectiveBookingAccessPolicy(bookingType);
    if (!accessPolicy.available) {
      throw new SchedulingDomainError(
        "Booking is currently unavailable under its commercial Offer policy.",
        "BOOKING_UNAVAILABLE",
      );
    }
    if (
      accessPolicy.mode === "PAID_SESSION" ||
      accessPolicy.mode === "PAID_ONE_TIME" ||
      accessPolicy.mode === "MANUAL_INVOICE"
    ) {
      throw new SchedulingDomainError(
        "A matching internal order must be PAID before this booking can be confirmed.",
        "PAYMENT_REQUIRED",
      );
    }
  }

  const liveHold = assertLiveBoundHold(booking, hold, parsed.now);
  const token = transitionKey();
  const targetVersion = booking.version + 1;
  const nowSec = toUnixSeconds(parsed.now);
  const d1 = await getD1Database();
  const approved = action === "APPROVED";

  // Consume first, but only while the booking is still at the exact state/version
  // observed above. D1 batch statements execute transactionally and serially.
  // If the hold was reclaimed/expired before the batch starts, this is a no-op
  // and the booking row is left untouched.
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
           WHERE id = ?
             AND status = ?
             AND version = ?
             AND hold_id = ?
             AND hold_acquisition_key = ?
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
      booking.status,
      booking.version,
      booking.holdId,
      booking.holdAcquisitionKey,
    );

  const approvalSql = approved
    ? ", approved_by = ?, approved_at = ?"
    : "";
  const confirmArgs: unknown[] = [
    nowSec,
    nowSec,
    token,
    ...(approved ? [actor.id, nowSec] : []),
    booking.id,
    booking.status,
    booking.version,
    booking.holdId,
    booking.holdAcquisitionKey,
    liveHold.id,
    booking.holdAcquisitionKey,
  ];
  const confirm = d1
    .prepare(
      `UPDATE bookings
       SET status = 'CONFIRMED',
           confirmed_at = ?,
           updated_at = ?,
           version = version + 1,
           transition_key = ?
           ${approvalSql}
       WHERE id = ?
         AND status = ?
         AND version = ?
         AND hold_id = ?
         AND hold_acquisition_key = ?
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
      actor.id,
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

  // Durable outbox is committed in the SAME D1 batch as confirmation.
  // If the process dies immediately after business confirmation, calendar and
  // confirmation-message work is still recoverable. Mail waits for calendar.
  const calendarEffectId = `fx_booking_${booking.id}_calendar_create`;
  const mailEffectId = `fx_booking_${booking.id}_mail_confirmation`;
  const effectPayload = historyDetail({
    bookingId: booking.id,
    bookingVersion: targetVersion,
  });

  const enqueueCalendar = d1
    .prepare(
      `INSERT OR IGNORE INTO orchestration_effects
       (id, subject_type, subject_id, effect_type, provider_kind,
        idempotency_key, depends_on_effect_id, payload, status, attempt_count,
        created_at, updated_at)
       SELECT ?, 'BOOKING', id, 'CALENDAR_CREATE', 'calendar',
              ?, NULL, ?, 'PENDING', 0, ?, ?
       FROM bookings
       WHERE id=? AND transition_key=? AND version=? AND status='CONFIRMED'`,
    )
    .bind(
      calendarEffectId,
      `booking:${booking.id}:calendar:create`,
      effectPayload,
      nowSec,
      nowSec,
      booking.id,
      token,
      targetVersion,
    );

  const enqueueCalendarAudit = d1
    .prepare(
      `INSERT OR IGNORE INTO orchestration_history
       (id, effect_id, action, from_status, to_status, detail, created_at)
       SELECT ?, id, 'ENQUEUED', NULL, 'PENDING', ?, ?
       FROM orchestration_effects WHERE id=?`,
    )
    .bind(
      `fxh_${calendarEffectId}_enqueued`,
      historyDetail({ reason: "booking_confirmed" }),
      nowSec,
      calendarEffectId,
    );

  const enqueueMail = d1
    .prepare(
      `INSERT OR IGNORE INTO orchestration_effects
       (id, subject_type, subject_id, effect_type, provider_kind,
        idempotency_key, depends_on_effect_id, payload, status, attempt_count,
        created_at, updated_at)
       SELECT ?, 'BOOKING', id, 'MAIL_CONFIRMATION', 'mailbox',
              ?, ?, ?, 'PENDING', 0, ?, ?
       FROM bookings
       WHERE id=? AND transition_key=? AND version=? AND status='CONFIRMED'`,
    )
    .bind(
      mailEffectId,
      `booking:${booking.id}:mail:confirmation`,
      calendarEffectId,
      effectPayload,
      nowSec,
      nowSec,
      booking.id,
      token,
      targetVersion,
    );

  const enqueueMailAudit = d1
    .prepare(
      `INSERT OR IGNORE INTO orchestration_history
       (id, effect_id, action, from_status, to_status, detail, created_at)
       SELECT ?, id, 'ENQUEUED', NULL, 'PENDING', ?, ?
       FROM orchestration_effects WHERE id=?`,
    )
    .bind(
      `fxh_${mailEffectId}_enqueued`,
      historyDetail({ reason: "booking_confirmed", dependsOn: calendarEffectId }),
      nowSec,
      mailEffectId,
    );

  await d1.batch([
    consume,
    confirm,
    audit,
    enqueueCalendar,
    enqueueCalendarAudit,
    enqueueMail,
    enqueueMailAudit,
  ]);

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

/**
 * Internal Mission 08.5 orchestration seam.
 *
 * Paid AUTO_CONFIRM bookings are not confirmed at request time because payment
 * truth does not exist yet. Once a matching internal Order is PAID, the durable
 * commerce worker may call this narrow helper. Human-gated policies return
 * null and remain pending for explicit admin action.
 *
 * Deliberately not re-exported from the scheduling barrel.
 */
export async function autoConfirmPaidBookingFromCommerce(
  bookingId: string,
  now: Date,
): Promise<Booking | null> {
  const { booking, bookingType } = await getBookingWithTypeAndHold(bookingId);
  if (booking.status === "CONFIRMED") return booking;
  if (bookingType.confirmationPolicy !== "AUTO_CONFIRM") return null;

  return confirmBoundBooking(
    {
      bookingId: booking.id,
      expectedVersion: booking.version,
      now,
    },
    "AUTO_CONFIRMED",
    { id: "system:paid-auto-confirm", role: "system" },
  );
}

export async function confirmBooking(input: BookingTransitionInput): Promise<Booking> {
  const actor = await resolveAdminActor();
  return confirmBoundBooking(input, "CONFIRMED", actor);
}

export async function approveBooking(input: BookingTransitionInput): Promise<Booking> {
  const actor = await resolveAdminActor();
  return confirmBoundBooking(input, "APPROVED", actor);
}

async function simpleTerminalTransition(params: {
  input: BookingDecisionInput;
  allowed: BookingStatus[];
  toStatus: Extract<BookingStatus, "DECLINED" | "CANCELLED" | "COMPLETED">;
  action: Extract<BookingHistoryAction, "DECLINED" | "CANCELLED" | "COMPLETED">;
}, actor: TrustedBookingActor): Promise<Booking> {
  const parsed = bookingDecisionSchema.parse(params.input);
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
      : [actor.id, nowSec];

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

  // DECLINED/CANCELLED must free the exact lease generation they own.
  // This is the ONLY 08.2 path that can retire a previously CONSUMED hold:
  // it is guarded by the booking CAS transition + exact acquisition generation,
  // so generic hold acquisition still treats CONSUMED as terminal.
  const releaseStatusPredicate =
    params.toStatus === "DECLINED" || params.toStatus === "CANCELLED"
      ? "status IN ('HELD', 'CONSUMED')"
      : "1 = 0";
  const maybeRelease = d1
    .prepare(
      `UPDATE slot_holds
       SET status = 'RELEASED', released_at = ?, updated_at = ?
       WHERE id = ?
         AND acquisition_key = ?
         AND ${releaseStatusPredicate}
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
      actor.id,
      historyDetail({ reason: parsed.reason ?? null }),
      nowSec,
      booking.id,
      token,
      targetVersion,
      params.toStatus,
    );

  // Cancellation/decline release only the exact generation owned by this
  // booking; completion deliberately leaves the consumed slot historical.
  if (params.toStatus === "CANCELLED") {
    const calendarEffectId =
      `fx_booking_${booking.id}_calendar_cancel_v${targetVersion}`;
    const mailEffectId =
      `fx_booking_${booking.id}_mail_cancellation_v${targetVersion}`;
    const effectPayload = historyDetail({
      bookingId: booking.id,
      bookingVersion: targetVersion,
    });
    const hadConfirmedCalendar = booking.status === "CONFIRMED";

    const enqueueCalendarCancel = d1
      .prepare(
        `INSERT OR IGNORE INTO orchestration_effects
         (id, subject_type, subject_id, effect_type, provider_kind,
          idempotency_key, depends_on_effect_id, payload, status, attempt_count,
          created_at, updated_at)
         SELECT ?, 'BOOKING', id, 'CALENDAR_CANCEL', 'calendar',
                ?, NULL, ?, 'PENDING', 0, ?, ?
         FROM bookings
         WHERE id=? AND transition_key=? AND version=? AND status='CANCELLED'
           AND ?=1`,
      )
      .bind(
        calendarEffectId,
        `booking:${booking.id}:calendar:cancel:v${targetVersion}`,
        effectPayload,
        nowSec,
        nowSec,
        booking.id,
        token,
        targetVersion,
        hadConfirmedCalendar ? 1 : 0,
      );

    const enqueueCalendarCancelAudit = d1
      .prepare(
        `INSERT OR IGNORE INTO orchestration_history
         (id, effect_id, action, from_status, to_status, detail, created_at)
         SELECT ?, id, 'ENQUEUED', NULL, 'PENDING', ?, ?
         FROM orchestration_effects WHERE id=?`,
      )
      .bind(
        `fxh_${calendarEffectId}_enqueued`,
        historyDetail({ reason: "booking_cancelled" }),
        nowSec,
        calendarEffectId,
      );

    const enqueueCancellationMail = d1
      .prepare(
        `INSERT OR IGNORE INTO orchestration_effects
         (id, subject_type, subject_id, effect_type, provider_kind,
          idempotency_key, depends_on_effect_id, payload, status, attempt_count,
          created_at, updated_at)
         SELECT ?, 'BOOKING', id, 'MAIL_CANCELLATION', 'mailbox',
                ?, ?, ?, 'PENDING', 0, ?, ?
         FROM bookings
         WHERE id=? AND transition_key=? AND version=? AND status='CANCELLED'`,
      )
      .bind(
        mailEffectId,
        `booking:${booking.id}:mail:cancellation:v${targetVersion}`,
        hadConfirmedCalendar ? calendarEffectId : null,
        effectPayload,
        nowSec,
        nowSec,
        booking.id,
        token,
        targetVersion,
      );

    const enqueueCancellationMailAudit = d1
      .prepare(
        `INSERT OR IGNORE INTO orchestration_history
         (id, effect_id, action, from_status, to_status, detail, created_at)
         SELECT ?, id, 'ENQUEUED', NULL, 'PENDING', ?, ?
         FROM orchestration_effects WHERE id=?`,
      )
      .bind(
        `fxh_${mailEffectId}_enqueued`,
        historyDetail({
          reason: "booking_cancelled",
          dependsOn: hadConfirmedCalendar ? calendarEffectId : null,
        }),
        nowSec,
        mailEffectId,
      );

    await d1.batch([
      mutate,
      maybeRelease,
      audit,
      enqueueCalendarCancel,
      enqueueCalendarCancelAudit,
      enqueueCancellationMail,
      enqueueCancellationMailAudit,
    ]);
  } else {
    await d1.batch([mutate, maybeRelease, audit]);
  }

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
  const actor = await resolveAdminActor();
  return simpleTerminalTransition({
    input,
    allowed: ["REQUESTED", "PENDING_APPROVAL"],
    toStatus: "DECLINED",
    action: "DECLINED",
  }, actor);
}

export async function cancelBooking(input: BookingDecisionInput): Promise<Booking> {
  const actor = await resolveAdminActor();
  return simpleTerminalTransition({
    input,
    allowed: ["REQUESTED", "PENDING_APPROVAL", "CONFIRMED"],
    toStatus: "CANCELLED",
    action: "CANCELLED",
  }, actor);
}

export async function completeBooking(input: BookingDecisionInput): Promise<Booking> {
  const actor = await resolveAdminActor();
  return simpleTerminalTransition({
    input,
    allowed: ["CONFIRMED"],
    toStatus: "COMPLETED",
    action: "COMPLETED",
  }, actor);
}

/**
 * Reschedule a confirmed booking onto a new exact hold generation.
 *
 * The previous slot is never erased from business history: the RESCHEDULED
 * audit detail stores complete old/new slot + hold identities. The booking row
 * moves to the new canonical slot only after the new hold is consumed inside
 * the same D1 batch transaction.
 */
async function rescheduleBookingAsActor(
  input: RescheduleBookingInput,
  actor: TrustedBookingActor,
): Promise<Booking> {
  const parsed = rescheduleBookingSchema.parse(input);
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

  // The target hold is consumed only if the booking is still at the exact
  // CONFIRMED version observed above. If the target lease was reclaimed or the
  // booking changed before the batch begins, both statements remain no-ops.
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
           WHERE id = ? AND status = 'CONFIRMED' AND version = ?
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
      booking.version,
    );

  const move = d1
    .prepare(
      `UPDATE bookings
       SET hold_id = ?,
           hold_acquisition_key = ?,
           slot_key = ?,
           start_at = ?,
           end_at = ?,
           updated_at = ?,
           version = version + 1,
           transition_key = ?
       WHERE id = ?
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
      token,
      booking.id,
      booking.version,
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
      actor.id,
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

  const releaseOld = d1
    .prepare(
      `UPDATE slot_holds
       SET status = 'RELEASED', released_at = ?, updated_at = ?
       WHERE id = ?
         AND acquisition_key = ?
         AND status = 'CONSUMED'
         AND EXISTS (
           SELECT 1 FROM bookings
           WHERE id = ?
             AND transition_key = ?
             AND version = ?
             AND status = 'CONFIRMED'
             AND hold_id = ?
             AND hold_acquisition_key = ?
         )
         AND EXISTS (
           SELECT 1 FROM slot_holds
           WHERE id = ? AND acquisition_key = ? AND status = 'CONSUMED'
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
      newHold.id,
      parsed.newHoldAcquisitionKey,
      newHold.id,
      parsed.newHoldAcquisitionKey,
    );

  const calendarEffectId =
    `fx_booking_${booking.id}_calendar_update_v${targetVersion}`;
  const mailEffectId =
    `fx_booking_${booking.id}_mail_reschedule_v${targetVersion}`;
  const effectPayload = historyDetail({
    bookingId: booking.id,
    bookingVersion: targetVersion,
  });

  const enqueueCalendarUpdate = d1
    .prepare(
      `INSERT OR IGNORE INTO orchestration_effects
       (id, subject_type, subject_id, effect_type, provider_kind,
        idempotency_key, depends_on_effect_id, payload, status, attempt_count,
        created_at, updated_at)
       SELECT ?, 'BOOKING', id, 'CALENDAR_UPDATE', 'calendar',
              ?, NULL, ?, 'PENDING', 0, ?, ?
       FROM bookings
       WHERE id=? AND transition_key=? AND version=? AND status='CONFIRMED'`,
    )
    .bind(
      calendarEffectId,
      `booking:${booking.id}:calendar:update:v${targetVersion}`,
      effectPayload,
      nowSec,
      nowSec,
      booking.id,
      token,
      targetVersion,
    );

  const enqueueCalendarUpdateAudit = d1
    .prepare(
      `INSERT OR IGNORE INTO orchestration_history
       (id, effect_id, action, from_status, to_status, detail, created_at)
       SELECT ?, id, 'ENQUEUED', NULL, 'PENDING', ?, ?
       FROM orchestration_effects WHERE id=?`,
    )
    .bind(
      `fxh_${calendarEffectId}_enqueued`,
      historyDetail({ reason: "booking_rescheduled" }),
      nowSec,
      calendarEffectId,
    );

  const enqueueRescheduleMail = d1
    .prepare(
      `INSERT OR IGNORE INTO orchestration_effects
       (id, subject_type, subject_id, effect_type, provider_kind,
        idempotency_key, depends_on_effect_id, payload, status, attempt_count,
        created_at, updated_at)
       SELECT ?, 'BOOKING', id, 'MAIL_RESCHEDULE', 'mailbox',
              ?, ?, ?, 'PENDING', 0, ?, ?
       FROM bookings
       WHERE id=? AND transition_key=? AND version=? AND status='CONFIRMED'`,
    )
    .bind(
      mailEffectId,
      `booking:${booking.id}:mail:reschedule:v${targetVersion}`,
      calendarEffectId,
      effectPayload,
      nowSec,
      nowSec,
      booking.id,
      token,
      targetVersion,
    );

  const enqueueRescheduleMailAudit = d1
    .prepare(
      `INSERT OR IGNORE INTO orchestration_history
       (id, effect_id, action, from_status, to_status, detail, created_at)
       SELECT ?, id, 'ENQUEUED', NULL, 'PENDING', ?, ?
       FROM orchestration_effects WHERE id=?`,
    )
    .bind(
      `fxh_${mailEffectId}_enqueued`,
      historyDetail({ reason: "booking_rescheduled", dependsOn: calendarEffectId }),
      nowSec,
      mailEffectId,
    );

  await d1.batch([
    consume,
    move,
    releaseOld,
    audit,
    enqueueCalendarUpdate,
    enqueueCalendarUpdateAudit,
    enqueueRescheduleMail,
    enqueueRescheduleMailAudit,
  ]);

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


export async function rescheduleBooking(
  input: RescheduleBookingInput,
): Promise<Booking> {
  const actor = await resolveAdminActor();
  return rescheduleBookingAsActor(input, actor);
}

/**
 * Internal regression seam only. It is deliberately NOT re-exported from the
 * scheduling barrel/API. Production admin operations above always resolve the
 * live Better Auth session through requireAdmin().
 */
const bookingLifecycleTestApi = {
  getBooking: (id: string) => getBookingById(id),
  getHistory: (bookingId: string) => getBookingHistory(bookingId),
  approve: (input: BookingTransitionInput, actorId = "test-admin") =>
    confirmBoundBooking(input, "APPROVED", { id: actorId, role: "admin" }),
  confirm: (input: BookingTransitionInput, actorId = "test-admin") =>
    confirmBoundBooking(input, "CONFIRMED", { id: actorId, role: "admin" }),
  decline: (input: BookingDecisionInput, actorId = "test-admin") =>
    simpleTerminalTransition({
      input,
      allowed: ["REQUESTED", "PENDING_APPROVAL"],
      toStatus: "DECLINED",
      action: "DECLINED",
    }, { id: actorId, role: "admin" }),
  cancel: (input: BookingDecisionInput, actorId = "test-admin") =>
    simpleTerminalTransition({
      input,
      allowed: ["REQUESTED", "PENDING_APPROVAL", "CONFIRMED"],
      toStatus: "CANCELLED",
      action: "CANCELLED",
    }, { id: actorId, role: "admin" }),
  complete: (input: BookingDecisionInput, actorId = "test-admin") =>
    simpleTerminalTransition({
      input,
      allowed: ["CONFIRMED"],
      toStatus: "COMPLETED",
      action: "COMPLETED",
    }, { id: actorId, role: "admin" }),
  reschedule: (input: RescheduleBookingInput, actorId = "test-admin") =>
    rescheduleBookingAsActor(input, { id: actorId, role: "admin" }),
};

/**
 * Regression-only escape hatch. It is unavailable unless the dedicated test
 * bootstrap explicitly opts in. Production/runtime environments never set this
 * flag, so a direct-path import cannot bypass Better Auth.
 */
export const __bookingLifecycleTestOnly =
  process.env.DH_BOOKING_LIFECYCLE_TEST_SEAM === "1"
    ? bookingLifecycleTestApi
    : undefined;
