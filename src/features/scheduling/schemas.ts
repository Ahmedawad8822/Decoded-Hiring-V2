// ============================================================================
// SCHEDULING ZOD SCHEMAS (Mission 08.1)
// ----------------------------------------------------------------------------
// Runtime validation schemas for scheduling domain inputs. These are used by
// the policy/service layer before any DB interaction, so invalid configuration
// is rejected at the boundary.
// ============================================================================

import { z } from "zod";
import { isValidIanaTimezone } from "./time";

/**
 * IANA timezone validator. Uses platform Intl support — no external deps.
 */
export const IANAtimezoneSchema = z.string().refine(
  (val) => isValidIanaTimezone(val),
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
 * Input schema for creating a booking type. All fields are explicitly provided
 * (no silent defaults) so the caller must make policy decisions consciously.
 */
export const createBookingTypeSchema = z.object({
  slug: z.string().trim().min(1).max(120).regex(/^[a-z0-9-]+$/i, {
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
  confirmationPolicy: confirmationPolicySchema.optional(),
  accessMode: bookingAccessModeSchema.optional(),
  meetingMethod: meetingMethodSchema.optional(),
  attendeeLimit: z.number().int().min(1).optional(),
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
 * Input schema for acquiring a slot hold.
 */
export const acquireSlotHoldSchema = z.object({
  bookingTypeId: z.string().trim().min(1),
  startAt: z.date(),
  endAt: z.date(),
  ownerToken: z.string().trim().min(1),
  now: z.date(),
  ttlMinutes: z.number().int().positive(),
});

/**
 * Input schema for releasing/consuming a slot hold.
 */
export const mutateSlotHoldSchema = z.object({
  bookingTypeId: z.string().trim().min(1),
  startAt: z.date(),
  ownerToken: z.string().trim().min(1),
  now: z.date(),
});

// Type helpers — kept in sync with the schemas above.
export type CreateBookingTypeInput = z.infer<typeof createBookingTypeSchema>;
export type CreateAvailabilityWindowInput = z.infer<typeof createAvailabilityWindowSchema>;
export type AcquireSlotHoldInput = z.infer<typeof acquireSlotHoldSchema>;
export type MutateSlotHoldInput = z.infer<typeof mutateSlotHoldSchema>;
