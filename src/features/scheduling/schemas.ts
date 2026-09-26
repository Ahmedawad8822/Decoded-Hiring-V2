// ============================================================================
// SCHEDULING ZOD SCHEMAS (Mission 08.1)
// ----------------------------------------------------------------------------
// Runtime validation schemas for scheduling domain inputs. These are used by
// the policy/service layer BEFORE any DB interaction, so invalid configuration
// is rejected at the boundary.
// ============================================================================

import { z } from "zod";
import { isValidIanaTimezone } from "./time";

// A Date that is actually valid. z.date() accepts a Date object but also
// accepts an `Invalid Date` (NaN), which we must reject at the boundary so
// malformed wall-clock input cannot silently corrupt scheduling arithmetic.
const validDate = z.date().refine((d) => !Number.isNaN(d.getTime()), {
  message: "Invalid date.",
});

/**
 * IANA timezone validator. Uses platform Intl support — no external deps.
 * Accepts canonical IANA identifiers AND platform-valid aliases (e.g. "UTC")
 * so that a valid timezone is never rejected merely because
 * `Intl.supportedValuesOf("timeZone")` omits its alias form.
 */
export const IANAtimezoneSchema = z.string().refine(
  (val): boolean => isValidIanaTimezone(val),
  { message: "Must be a valid IANA timezone (e.g. \"Europe/London\", \"Asia/Gaza\")." },
);

export const confirmationPolicySchema = z.enum(["AUTO_CONFIRM", "AHMED_APPROVAL", "REQUEST_ONLY"]);
export const bookingAccessModeSchema = z.enum(["FREE", "PAID_SESSION", "MANUAL_INVOICE", "PAYMENT_DISABLED"]);
export const meetingMethodSchema = z.enum([
  "GOOGLE_MEET",
  "EXTERNAL_LINK",
  "PHONE",
  "IN_PERSON",
  "TO_BE_CONFIRMED",
]);

/**
 * Input schema for creating a booking type. Policy-critical fields
 * (confirmationPolicy, accessMode, meetingMethod, attendeeLimit) are REQUIRED:
 * the application layer refuses silent defaults so the caller makes every
 * policy decision consciously. DB-level defaults remain only as a defensive
 * last line of defense.
 */
export const createBookingTypeSchema = z.object({
  slug: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .regex(/^[a-z0-9-]+$/i, {
      message: "Slug must contain only letters, numbers, and hyphens.",
    }),
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).nullable().optional(),
  durationMinutes: z.number().int().positive(),
  bufferBeforeMinutes: z.number().int().nonnegative(),
  bufferAfterMinutes: z.number().int().nonnegative(),
  minimumNoticeMinutes: z.number().int().nonnegative(),
  bookingHorizonDays: z.number().int().positive(),
  timezone: IANAtimezoneSchema,
  confirmationPolicy: confirmationPolicySchema,
  accessMode: bookingAccessModeSchema,
  meetingMethod: meetingMethodSchema,
  attendeeLimit: z.number().int().min(1),
});

/**
 * Input schema for creating an availability window.
 * startMinute/endMinute are minutes after local midnight in the booking
 * type's configured timezone.
 */
export const createAvailabilityWindowSchema = z
  .object({
    bookingTypeId: z.string().trim().min(1),
    weekday: z.number().int().min(0).max(6),
    startMinute: z.number().int().min(0).max(1439),
    endMinute: z.number().int().min(1).max(1440),
  })
  .superRefine((val, ctx) => {
    if (val.startMinute >= val.endMinute) {
      ctx.addIssue({
        code: "custom",
        path: ["startMinute"],
        message: "startMinute must be before endMinute.",
      });
    }
  });

/**
 * Input schema for ACQUIRING a slot hold.
 *
 * NOTE: there is intentionally NO `ownerToken` and NO `endAt` field.
 *  - endAt is derived from the booking type's `durationMinutes` (see D.4).
 *  - ownerToken is generated SERVER-SIDE via crypto.randomUUID() and returned
 *    ONLY to the winning acquirer (see generateOwnerToken + holds.ts).
 *  - The caller cannot choose the authoritative lease token, the slot
 *    duration, or a wall-clock time outside the booking type's policy.
 */
export const acquireSlotHoldSchema = z.object({
  bookingTypeId: z.string().trim().min(1),
  startAt: validDate,
  now: validDate,
  ttlMinutes: z.number().int().positive(),
});

/**
 * Input schema for releasing/consuming a slot hold. The caller presents the
 * server-generated ownerToken they received on acquisition — this is the
 * ownership-proving capability, NOT a value the browser gets to author.
 */
export const mutateSlotHoldSchema = z.object({
  bookingTypeId: z.string().trim().min(1),
  startAt: validDate,
  ownerToken: z.string().trim().min(1),
  now: validDate,
});

// Type helpers — kept in sync with the schemas above.
export type CreateBookingTypeInput = z.infer<typeof createBookingTypeSchema>;
export type CreateAvailabilityWindowInput = z.infer<typeof createAvailabilityWindowSchema>;
export type AcquireSlotHoldInput = z.infer<typeof acquireSlotHoldSchema>;
export type MutateSlotHoldInput = z.infer<typeof mutateSlotHoldSchema>;
