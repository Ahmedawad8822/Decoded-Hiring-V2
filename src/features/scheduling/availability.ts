// ============================================================================
// CANONICAL SLOT GENERATION (Mission 08.1)
// ----------------------------------------------------------------------------
// Pure, deterministic slot generation from weekly availability windows + a
// booking type's policy. No DB, no external providers. All time arithmetic
// operates on canonical LOCAL candidate wall times resolved via localTimeToUtc,
// which applies the documented DST policy (skip nonexistent spring-forward
// gaps; pick the earlier occurrence for fall-back folds).
// ====================================================================

import { localTimeToUtc, getWeekdayInTz, NonexistentTimeError } from "./time";
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
 * DST-SAFE CANDIDATE GENERATION:
 * Rather than generating a UTC start instant and blindly incrementing in UTC
 * (which produces wrong UTC mappings, crashes inside spring-forward gaps, and
 * emits duplicate local wall-clock times during fall-back folds), generation
 * now operates from canonical LOCAL candidate wall times:
 *
 *   1. Buffers are applied in LOCAL minute space (window minutes + buffers).
 *   2. Candidates are emitted at duration-aligned LOCAL wall times
 *      (stepping in minutes, not UTC milliseconds).
 *   3. Each local candidate is resolved to a UTC instant via localTimeToUtc,
 *      which applies the documented DST policy:
 *      - Nonexistent local time (spring-forward gap) → NonexistentTimeError
 *        is caught and that candidate is SKIPPED (no crash, no phantom slot).
 *      - Ambiguous local time (fall-back fold) → resolved deterministically
 *        to the earlier UTC instant (the first / DST occurrence).
 *
 * As a result, exactly one canonical slot is emitted per valid local wall-clock
 * time. A window fully inside a spring-forward gap produces zero slots without
 * crashing; a window spanning a fall-back fold produces no duplicate slots.
 *
 * Filters applied (all in UTC instant space):
 *   - Only weekdays with configured availability windows
 *   - Slot must fit entirely within the effective window (buffers applied)
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
      // --- DST SAFE: operate in LOCAL minute space -------------------------
      // Apply buffers to the local window so buffer boundaries are expressed
      // in the same local wall-clock frame as the availability rule.
      const effectiveStartMinute = w.startMinute + bufferBeforeMinutes;
      const effectiveEndMinute = w.endMinute - bufferAfterMinutes;
      if (effectiveStartMinute >= effectiveEndMinute) continue;

      // Generate duration-aligned LOCAL candidates.
      let slotStartMinute = effectiveStartMinute;
      while (slotStartMinute + durationMinutes <= effectiveEndMinute) {

        // Resolve the local wall-clock candidate to a UTC instant using the
        // documented DST policy. A nonexistent local time (spring-forward
        // gap) throws NonexistentTimeError — skip that slot instead of
        // crashing the entire query.
        let slotStartUtc: Date;
        try {
          slotStartUtc = localTimeToUtc(utcDay, timezone, slotStartMinute);
        } catch (e) {
          if (e instanceof NonexistentTimeError) {
            slotStartMinute += durationMinutes;
            continue;
          }
          throw e;
        }

        const slotEndUtc = new Date(slotStartUtc.getTime() + durationMinutes * MS_PER_MINUTE);

        // Range filter
        if (slotStartUtc < rangeStart) {
          slotStartMinute += durationMinutes;
          continue;
        }
        if (slotEndUtc > rangeEnd) {
          break; // remaining slots also exceed rangeEnd
        }

        // Minimum notice filter
        if (slotStartUtc < deadline) {
          slotStartMinute += durationMinutes;
          continue;
        }

        // Booking horizon filter
        if (slotStartUtc > horizon) {
          break; // remaining slots also exceed horizon
        }

        const slotKey = buildSlotKey(bookingTypeId, slotStartUtc);
        slots.push({ startAt: new Date(slotStartUtc), endAt: new Date(slotEndUtc), slotKey });

        slotStartMinute += durationMinutes;
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
