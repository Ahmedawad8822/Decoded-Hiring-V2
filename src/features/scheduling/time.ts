// ============================================================================
// SCHEDULING TIMEZONE UTILITIES (Mission 08.1)
// ----------------------------------------------------------------------------
// All persisted appointment/hold instants are UTC timestamps. The booking
// type's IANA timezone defines local weekday + local opening/closing windows.
//
// These helpers use ONLY platform-supported Intl primitives (available in
// Node 22+ and Cloudflare Workers). No external date library is introduced.
//
// Key invariants:
//   - isValidIanaTimezone: rejects invalid IANA names (and accepts aliases
//     such as "UTC" that Intl.supportedValuesOf may not enumerate).
//   - getWeekdayInTz: returns the local weekday (0=Sun..6=Sat) for a UTC instant
//   - getTimezoneOffsetMs: UTC offset in ms for an instant (DST-aware)
//   - localTimeToUtc: converts a UTC instant's local calendar day + local
//     minutes-after-midnight into the correct UTC instant, with explicit,
//     documented semantics for nonexistent (spring-forward gap) and ambiguous
//     (fall-back fold) wall times.
//
// localTimeToUtc semantics:
//   - NORMAL local time: exactly one valid UTC instant.
//   - NONEXISTENT local time (spring-forward gap): throws NonexistentTimeError.
//     It must NOT silently map to either branch of the gap.
//   - AMBIGUOUS local time (fall-back fold): picks a deterministic policy —
//     the EARLIER UTC instant (the first occurrence, i.e. DST/summer offset) —
//     and is the single documented behavior. (See AmbiguousTimeError handling.)
//
// The result round-trips: requested local calendar date/time -> UTC -> the same
// local calendar date/time (for normal and the deterministic ambiguous case).
// ============================================================================

const WEEKDAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

const MS_PER_HOUR = 60 * 60_000;

/**
 * Error thrown when a requested local wall-clock time does not exist because
 * it falls inside a DST spring-forward gap (e.g. America/New_York
 * 2026-03-08 02:30, which is skipped when clocks jump 2:00 -> 3:00 AM).
 */
export class NonexistentTimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonexistentTimeError";
  }
}

/**
 * Error thrown when a requested local wall-clock time is ambiguous because it
 * occurs twice during a DST fall-back (e.g. America/New_York 2026-11-01 01:30,
 * which happens once in EDT and once in EST). The resolver applies a
 * deterministic policy rather than throwing for ambiguous times, but the error
 * is exported so callers that require strict rejection can opt in.
 */
export class AmbiguousTimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AmbiguousTimeError";
  }
}

/**
 * Validate an IANA timezone string.
 *
 * Strategy:
 *  1. Fast path — accept if `Intl.supportedValuesOf("timeZone")` lists it.
 *     NOTE: this canonical list does NOT include every platform-accepted
 *     alias (e.g. some runtimes list "Etc/UTC" but not "UTC"). We therefore
 *     never return `false` from the fast path; we only short-circuit to
 *     `true`.
 *  2. Fallback — probe by formatting a known date. Real IANA zones (including
 *     aliases such as "UTC") format successfully; bogus names throw RangeError,
 *     which we treat as invalid.
 */
export function isValidIanaTimezone(tz: string): boolean {
  if (typeof tz !== "string" || tz.length === 0) return false;
  if (typeof Intl === "undefined" || typeof Intl.DateTimeFormat !== "function") return false;

  // Fast path: canonical enumerated list. Do NOT return false here — aliases
  // like "UTC" are valid IANA zones but may not be enumerated.
  try {
    if (typeof Intl.supportedValuesOf === "function") {
      if (Intl.supportedValuesOf("timeZone").includes(tz)) return true;
    }
  } catch {
    // supportedValuesOf may throw or be unavailable — fall through to probe.
  }

  // Fallback probe: an invalid IANA name raises RangeError. This accepts all
  // platform-valid zones, including aliases absent from supportedValuesOf.
  try {
    const dtf = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric" });
    return dtf.format(new Date("2024-01-01T00:00:00Z")) !== undefined;
  } catch {
    return false;
  }
}

/**
 * Return the local calendar date parts (year, month[1-12], day[1-31])
 * for a UTC instant in the given timezone.
 */
export function getLocalDateParts(date: Date, tz: string): { year: number; month: number; day: number } {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  });
  const parts = dtf.formatToParts(date);
  const result: { year?: number; month?: number; day?: number } = {};
  for (const part of parts) {
    if (part.type === "year") result.year = parseInt(part.value, 10);
    if (part.type === "month") result.month = parseInt(part.value, 10);
    if (part.type === "day") result.day = parseInt(part.value, 10);
  }
  return { year: result.year!, month: result.month!, day: result.day! };
}

/**
 * Return the local calendar wall-clock components (year, month, day, hour,
 * minute) for a UTC instant in the given timezone.
 */
export function getLocalWallClock(date: Date, tz: string): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
} {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = dtf.formatToParts(date);
  const result: { year?: number; month?: number; day?: number; hour?: number; minute?: number } = {};
  for (const part of parts) {
    if (part.type === "year") result.year = parseInt(part.value, 10);
    if (part.type === "month") result.month = parseInt(part.value, 10);
    if (part.type === "day") result.day = parseInt(part.value, 10);
    if (part.type === "hour") result.hour = parseInt(part.value, 10);
    if (part.type === "minute") result.minute = parseInt(part.value, 10);
  }
  return { year: result.year!, month: result.month!, day: result.day!, hour: result.hour!, minute: result.minute! };
}

/**
 * Return the local weekday (0=Sunday .. 6=Saturday) for a UTC instant in tz.
 */
export function getWeekdayInTz(date: Date, tz: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long" });
  const str = dtf.format(date).toLowerCase();
  return WEEKDAY_NAMES.indexOf(str);
}

/**
 * Return the UTC offset in milliseconds for a UTC instant in tz.
 * Handles DST automatically because the offset is looked up per-instant.
 *
 * The offset is the quantity to ADD to a UTC instant to obtain the local
 * wall-clock instant (negative for zones behind UTC, e.g. -18000000 for
 * America/New_York EST). This matches `Date.prototype.getTimezoneOffset()`
 * semantics: local = utc + getTimezoneOffsetMs(utc, tz).
 */
export function getTimezoneOffsetMs(date: Date, tz: string): number {
  // Use the "longOffset" form (e.g. "GMT+03:00", "GMT-04:00", "GMT+05:30").
  // Fall back to "shortOffset" which is supported in more runtimes.
  let offsetStr: string | undefined;
  try {
    const dtf = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" });
    const parts = dtf.formatToParts(date);
    offsetStr = parts.find((p) => p.type === "timeZoneName")?.value;
  } catch {
    // "longOffset" may be unsupported — try "shortOffset"
  }
  if (!offsetStr) {
    try {
      const dtf = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "shortOffset" });
      const parts = dtf.formatToParts(date);
      offsetStr = parts.find((p) => p.type === "timeZoneName")?.value;
    } catch {
      return 0;
    }
  }
  if (!offsetStr) return 0;
  const match = /GMT([+-])(\d{1,2}):?(\d{2})/i.exec(offsetStr);
  if (!match) return 0;
  const sign = match[1] === "+" ? 1 : -1;
  const hours = parseInt(match[2], 10);
  const minutes = parseInt(match[3], 10);
  return sign * (hours * 60 + minutes) * 60_000;
}

/**
 * Convert a UTC instant's local calendar day + local minutes-after-midnight
 * into the correct UTC Date instant.
 *
 * The "calendar day" is taken from the local date of `reference` in `tz`.
 * `localMinutes` is minutes after local midnight.
 *
 * Robust wall-time resolution:
 *   - The local wall-clock time (date + minutes) can map to 0 (nonexistent),
 *     1 (normal), or 2 (ambiguous) UTC instants on a DST transition day.
 *   - We probe the UTC offset at several points bracketing the wall-clock
 *     epoch to discover every distinct offset that applies around that instant.
 *     For each distinct offset, we compute a candidate UTC instant and validate
 *     it by ROUND-TRIPPING: formatting the candidate back to local must yield
 *     the exact requested wall-clock (same calendar date and time-of-day).
 *   - 0 validated candidates  -> the wall time does not exist        (throw)
 *   - 1 validated candidate   -> a normal wall time                 (return it)
 *   - 2 validated candidates  -> ambiguous (fall-back); deterministic
 *     policy = earliest UTC instant (first occurrence, DST/summer offset).
 *
 * Round-trip guarantee: requested local date/time -> UTC -> same local date/time.
 */
export function localTimeToUtc(reference: Date, tz: string, localMinutes: number): Date {
  const { year, month, day } = getLocalDateParts(reference, tz);
  // Wall-clock epoch: the UTC instant IF the offset were zero.
  const wallClockEpoch = Date.UTC(year, month - 1, day, 0, 0, 0, 0) + localMinutes * 60_000;

  // Discover distinct offsets that may apply to this wall-clock instant by
  // sampling several UTC points around it. On a transition day this surfaces
  // both the pre- and post-transition offsets; on a normal day, all probes
  // agree. Round-trip validation then selects exactly the UTC instants whose
  // local representation is the requested wall-clock.
  const probeOffsets: number[] = [];
  for (const probe of [
    wallClockEpoch,
    wallClockEpoch + MS_PER_HOUR,
    wallClockEpoch - MS_PER_HOUR,
    wallClockEpoch + 24 * MS_PER_HOUR,
    wallClockEpoch - 24 * MS_PER_HOUR,
  ]) {
    const offset = getTimezoneOffsetMs(new Date(probe), tz);
    if (!probeOffsets.includes(offset)) probeOffsets.push(offset);
  }

  const targetHour = Math.floor(localMinutes / 60);
  const targetMinute = localMinutes % 60;

  const valid: { utc: number; offset: number }[] = [];
  for (const offset of probeOffsets) {
    const utc = wallClockEpoch - offset;
    if (roundTripsToWallClock(utc, tz, year, month, day, targetHour, targetMinute)) {
      if (!valid.find((c) => c.utc === utc)) valid.push({ utc, offset });
    }
  }

  if (valid.length === 0) {
    throw new NonexistentTimeError(
      `Local time ${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")} ` +
        `${String(targetHour).padStart(2, "0")}:${String(targetMinute).padStart(2, "0")} ` +
        `does not exist in "${tz}" (DST spring-forward gap).`,
    );
  }

  if (valid.length === 2) {
    // Deterministic ambiguous-time policy: prefer the EARLIER UTC instant,
    // i.e. the first occurrence of the wall time (the DST/summer offset).
    // This is the single documented behavior for fall-back folds.
    valid.sort((a, b) => a.utc - b.utc);
  }

  return new Date(valid[0].utc);
}

/**
 * Verify that `utc` (an instant) formats, in `tz`, to the exact wall-clock
 * (year, month, day, hour, minute) we are targeting.
 */
function roundTripsToWallClock(
  utc: number,
  tz: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): boolean {
  const lc = getLocalWallClock(new Date(utc), tz);
  return (
    lc.year === year &&
    lc.month === month &&
    lc.day === day &&
    lc.hour === hour &&
    lc.minute === minute
  );
}
