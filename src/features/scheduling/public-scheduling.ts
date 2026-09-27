// ============================================================================
// PUBLIC SCHEDULING READ MODEL (Mission 08.6)
// ----------------------------------------------------------------------------
// Public pages receive only a truthful, safe scheduling projection. D1 remains
// business truth. Slot leases, ownership tokens and provider metadata never
// leave the server.
//
// 08.6 deliberately enables self-service booking only for FREE + AUTO_CONFIRM.
// Paid/manual/approval/request-only flows remain lead/contact-first until their
// remaining payment/admin UX is implemented.
// ============================================================================

import { and, eq, gt, gte, lt, or } from "drizzle-orm";

import {
  bookings,
  bookingTypes,
  slotHolds,
  type BookingType,
  type Offer,
} from "@/lib/db";
import { getDb } from "@/lib/db";
import { getOfferBySlugForKind } from "@/features/offers/service";
import {
  UnconfiguredCommerceSchedulingProviders,
  type CommerceSchedulingProviders,
} from "./providers";
import { generateCandidateSlots } from "./availability";
import { getBookingTypeById, getBookingTypeWindows } from "./policy";

const DAY_MS = 24 * 60 * 60 * 1000;

export type PublicSchedulingKind = Extract<Offer["kind"], "COACHING" | "WORKSHOP">;

export type PublicSchedulingSlot = {
  startAt: string;
  endAt: string;
  slotKey: string;
};

export type PublicSchedulingModel =
  | {
      enabled: true;
      offerSlug: string;
      offerKind: PublicSchedulingKind;
      bookingTypeId: string;
      bookingTitle: string;
      durationMinutes: number;
      timezone: string;
      meetingMethod: BookingType["meetingMethod"];
      confirmationPolicy: "AUTO_CONFIRM";
      accessMode: "FREE";
      slots: PublicSchedulingSlot[];
      rangeEnd: string;
    }
  | {
      enabled: false;
      reason:
        | "OFFER_MISSING"
        | "OFFER_INACTIVE"
        | "BOOKING_TYPE_MISSING"
        | "BOOKING_TYPE_INACTIVE"
        | "PAID_OR_MANUAL"
        | "APPROVAL_REQUIRED"
        | "REQUEST_ONLY";
    };

function overlaps(
  startA: Date,
  endA: Date,
  startB: Date,
  endB: Date,
): boolean {
  return startA < endB && endA > startB;
}

async function listAvailableSlots(params: {
  bookingTypeId: string;
  rangeStart: Date;
  rangeEnd: Date;
  now: Date;
  providers?: CommerceSchedulingProviders;
}): Promise<PublicSchedulingSlot[]> {
  const providers =
    params.providers ?? UnconfiguredCommerceSchedulingProviders;
  const bookingType = await getBookingTypeById(params.bookingTypeId);
  if (!bookingType || !bookingType.active) return [];

  const windows = await getBookingTypeWindows(bookingType.id);
  const candidates = generateCandidateSlots({
    bookingType,
    windows,
    rangeStart: params.rangeStart,
    rangeEnd: params.rangeEnd,
    now: params.now,
  });
  if (candidates.length === 0) return [];

  const db = await getDb();
  const [holdRows, confirmedRows] = await Promise.all([
    db
      .select({
        slotKey: slotHolds.slotKey,
        status: slotHolds.status,
        expiresAt: slotHolds.expiresAt,
      })
      .from(slotHolds)
      .where(
        and(
          eq(slotHolds.bookingTypeId, bookingType.id),
          gte(slotHolds.startAt, params.rangeStart),
          lt(slotHolds.startAt, params.rangeEnd),
          or(
            eq(slotHolds.status, "CONSUMED"),
            and(
              eq(slotHolds.status, "HELD"),
              gt(slotHolds.expiresAt, params.now),
            ),
          ),
        ),
      ),
    db
      .select({ slotKey: bookings.slotKey })
      .from(bookings)
      .where(
        and(
          eq(bookings.bookingTypeId, bookingType.id),
          eq(bookings.status, "CONFIRMED"),
          gte(bookings.startAt, params.rangeStart),
          lt(bookings.startAt, params.rangeEnd),
        ),
      ),
  ]);

  const blockedSlotKeys = new Set<string>([
    ...holdRows.map((row) => row.slotKey),
    ...confirmedRows.map((row) => row.slotKey),
  ]);

  let providerBusy: Array<{ startAt: Date; endAt: Date }> = [];
  const calendarStatus = await providers.calendar.getStatus();
  if (calendarStatus.configured) {
    const busy = await providers.calendar.getFreeBusy({
      calendarId: "decoded-hiring-primary",
      rangeStart: params.rangeStart,
      rangeEnd: params.rangeEnd,
    });
    providerBusy = busy
      .filter((entry) => entry.busy)
      .map((entry) => ({ startAt: entry.startAt, endAt: entry.endAt }));
  }

  return candidates
    .filter((slot) => !blockedSlotKeys.has(slot.slotKey))
    .filter(
      (slot) =>
        !providerBusy.some((busy) =>
          overlaps(slot.startAt, slot.endAt, busy.startAt, busy.endAt),
        ),
    )
    .map((slot) => ({
      startAt: slot.startAt.toISOString(),
      endAt: slot.endAt.toISOString(),
      slotKey: slot.slotKey,
    }));
}

export async function resolvePublicSchedulingModel(params: {
  offerSlug: string;
  kind: PublicSchedulingKind;
  now?: Date;
  rangeDays?: number;
  providers?: CommerceSchedulingProviders;
}): Promise<PublicSchedulingModel> {
  const offer = await getOfferBySlugForKind(params.offerSlug, params.kind);
  if (!offer) return { enabled: false, reason: "OFFER_MISSING" };
  if (!offer.active) return { enabled: false, reason: "OFFER_INACTIVE" };
  if (!offer.bookingTypeId) {
    return { enabled: false, reason: "BOOKING_TYPE_MISSING" };
  }

  const bookingType = await getBookingTypeById(offer.bookingTypeId);
  if (!bookingType) {
    return { enabled: false, reason: "BOOKING_TYPE_MISSING" };
  }
  if (!bookingType.active) {
    return { enabled: false, reason: "BOOKING_TYPE_INACTIVE" };
  }

  if (offer.accessMode !== "FREE") {
    return { enabled: false, reason: "PAID_OR_MANUAL" };
  }
  if (bookingType.confirmationPolicy === "AHMED_APPROVAL") {
    return { enabled: false, reason: "APPROVAL_REQUIRED" };
  }
  if (bookingType.confirmationPolicy === "REQUEST_ONLY") {
    return { enabled: false, reason: "REQUEST_ONLY" };
  }

  const now = params.now ?? new Date();
  const rangeDays = Math.max(1, Math.min(params.rangeDays ?? 21, 31));
  const rangeEnd = new Date(now.getTime() + rangeDays * DAY_MS);
  const slots = await listAvailableSlots({
    bookingTypeId: bookingType.id,
    rangeStart: now,
    rangeEnd,
    now,
    providers: params.providers,
  });

  return {
    enabled: true,
    offerSlug: offer.slug,
    offerKind: params.kind,
    bookingTypeId: bookingType.id,
    bookingTitle: bookingType.title,
    durationMinutes: bookingType.durationMinutes,
    timezone: bookingType.timezone,
    meetingMethod: bookingType.meetingMethod,
    confirmationPolicy: "AUTO_CONFIRM",
    accessMode: "FREE",
    slots,
    rangeEnd: rangeEnd.toISOString(),
  };
}

export async function resolvePublicBookableSlot(params: {
  offerSlug: string;
  kind: PublicSchedulingKind;
  startAt: Date;
  now?: Date;
  providers?: CommerceSchedulingProviders;
}): Promise<{
  model: Extract<PublicSchedulingModel, { enabled: true }>;
  slot: PublicSchedulingSlot;
} | null> {
  const now = params.now ?? new Date();
  const model = await resolvePublicSchedulingModel({
    offerSlug: params.offerSlug,
    kind: params.kind,
    now,
    rangeDays: 31,
    providers: params.providers,
  });
  if (!model.enabled) return null;

  const slot = model.slots.find(
    (candidate) =>
      candidate.startAt === params.startAt.toISOString(),
  );
  return slot ? { model, slot } : null;
}
