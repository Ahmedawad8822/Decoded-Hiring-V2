import { and, count, eq, gt, inArray, ne, notExists } from "drizzle-orm";

import {
  bookings,
  enrollments,
  offers,
  orders,
  slotHolds,
  type Offer,
} from "@/lib/db";
import { getDb } from "@/lib/db";
import { AppError } from "@/lib/errors";

// ============================================================================
// OFFER AVAILABILITY (seat caps + close dates)
// ----------------------------------------------------------------------------
// Seats taken are DERIVED, never stored, so lowering a limit or passing the
// close date never revokes an existing enrollment or booking. A claim is:
//  - COURSE offers: non-cancelled enrollments (active + completed) of the
//    linked course. Cancelled enrollments free their seat.
//  - Booking-type offers (COACHING/WORKSHOP with a booking type): bookings in
//    REQUESTED/PENDING_APPROVAL/CONFIRMED plus active (HELD + unexpired) slot
//    holds that are NOT yet bound to a booking, so two people cannot take the
//    last seat while a hold is in flight. Counting only unlinked holds avoids
//    double-counting a hold together with the booking created from it.
//  - PRODUCT offers: orders in PENDING/REQUIRES_ACTION/PAID/FULFILLED.
//  - Lead-first offers (no linked course/booking type): nothing to count.
// All reads are single indexed COUNT(*) statements (no table scans).
// ============================================================================

export type OfferAvailabilityState = "open" | "sold_out" | "closed";

export type OfferAvailability = {
  offerId: string;
  seatLimit: number | null;
  seatsTaken: number;
  /** Null when the offer has no seat limit. */
  seatsLeft: number | null;
  closesAt: Date | null;
  state: OfferAvailabilityState;
};

/** Booking states that occupy a seat. Terminal states free it. */
export const ACTIVE_BOOKING_STATUSES = [
  "REQUESTED",
  "PENDING_APPROVAL",
  "CONFIRMED",
] as const;

/** Enrollment states that occupy a seat. Cancelled frees it. */
export const ACTIVE_ENROLLMENT_STATUSES = ["active", "completed"] as const;

/** Order states that occupy a seat. Cancelled/failed/refunded free it. */
export const ACTIVE_ORDER_STATUSES = [
  "PENDING",
  "REQUIRES_ACTION",
  "PAID",
  "FULFILLED",
] as const;

export function isOfferClosedByDate(
  offer: Pick<Offer, "closesAt">,
  now: Date = new Date(),
): boolean {
  return offer.closesAt != null && offer.closesAt <= now;
}

function resolveState(
  seatLimit: number | null,
  seatsTaken: number,
  closesAt: Date | null,
  now: Date,
): OfferAvailabilityState {
  if (closesAt != null && closesAt <= now) return "closed";
  if (seatLimit != null && seatsTaken >= seatLimit) return "sold_out";
  return "open";
}

async function countCourseSeatsTaken(courseId: string): Promise<number> {
  const db = await getDb();
  const row = await db
    .select({ value: count() })
    .from(enrollments)
    .where(
      and(
        eq(enrollments.courseId, courseId),
        inArray(enrollments.status, [...ACTIVE_ENROLLMENT_STATUSES]),
      ),
    )
    .get();
  return Number(row?.value ?? 0);
}

async function countBookingSeatsTaken(
  bookingTypeId: string,
  now: Date,
  excludeHoldId?: string,
): Promise<number> {
  const db = await getDb();
  // Active holds not yet bound to a booking. Linked holds are already counted
  // through their booking row (see module docblock). excludeHoldId removes
  // the caller's own in-flight hold: converting a held seat into a booking
  // must not require a second free seat.
  const holdPredicate = and(
    eq(slotHolds.bookingTypeId, bookingTypeId),
    eq(slotHolds.status, "HELD"),
    gt(slotHolds.expiresAt, now),
    excludeHoldId ? ne(slotHolds.id, excludeHoldId) : undefined,
    notExists(
      db
        .select({ one: bookings.id })
        .from(bookings)
        .where(
          and(
            eq(bookings.holdId, slotHolds.id),
            eq(bookings.holdAcquisitionKey, slotHolds.acquisitionKey),
          ),
        ),
    ),
  );
  const [bookingRow, holdRow] = await Promise.all([
    db
      .select({ value: count() })
      .from(bookings)
      .where(
        and(
          eq(bookings.bookingTypeId, bookingTypeId),
          inArray(bookings.status, [...ACTIVE_BOOKING_STATUSES]),
        ),
      )
      .get(),
    db.select({ value: count() }).from(slotHolds).where(holdPredicate).get(),
  ]);
  return Number(bookingRow?.value ?? 0) + Number(holdRow?.value ?? 0);
}

async function countProductSeatsTaken(offerId: string): Promise<number> {
  const db = await getDb();
  const row = await db
    .select({ value: count() })
    .from(orders)
    .where(
      and(
        eq(orders.offerId, offerId),
        inArray(orders.status, [...ACTIVE_ORDER_STATUSES]),
      ),
    )
    .get();
  return Number(row?.value ?? 0);
}

export async function getAvailabilityForOffer(
  offer: Offer,
  now: Date = new Date(),
  options: { excludeHoldId?: string } = {},
): Promise<OfferAvailability> {
  let seatsTaken = 0;
  if (offer.kind === "COURSE" && offer.courseId) {
    seatsTaken = await countCourseSeatsTaken(offer.courseId);
  } else if (
    (offer.kind === "COACHING" || offer.kind === "WORKSHOP") &&
    offer.bookingTypeId
  ) {
    seatsTaken = await countBookingSeatsTaken(
      offer.bookingTypeId,
      now,
      options.excludeHoldId,
    );
  } else if (offer.kind === "PRODUCT") {
    seatsTaken = await countProductSeatsTaken(offer.id);
  }

  const seatLimit = offer.seatLimit ?? null;
  return {
    offerId: offer.id,
    seatLimit,
    seatsTaken,
    seatsLeft: seatLimit == null ? null : Math.max(0, seatLimit - seatsTaken),
    closesAt: offer.closesAt ?? null,
    state: resolveState(seatLimit, seatsTaken, offer.closesAt ?? null, now),
  };
}

export async function getOfferAvailability(
  offerId: string,
  now: Date = new Date(),
): Promise<OfferAvailability> {
  const db = await getDb();
  const offer = await db
    .select()
    .from(offers)
    .where(eq(offers.id, offerId))
    .get();
  if (!offer) throw new AppError("not_found", "Offer not found.");
  return getAvailabilityForOffer(offer, now);
}

/**
 * Friendly enforcement gate for every seat-claiming mutation (free
 * enrollment, hold acquisition, booking creation, order creation). Throws
 * AppError("conflict") — a 409 with end-user copy — when the offer is sold
 * out or its closing date has passed. Callers perform their race-safe
 * conditional write AFTER this pre-check; see each call site.
 */
export async function assertOfferOpen(
  offer: Pick<Offer, "id" | "seatLimit" | "closesAt">,
  now: Date = new Date(),
  seatsTaken?: number,
): Promise<void> {
  if (isOfferClosedByDate(offer, now)) {
    throw new AppError(
      "conflict",
      "Booking for this offer has closed and is no longer available.",
    );
  }
  if (offer.seatLimit != null) {
    const taken =
      seatsTaken ??
      (await getOfferAvailability(offer.id, now)).seatsTaken;
    if (taken >= offer.seatLimit) {
      throw new AppError("conflict", "This offer has sold out.");
    }
  }
}
