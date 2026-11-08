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

import { and, asc, eq, gt, gte, lt, or } from "drizzle-orm";

import {
  bookings,
  bookingTypes,
  bookingAvailabilityWindows,
  offers,
  slotHolds,
  type BookingType,
  type Offer,
} from "@/lib/db";
import { getDb, type Database } from "@/lib/db";
import {
  anonymousRateLimitFingerprint,
  PUBLIC_IP_LIMITS,
  consumePublicFixedWindowLimit,
  consumePublicIpLimit,
} from "@/features/public-intake/rate-limit";
import {
  UnconfiguredCommerceSchedulingProviders,
  type CommerceSchedulingProviders,
} from "./providers";
import { iterateCandidateSlots } from "./availability";

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_PUBLIC_SLOTS = 60;

export type PublicSchedulingKind = Extract<Offer["kind"], "COACHING" | "WORKSHOP">;

export type PublicSchedulingSlot = {
  startAt: string;
  endAt: string;
  slotKey: string;
};

export type PublicSchedulingDisabledReason =
  | "OFFER_MISSING"
  | "OFFER_INACTIVE"
  | "BOOKING_TYPE_MISSING"
  | "BOOKING_TYPE_INACTIVE"
  | "PROVIDER_UNAVAILABLE"
  | "PAID_OR_MANUAL"
  | "APPROVAL_REQUIRED"
  | "REQUEST_ONLY";

type PublicSchedulingEnabledBase = {
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
};

/**
 * Configuration-only projection (no slots, no availability reads). Safe to
 * render into a cached/ISR page shell: it changes only when Studio edits the
 * Offer or BookingType (which revalidates the page).
 */
export type PublicSchedulingConfig =
  | PublicSchedulingEnabledBase
  | { enabled: false; reason: Exclude<PublicSchedulingDisabledReason, "PROVIDER_UNAVAILABLE"> };

export type PublicSchedulingModel =
  | (PublicSchedulingEnabledBase & {
      slots: PublicSchedulingSlot[];
      rangeEnd: string;
    })
  | { enabled: false; reason: PublicSchedulingDisabledReason };

class PublicAvailabilityProviderError extends Error {
  constructor() {
    super("Configured calendar availability could not be verified.");
    this.name = "PublicAvailabilityProviderError";
  }
}

async function listAvailableSlots(db: Database, params: {
  bookingType: BookingType;
  rangeStart: Date;
  rangeEnd: Date;
  now: Date;
  providers?: CommerceSchedulingProviders;
}): Promise<PublicSchedulingSlot[]> {
  const providers =
    params.providers ?? UnconfiguredCommerceSchedulingProviders;
  const { bookingType } = params;
  if (!bookingType.active) return [];

  // One D1 batch shares a read snapshot and avoids three binding round trips.
  const [windows, holdRows, confirmedRows] = await db.batch([
    db.select().from(bookingAvailabilityWindows)
      .where(eq(bookingAvailabilityWindows.bookingTypeId, bookingType.id))
      .orderBy(asc(bookingAvailabilityWindows.weekday), asc(bookingAvailabilityWindows.startMinute)),
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
  try {
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
  } catch {
    // A configured calendar is an authoritative conflict input. If provider
    // readiness or free/busy cannot be verified, fail the public scheduler
    // closed instead of showing slots that may already be occupied or crashing
    // the product page.
    throw new PublicAvailabilityProviderError();
  }

  // Sweep busy intervals once as the ordered candidates advance. maxBusyEnd
  // handles nested/overlapping intervals without rescanning them per slot.
  const busyIntervals = providerBusy
    .map((busy) => ({ start: busy.startAt.getTime(), end: busy.endAt.getTime() }))
    .filter((busy) => !Number.isNaN(busy.start) && !Number.isNaN(busy.end))
    .sort((a, b) => a.start - b.start);
  let busyIndex = 0;
  let maxBusyEnd = -Infinity;
  const available: PublicSchedulingSlot[] = [];
  for (const slot of iterateCandidateSlots({ windows, ...params })) {
    if (blockedSlotKeys.has(slot.slotKey)) continue;
    const startMs = slot.startAt.getTime();
    const endMs = slot.endAt.getTime();
    while (busyIndex < busyIntervals.length && busyIntervals[busyIndex].start < endMs) {
      maxBusyEnd = Math.max(maxBusyEnd, busyIntervals[busyIndex++].end);
    }
    if (maxBusyEnd > startMs) continue;
    available.push({
      startAt: slot.startAt.toISOString(), endAt: slot.endAt.toISOString(), slotKey: slot.slotKey,
    });
    if (available.length === MAX_PUBLIC_SLOTS) break;
  }
  return available;
}

export async function consumePublicBookingAdmission(params: {
  bookingTypeId: string;
  requesterEmail: string;
  /** Salted client-IP hash; per-IP limit skipped when absent. */
  clientIpHash?: string | null;
  now?: Date;
  windowMinutes?: number;
  maxBookings?: number;
  maxBookingTypeBookings?: number;
}): Promise<boolean> {
  const now = params.now ?? new Date();
  const windowMinutes = Math.max(1, Math.min(params.windowMinutes ?? 15, 60));
  const maxBookings = Math.max(1, Math.min(params.maxBookings ?? 3, 10));
  const maxBookingTypeBookings = Math.max(
    maxBookings,
    Math.min(params.maxBookingTypeBookings ?? 8, 30),
  );

  // Consume the narrower identity budget first. If the broader booking-type
  // budget is already exhausted, only this requester's own quota is spent.
  // Both counters are atomic D1 UPSERTs, so parallel callers cannot all pass
  // a stale SELECT count before their booking writes commit.
  // The per-IP bucket comes before both, so an abusive IP spends neither the
  // requester's nor the shared booking-type budget.
  if (params.clientIpHash) {
    const ipAllowed = await consumePublicIpLimit({
      ipHash: params.clientIpHash,
      limit: PUBLIC_IP_LIMITS.booking,
      now,
    });
    if (!ipAllowed) return false;
  }
  const emailFingerprint = await anonymousRateLimitFingerprint(
    params.requesterEmail,
  );
  const emailAllowed = await consumePublicFixedWindowLimit({
    scopeKey: `booking:${params.bookingTypeId}:email:${emailFingerprint}`,
    now,
    windowMinutes,
    maxCount: maxBookings,
  });
  if (!emailAllowed) return false;

  return consumePublicFixedWindowLimit({
    scopeKey: `booking:${params.bookingTypeId}:burst`,
    now,
    windowMinutes,
    maxCount: maxBookingTypeBookings,
  });
}

/**
 * Offer/BookingType eligibility for self-service scheduling. Reads only the
 * configuration rows (no availability windows, holds or bookings), so the
 * public pages can cache it.
 */
async function readSchedulingSource(db: Database, params: { offerSlug: string; kind: PublicSchedulingKind }) {
  return db.select({ offer: offers, bookingType: bookingTypes })
    .from(offers)
    .leftJoin(bookingTypes, eq(offers.bookingTypeId, bookingTypes.id))
    .where(and(eq(offers.slug, params.offerSlug), eq(offers.kind, params.kind)))
    .get();
}

function schedulingConfig(
  source: Awaited<ReturnType<typeof readSchedulingSource>>,
  kind: PublicSchedulingKind,
): PublicSchedulingConfig {
  const offer = source?.offer;
  const bookingType = source?.bookingType;
  if (!offer) return { enabled: false, reason: "OFFER_MISSING" };
  if (!offer.active) return { enabled: false, reason: "OFFER_INACTIVE" };
  if (!offer.bookingTypeId) {
    return { enabled: false, reason: "BOOKING_TYPE_MISSING" };
  }

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

  return {
    enabled: true,
    offerSlug: offer.slug,
    offerKind: kind,
    bookingTypeId: bookingType.id,
    bookingTitle: bookingType.title,
    durationMinutes: bookingType.durationMinutes,
    timezone: bookingType.timezone,
    meetingMethod: bookingType.meetingMethod,
    confirmationPolicy: "AUTO_CONFIRM",
    accessMode: "FREE",
  };
}

export async function resolvePublicSchedulingConfig(params: {
  offerSlug: string;
  kind: PublicSchedulingKind;
}): Promise<PublicSchedulingConfig> {
  return schedulingConfig(await readSchedulingSource(await getDb(), params), params.kind);
}

export async function resolvePublicSchedulingModel(params: {
  offerSlug: string;
  kind: PublicSchedulingKind;
  now?: Date;
  rangeDays?: number;
  providers?: CommerceSchedulingProviders;
}): Promise<PublicSchedulingModel> {
  const db = await getDb();
  const source = await readSchedulingSource(db, params);
  const config = schedulingConfig(source, params.kind);
  if (!config.enabled) return config;

  const now = params.now ?? new Date();
  const rangeDays = Math.max(1, Math.min(params.rangeDays ?? 21, 31));
  const rangeEnd = new Date(now.getTime() + rangeDays * DAY_MS);
  let slots: PublicSchedulingSlot[];
  try {
    slots = await listAvailableSlots(db, {
      bookingType: source!.bookingType!,
      rangeStart: now,
      rangeEnd,
      now,
      providers: params.providers,
    });
  } catch (error: unknown) {
    if (error instanceof PublicAvailabilityProviderError) {
      return { enabled: false, reason: "PROVIDER_UNAVAILABLE" };
    }
    throw error;
  }

  return { ...config, slots, rangeEnd: rangeEnd.toISOString() };
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
