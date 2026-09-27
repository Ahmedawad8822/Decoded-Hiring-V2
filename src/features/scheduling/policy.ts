// ============================================================================
// SCHEDULING POLICY / SERVICE LAYER (Mission 08.1)
// ----------------------------------------------------------------------------
// Booking type CRUD + availability window management. All inputs are
// validated with Zod runtime schemas before touching the DB.
//
// Slug uniqueness uses SELECT-then-INSERT with UNIQUE-race recovery, mirroring
// the existing enrollments/courses pattern.
//
// Window overlap is REJECTED at write time (documented policy: reject, do not
// silently merge). See Docs/Engineering/MISSION-08-COMMERCE-SCHEDULING.md.
// ============================================================================

import { eq, and } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { bookingTypes, bookingAvailabilityWindows } from "@/lib/db";
import { isUniqueConstraintError } from "@/lib/db/sqlite-errors";
import type { BookingType, BookingAvailabilityWindow } from "@/lib/db";
import { SchedulingDomainError } from "./errors";
import {
  createBookingTypeSchema,
  updateBookingTypeSchema,
  createAvailabilityWindowSchema,
  type CreateBookingTypeInput,
  type UpdateBookingTypeInput,
  type CreateAvailabilityWindowInput,
} from "./schemas";

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().slice(0, 12)}`;
}

// ---------------------------------------------------------------------------
// Booking Type CRUD
// ---------------------------------------------------------------------------

/**
 * Create a booking type. Rejects if the slug is already taken.
 *
 * (H) On a lost UNIQUE(slug) race (two concurrent inserts with the same slug),
 * the request is REJECTED with a clear domain error rather than silently
 * returning the existing row. This guarantees a losing caller can never observe
 * (or accidentally adopt) the winner's policy configuration.
 */
export async function createBookingType(data: CreateBookingTypeInput): Promise<BookingType> {
  const parsed = createBookingTypeSchema.parse(data);
  const db = await getDb();
  const now = new Date();
  const id = newId("bt");

  try {
    await db.insert(bookingTypes).values({
      id,
      slug: parsed.slug,
      title: parsed.title,
      description: parsed.description ?? null,
      durationMinutes: parsed.durationMinutes,
      bufferBeforeMinutes: parsed.bufferBeforeMinutes,
      bufferAfterMinutes: parsed.bufferAfterMinutes,
      minimumNoticeMinutes: parsed.minimumNoticeMinutes,
      bookingHorizonDays: parsed.bookingHorizonDays,
      timezone: parsed.timezone,
      confirmationPolicy: parsed.confirmationPolicy,
      accessMode: parsed.accessMode,
      meetingMethod: parsed.meetingMethod,
      attendeeLimit: parsed.attendeeLimit,
      active: true,
      createdAt: now,
      updatedAt: now,
    });
  } catch (error: unknown) {
    if (isUniqueConstraintError(error)) {
      // (H) On a lost UNIQUE constraint race, RE-READ by parsed.slug to
      // classify the error precisely:
      //  1. If the slug exists in the DB → it is a genuine duplicate; reject
      //     with a domain error naming the slug. We deliberately do NOT return
      //     the existing row so a losing caller cannot observe the winner's
      //     policy configuration.
      //  2. If the slug does NOT exist (the UNIQUE violation came from a
      //     different constraint) → rethrow the ORIGINAL database error so the
      //     caller can diagnose the real cause rather than receiving a
      //     misleading "slug already exists" message.
      const existing = await db
        .select()
        .from(bookingTypes)
        .where(eq(bookingTypes.slug, parsed.slug))
        .get();
      if (existing) {
        throw new SchedulingDomainError(
          `Booking type with slug "${parsed.slug}" already exists.`,
          "DUPLICATE_SLUG",
        );
      }
      // Not a slug collision — rethrow the original database error.
      throw error;
    }
    throw error;
  }

  const created = await db
    .select()
    .from(bookingTypes)
    .where(eq(bookingTypes.slug, parsed.slug))
    .get();
  return created!;
}

/**
 * Look up a booking type by slug. Returns null if not found.
 */
export async function updateBookingType(data: UpdateBookingTypeInput): Promise<BookingType> {
  const parsed = updateBookingTypeSchema.parse(data);
  const db = await getDb();
  const current = await db
    .select()
    .from(bookingTypes)
    .where(eq(bookingTypes.id, parsed.id))
    .get();
  if (!current) {
    throw new SchedulingDomainError("Booking type not found.", "BOOKING_TYPE_NOT_FOUND");
  }

  const changes: Partial<typeof bookingTypes.$inferInsert> = {
    updatedAt: new Date(),
  };
  if (parsed.slug !== undefined) changes.slug = parsed.slug;
  if (parsed.title !== undefined) changes.title = parsed.title;
  if (parsed.description !== undefined) changes.description = parsed.description ?? null;
  if (parsed.durationMinutes !== undefined) changes.durationMinutes = parsed.durationMinutes;
  if (parsed.bufferBeforeMinutes !== undefined) changes.bufferBeforeMinutes = parsed.bufferBeforeMinutes;
  if (parsed.bufferAfterMinutes !== undefined) changes.bufferAfterMinutes = parsed.bufferAfterMinutes;
  if (parsed.minimumNoticeMinutes !== undefined) changes.minimumNoticeMinutes = parsed.minimumNoticeMinutes;
  if (parsed.bookingHorizonDays !== undefined) changes.bookingHorizonDays = parsed.bookingHorizonDays;
  if (parsed.timezone !== undefined) changes.timezone = parsed.timezone;
  if (parsed.confirmationPolicy !== undefined) changes.confirmationPolicy = parsed.confirmationPolicy;
  if (parsed.accessMode !== undefined) changes.accessMode = parsed.accessMode;
  if (parsed.meetingMethod !== undefined) changes.meetingMethod = parsed.meetingMethod;
  if (parsed.attendeeLimit !== undefined) changes.attendeeLimit = parsed.attendeeLimit;
  if (parsed.active !== undefined) changes.active = parsed.active;

  try {
    await db.update(bookingTypes).set(changes).where(eq(bookingTypes.id, current.id));
  } catch (error: unknown) {
    if (isUniqueConstraintError(error)) {
      throw new SchedulingDomainError(
        `Booking type with slug "${parsed.slug ?? current.slug}" already exists.`,
        "DUPLICATE_SLUG",
      );
    }
    throw error;
  }

  const updated = await db
    .select()
    .from(bookingTypes)
    .where(eq(bookingTypes.id, current.id))
    .get();
  if (!updated) throw new Error("Booking type update committed but could not be re-read.");
  return updated;
}

export async function getBookingTypeBySlug(slug: string): Promise<BookingType | null> {
  const db = await getDb();
  const row = await db
    .select()
    .from(bookingTypes)
    .where(eq(bookingTypes.slug, slug))
    .get();
  return row || null;
}

/**
 * Look up a booking type by id.
 */
export async function getBookingTypeById(id: string): Promise<BookingType | null> {
  const db = await getDb();
  const row = await db
    .select()
    .from(bookingTypes)
    .where(eq(bookingTypes.id, id))
    .get();
  return row || null;
}

/**
 * Return a booking type by slug only if it is active.
 */
export async function getActiveBookingType(slug: string): Promise<BookingType | null> {
  const db = await getDb();
  const row = await db
    .select()
    .from(bookingTypes)
    .where(and(eq(bookingTypes.slug, slug), eq(bookingTypes.active, true)))
    .get();
  return row || null;
}

/**
 * Return all active booking types, ordered by title.
 */
export async function listAllBookingTypes(): Promise<BookingType[]> {
  const db = await getDb();
  const { asc } = await import("drizzle-orm");
  return db.select().from(bookingTypes).orderBy(asc(bookingTypes.title));
}

export async function listBookingTypes(): Promise<BookingType[]> {
  const db = await getDb();
  const { asc } = await import("drizzle-orm");
  return db
    .select()
    .from(bookingTypes)
    .where(eq(bookingTypes.active, true))
    .orderBy(asc(bookingTypes.title));
}

// ---------------------------------------------------------------------------
// Availability Window CRUD
// ---------------------------------------------------------------------------

/**
 * Check whether a new window overlaps any existing window for the same
 * booking type and weekday. Overlapping windows are REJECTED (documented
 * policy: reject at write time, do not silently merge).
 *
 * Overlap test: existing.startMinute < newEnd AND existing.endMinute > newStart
 */
export async function checkWindowOverlap(
  bookingTypeId: string,
  weekday: number,
  startMinute: number,
  endMinute: number,
): Promise<boolean> {
  const db = await getDb();
  const existing = await db
    .select({
      startMinute: bookingAvailabilityWindows.startMinute,
      endMinute: bookingAvailabilityWindows.endMinute,
    })
    .from(bookingAvailabilityWindows)
    .where(
      and(
        eq(bookingAvailabilityWindows.bookingTypeId, bookingTypeId),
        eq(bookingAvailabilityWindows.weekday, weekday),
      )
    );

  for (const w of existing) {
    if (w.startMinute < endMinute && w.endMinute > startMinute) {
      return true;
    }
  }
  return false;
}

/**
 * Create an availability window.
 * Validates input, verifies the booking type exists and is active,
 * rejects exact duplicates and overlapping windows.
 */
export async function createAvailabilityWindow(
  data: CreateAvailabilityWindowInput,
): Promise<BookingAvailabilityWindow> {
  const parsed = createAvailabilityWindowSchema.parse(data);
  const db = await getDb();

  const bookingType = await db
    .select()
    .from(bookingTypes)
    .where(eq(bookingTypes.id, parsed.bookingTypeId))
    .get();
  if (!bookingType) {
    throw new Error("Booking type not found.");
  }
  if (!bookingType.active) {
    throw new Error("Cannot add availability windows to an inactive booking type.");
  }

  const duplicate = await db
    .select()
    .from(bookingAvailabilityWindows)
    .where(
      and(
        eq(bookingAvailabilityWindows.bookingTypeId, parsed.bookingTypeId),
        eq(bookingAvailabilityWindows.weekday, parsed.weekday),
        eq(bookingAvailabilityWindows.startMinute, parsed.startMinute),
        eq(bookingAvailabilityWindows.endMinute, parsed.endMinute),
      )
    )
    .get();
  if (duplicate) {
    throw new Error(
      `Duplicate window: weekday ${parsed.weekday} (${parsed.startMinute}-${parsed.endMinute}) already exists for this booking type.`,
    );
  }

  const overlap = await checkWindowOverlap(
    parsed.bookingTypeId,
    parsed.weekday,
    parsed.startMinute,
    parsed.endMinute,
  );
  if (overlap) {
    throw new Error(
      `Overlapping window detected for weekday ${parsed.weekday} (${parsed.startMinute}-${parsed.endMinute}). ` +
        "This scheduling policy rejects overlapping availability windows.",
    );
  }

  const id = newId("baw");
  const now = new Date();
  try {
    await db.insert(bookingAvailabilityWindows).values({
      id,
      bookingTypeId: parsed.bookingTypeId,
      weekday: parsed.weekday,
      startMinute: parsed.startMinute,
      endMinute: parsed.endMinute,
      createdAt: now,
    });
  } catch (error: unknown) {
    if (isUniqueConstraintError(error)) {
      throw new Error("Window already exists (concurrent insert detected).");
    }
    throw error;
  }

  const created = await db
    .select()
    .from(bookingAvailabilityWindows)
    .where(eq(bookingAvailabilityWindows.id, id))
    .get();
  return created!;
}

/**
 * Return all availability windows for a booking type, ordered by weekday
 * then startMinute. Used by slot generation.
 */
export async function getBookingTypeWindows(
  bookingTypeId: string,
): Promise<BookingAvailabilityWindow[]> {
  const db = await getDb();
  const { asc } = await import("drizzle-orm");
  return db
    .select()
    .from(bookingAvailabilityWindows)
    .where(eq(bookingAvailabilityWindows.bookingTypeId, bookingTypeId))
    .orderBy(asc(bookingAvailabilityWindows.weekday), asc(bookingAvailabilityWindows.startMinute));
}

/**
 * Return a booking type and its windows by slug, only if the booking type
 * is active.
 */
export async function getActiveBookingTypeWithWindows(
  slug: string,
): Promise<{ bookingType: BookingType; windows: BookingAvailabilityWindow[] } | null> {
  const bookingType = await getActiveBookingType(slug);
  if (!bookingType) return null;
  const windows = await getBookingTypeWindows(bookingType.id);
  return { bookingType, windows };
}


/** Admin configuration helper: remove one exact availability window. */
export async function deleteAvailabilityWindow(id: string): Promise<boolean> {
  const db = await getDb();
  const existing = await db
    .select({ id: bookingAvailabilityWindows.id })
    .from(bookingAvailabilityWindows)
    .where(eq(bookingAvailabilityWindows.id, id))
    .get();
  if (!existing) return false;
  await db
    .delete(bookingAvailabilityWindows)
    .where(eq(bookingAvailabilityWindows.id, id));
  return true;
}
