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
//   - isValidIanaTimezone: rejects invalid IANA names
//   - getWeekdayInTz: returns the local weekday (0=Sun..6=Sat) for a UTC instant
//   - localTimeToUtc: converts a UTC date's local calendar day + local minutes
//     into the correct UTC instant, using DST-aware iteration
// ============================================================================

const WEEKDAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/**
 * Validate an IANA timezone string using the platform's supported values
 * when available (Node 22+ / modern V8). Falls back to a formatting probe
 * for runtimes without `Intl.supportedValuesOf`.
 */
export function isValidIanaTimezone(tz: string): boolean {
  if (typeof Intl === "undefined" || typeof Intl.DateTimeFormat !== "function") {
    return false;
  }
  try {
    if (typeof Intl.supportedValuesOf === "function") {
      return Intl.supportedValuesOf("timeZone").includes(tz);
    }
  } catch {
    // supportedValuesOf may not list all zones in every runtime — fall through
  }
  // Fallback: probe by formatting a known date. Invalid zones throw RangeError.
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
 * Uses iterative DST correction: we start with a wall-clock guess and repeatedly
 * adjust by the offset until the offset stabilises (max 4 iterations).
 */
export function localTimeToUtc(reference: Date, tz: string, localMinutes: number): Date {
  const { year, month, day } = getLocalDateParts(reference, tz);
  // Wall-clock epoch: the UTC instant IF the offset were zero.
  const wallClockEpoch = Date.UTC(year, month - 1, day, 0, 0, 0, 0) + localMinutes * 60_000;
  let t = wallClockEpoch;
  for (let i = 0; i < 4; i++) {
    const offset = getTimezoneOffsetMs(new Date(t), tz);
    const corrected = wallClockEpoch - offset;
    if (corrected === t) break;
    t = corrected;
  }
  return new Date(t);
}
