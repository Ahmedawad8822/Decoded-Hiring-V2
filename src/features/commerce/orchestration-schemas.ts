import { z } from "zod";

export const orchestrationSubjectTypeSchema = z.enum(["ORDER", "BOOKING"]);
export const orchestrationProviderKindSchema = z.enum([
  "internal",
  "payment",
  "calendar",
  "mailbox",
  "meeting",
]);
export const orchestrationEffectTypeSchema = z.enum([
  "PAYMENT_CHECKOUT_CREATE",
  "ORDER_FULFILL",
  "CALENDAR_CREATE",
  "CALENDAR_UPDATE",
  "CALENDAR_CANCEL",
  "MAIL_CONFIRMATION",
  "MAIL_RESCHEDULE",
  "MAIL_CANCELLATION",
  "MAIL_REMINDER",
]);

export const enqueueEffectSchema = z.object({
  subjectType: orchestrationSubjectTypeSchema,
  subjectId: z.string().trim().min(1),
  effectType: orchestrationEffectTypeSchema,
  providerKind: orchestrationProviderKindSchema,
  idempotencyKey: z.string().trim().min(1).max(300),
  dependsOnEffectId: z.string().trim().min(1).optional().nullable(),
  payload: z.record(z.string(), z.unknown()),
  now: z.date(),
});

export const processEffectSchema = z.object({
  effectId: z.string().trim().min(1),
  now: z.date(),
  leaseSeconds: z.number().int().min(10).max(900).optional().default(60),
});

export const paymentCheckoutPayloadSchema = z.object({
  orderId: z.string().trim().min(1),
  successUrl: z.string().url().refine((value) => value.startsWith("https://")),
  cancelUrl: z.string().url().refine((value) => value.startsWith("https://")),
});

export const bookingEffectPayloadSchema = z.object({
  bookingId: z.string().trim().min(1),
});

export type EnqueueEffectInput = z.infer<typeof enqueueEffectSchema>;
export type ProcessEffectInput = z.infer<typeof processEffectSchema>;
