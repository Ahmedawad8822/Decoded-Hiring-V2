// ============================================================================
// CANONICAL SLOT GENERATION (Mission 08.1)
// ----------------------------------------------------------------------------
// Pure, deterministic slot generation from weekly availability windows + a
// booking type's policy. No DB, no external providers. All time arithmetic
// operates on canonical LOCAL candidate wall times resolved via localTimeToUtc,
// which applies the documented DST policy (skip nonexistent spring-forward
// gaps; pick the earlier occurrence for fall-back folds).
// ====================================================================

import { createLocalTimeResolver, getLocalDateParts, NonexistentTimeError } from "./time";
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
type CandidateSlotParams = {
  bookingType: BookingType;
  windows: BookingAvailabilityWindow[];
  rangeStart: Date;
  rangeEnd: Date;
  now: Date;
};

export function generateCandidateSlots(params: CandidateSlotParams): CanonicalSlot[] {
  return Array.from(iterateCandidateSlots(params));
}

/** Ordered, lazy version of the canonical generator: consumers can stop early. */
export function* iterateCandidateSlots(params: CandidateSlotParams): Generator<CanonicalSlot> {
  const { bookingType, windows, rangeStart, rangeEnd, now } = params;
  const { id, durationMinutes, bufferBeforeMinutes, bufferAfterMinutes, timezone } = bookingType;
  const durationMs = durationMinutes * MS_PER_MINUTE;
  const startMs = Math.max(rangeStart.getTime(), now.getTime() + bookingType.minimumNoticeMinutes * MS_PER_MINUTE);
  const endMs = rangeEnd.getTime();
  const horizonMs = now.getTime() + bookingType.bookingHorizonDays * MS_PER_DAY;
  const resolveLocal = createLocalTimeResolver(timezone);

  // Expand weekly rules once in local minute space, retaining duplicates and
  // sorting even if callers supply unsorted/overlapping windows.
  const minutesByWeekday = new Map<number, number[]>();
  for (const window of windows) {
    const minutes = minutesByWeekday.get(window.weekday) ?? [];
    for (let minute = window.startMinute + bufferBeforeMinutes;
      minute + durationMinutes <= window.endMinute - bufferAfterMinutes;
      minute += durationMinutes) {
      minutes.push(minute);
    }
    minutesByWeekday.set(window.weekday, minutes);
  }
  for (const minutes of minutesByWeekday.values()) minutes.sort((a, b) => a - b);

  // Preserve the previous UTC-day padding and its local-date multiplicity.
  // Around historical date-line changes two reference days can map to the same
  // local day. Group them so duplicates remain in global UTC start order.
  const days = new Map<number, { reference: Date; count: number }>();
  const firstDay = floorUtcDay(rangeStart).getTime() - MS_PER_DAY;
  const lastDay = floorUtcDay(rangeEnd).getTime() + MS_PER_DAY;
  for (let epoch = firstDay; epoch <= lastDay; epoch += MS_PER_DAY) {
    const reference = new Date(epoch);
    const { year, month, day } = getLocalDateParts(reference, timezone);
    const localDay = Date.UTC(year, month - 1, day);
    const existing = days.get(localDay);
    if (existing) existing.count++;
    else days.set(localDay, { reference, count: 1 });
  }

  for (const [localDay, { reference, count }] of [...days].sort(([a], [b]) => a - b)) {
    const minutes = minutesByWeekday.get(new Date(localDay).getUTCDay());
    if (!minutes) continue;
    for (const minute of minutes) {
      let startAt: Date;
      try {
        startAt = resolveLocal(reference, minute);
      } catch (error) {
        if (error instanceof NonexistentTimeError) continue;
        throw error;
      }
      const epoch = startAt.getTime();
      if (epoch < startMs) continue;
      if (epoch + durationMs > endMs || epoch > horizonMs) break;
      const endAt = new Date(epoch + durationMs);
      const slotKey = buildSlotKey(id, startAt);
      for (let i = 0; i < count; i++) {
        yield { startAt: i ? new Date(epoch) : startAt, endAt: i ? new Date(epoch + durationMs) : endAt, slotKey };
      }
    }
  }
}

/** Floor a Date to midnight UTC. */
function floorUtcDay(date: Date): Date {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}
