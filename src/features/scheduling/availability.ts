// ============================================================================
// CANONICAL SLOT GENERATION (Mission 08.1)
// ----------------------------------------------------------------------------
// Pure, deterministic slot generation from weekly availability windows + a
// booking type's policy. No DB, no external providers. All time arithmetic
// operates on UTC instants with an explicit IANA timezone policy.
// ============================================================================

import { localTimeToUtc, getWeekdayInTz } from "./time";
import type { BookingType, BookingAvailabilityWindow, CanonicalSlot } from "./types";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MS_PER_MINUTE = 60_000;

/**
 * Build the deterministic business identity of a canonical slot.
 * Format: `<bookingTypeId>:<startAt.toISOString()>`
 *
 * Example: `bt_coaching_01:2026-10-04T07:00:00.000Z`
 *
 * This is the canonical identity used by the slot-hold table's UNIQUE
 * constraint and by all acquire/release/consume operations.
 */
export function buildSlotKey(bookingTypeId: string, startAt: Date): string {
  return `${bookingTypeId}:${startAt.toISOString()}`;
}

/**
 * Generate canonical candidate slots for a date range.
 *
 * The iteration walks UTC calendar days overlapping the requested range
 * (with one-day padding on each side to cover timezone-boundary spillover),
 * computes the local weekday in the booking type's IANA timezone, and emits
 * duration-aligned slot start/end pairs within configured windows.
 *
 * Filters applied:
 *   - Only weekdays with configured availability windows
 *   - Slot must fit entirely within the window (buffers applied to boundaries)
 *   - Minimum notice: now + minimumNoticeMinutes <= slot.startAt
 *   - Booking horizon: slot.startAt <= now + bookingHorizonDays
 *   - Slot must fall within [rangeStart, rangeEnd]
 *
 * Returns slots sorted by startAt ascending.
 */
export function generateCandidateSlots(params: {
  bookingType: BookingType;
  windows: BookingAvailabilityWindow[];
  rangeStart: Date;
  rangeEnd: Date;
  now: Date;
}): CanonicalSlot[] {
  const {
    id: bookingTypeId,
    durationMinutes,
    bufferBeforeMinutes,
    bufferAfterMinutes,
    minimumNoticeMinutes,
    bookingHorizonDays,
    timezone,
  } = params.bookingType;

  const { rangeStart, rangeEnd, now, windows } = params;

  // Group windows by weekday for O(1) lookup.
  const windowsByWeekday = new Map<number, BookingAvailabilityWindow[]>();
  for (const w of windows) {
    const existing = windowsByWeekday.get(w.weekday) ?? [];
    existing.push(w);
    windowsByWeekday.set(w.weekday, existing);
  }

  const slots: CanonicalSlot[] = [];

  // Iterate UTC days overlapping [rangeStart, rangeEnd] with 1-day padding.
  // The padding covers TZ boundary spillover: a UTC day near a TZ boundary
  // can belong to two local weekdays. Generating both and letting the
  // range filter prune is correct (at most a few extra candidates).
  const utcStart = floorUtcDay(rangeStart);
  const utcEnd = floorUtcDay(rangeEnd);
  const iterStart = new Date(utcStart.getTime() - MS_PER_DAY);
  const iterEnd = new Date(utcEnd.getTime() + MS_PER_DAY);

  const deadline = new Date(now.getTime() + minimumNoticeMinutes * MS_PER_MINUTE);
  const horizon = new Date(now.getTime() + bookingHorizonDays * MS_PER_DAY);

  for (let t = iterStart.getTime(); t <= iterEnd.getTime(); t += MS_PER_DAY) {
    const utcDay = new Date(t);
    const weekday = getWeekdayInTz(utcDay, timezone);
    const dayWindows = windowsByWeekday.get(weekday);
    if (!dayWindows || dayWindows.length === 0) continue;

    for (const w of dayWindows) {
      // Compute UTC start/end of this local window on this day.
      const windowStartUtc = localTimeToUtc(utcDay, timezone, w.startMinute);
      const windowEndUtc = localTimeToUtc(utcDay, timezone, w.endMinute);

      // Apply buffers: availability effectively starts after bufferBefore
      // and ends before bufferAfter.
      const effectiveStart = new Date(windowStartUtc.getTime() + bufferBeforeMinutes * MS_PER_MINUTE);
      const effectiveEnd = new Date(windowEndUtc.getTime() - bufferAfterMinutes * MS_PER_MINUTE);

      if (effectiveStart.getTime() >= effectiveEnd.getTime()) continue;

      // Generate duration-aligned slots within [effectiveStart, effectiveEnd].
      let slotStart = new Date(effectiveStart);
      while (slotStart.getTime() + durationMinutes * MS_PER_MINUTE <= effectiveEnd.getTime()) {
        const slotEnd = new Date(slotStart.getTime() + durationMinutes * MS_PER_MINUTE);

        // Range filter
        if (slotStart < rangeStart) {
          slotStart = new Date(slotStart.getTime() + durationMinutes * MS_PER_MINUTE);
          continue;
        }
        if (slotEnd > rangeEnd) {
          break; // remaining slots also exceed rangeEnd
        }

        // Minimum notice filter
        if (slotStart < deadline) {
          slotStart = new Date(slotStart.getTime() + durationMinutes * MS_PER_MINUTE);
          continue;
        }

        // Booking horizon filter
        if (slotStart > horizon) {
          break; // remaining slots also exceed horizon
        }

        const slotKey = buildSlotKey(bookingTypeId, slotStart);
        slots.push({ startAt: new Date(slotStart), endAt: new Date(slotEnd), slotKey });

        slotStart = new Date(slotStart.getTime() + durationMinutes * MS_PER_MINUTE);
      }
    }
  }

  // Sort by startAt ascending for deterministic output.
  slots.sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
  return slots;
}

/** Floor a Date to midnight UTC. */
function floorUtcDay(date: Date): Date {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}
