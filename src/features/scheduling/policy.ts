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
import {
  createBookingTypeSchema,
  createAvailabilityWindowSchema,
  type CreateBookingTypeInput,
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
 * On a lost UNIQUE race (two concurrent inserts with the same slug),
 * returns the existing booking type.
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
      const existing = await db
        .select()
        .from(bookingTypes)
        .where(eq(bookingTypes.slug, parsed.slug))
        .get();
      if (existing) return existing;
      throw new Error(`Slug "${parsed.slug}" uniqueness violated but no row found on re-read.`);
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
