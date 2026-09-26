import { z } from "zod";
import { slugSchema } from "@/features/publishing/types";

export const offerKindSchema = z.enum(["COURSE", "COACHING", "WORKSHOP", "PRODUCT"]);

export const offerAccessModeSchema = z.enum([
  "FREE",
  "PAID_ONE_TIME",
  "PAID_SESSION",
  "MANUAL_INVOICE",
  "PAYMENT_DISABLED",
  "COMING_SOON",
]);

const safeCtaUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .refine((value) => {
    if (/^\/(?!\/)[^\s]*$/.test(value)) return true;
    if (/^#[A-Za-z0-9][^\s]*$/.test(value)) return true;
    if (/^mailto:[^\s@]+@[^\s@]+\.[^\s@]+$/i.test(value)) return true;
    try {
      const parsed = new URL(value);
      return parsed.protocol === "https:";
    } catch {
      return false;
    }
  }, "CTA URL must be a same-site path/fragment, mailto address, or HTTPS URL.");

export const createOfferSchema = z.object({
  kind: offerKindSchema,
  courseId: z.string().trim().min(1).optional().nullable(),
  bookingTypeId: z.string().trim().min(1).optional().nullable(),
  title: z.string().trim().min(3).max(160),
  slug: slugSchema,
  accessMode: offerAccessModeSchema,
  currency: z.string().trim().regex(/^[A-Z]{3}$/, "Currency must be a 3-letter ISO-style code.").optional().nullable(),
  amountMinor: z.number().int().nonnegative().optional().nullable(),
  alternativeCtaLabel: z.string().trim().min(1).max(100).optional().nullable(),
  alternativeCtaUrl: safeCtaUrlSchema.optional().nullable(),
  active: z.boolean().optional().default(true),
});

export const updateOfferSchema = z.object({
  id: z.string().trim().min(1),
  kind: offerKindSchema.optional(),
  courseId: z.string().trim().min(1).optional().nullable(),
  bookingTypeId: z.string().trim().min(1).optional().nullable(),
  title: z.string().trim().min(3).max(160).optional(),
  slug: slugSchema.optional(),
  accessMode: offerAccessModeSchema.optional(),
  currency: z
    .string()
    .trim()
    .regex(/^[A-Z]{3}$/, "Currency must be a 3-letter ISO-style code.")
    .optional()
    .nullable(),
  amountMinor: z.number().int().nonnegative().optional().nullable(),
  alternativeCtaLabel: z.string().trim().min(1).max(100).optional().nullable(),
  alternativeCtaUrl: safeCtaUrlSchema.optional().nullable(),
  active: z.boolean().optional(),
});

export type CreateOfferInput = z.input<typeof createOfferSchema>;
export type UpdateOfferInput = z.input<typeof updateOfferSchema>;
export type OfferKindInput = z.infer<typeof offerKindSchema>;
export type OfferAccessModeInput = z.infer<typeof offerAccessModeSchema>;
