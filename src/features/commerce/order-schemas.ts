import { z } from "zod";

export const createOrderSchema = z.object({
  offerId: z.string().trim().min(1),
  bookingId: z.string().trim().min(1).optional().nullable(),
  userId: z.string().trim().min(1).optional().nullable(),
  requestKey: z.string().uuid(),
  customerEmail: z.string().trim().email().max(320),
  quantity: z.number().int().positive().max(100).optional().default(1),
  now: z.date(),
});

export const orderTransitionSchema = z.object({
  orderId: z.string().trim().min(1),
  expectedVersion: z.number().int().positive(),
  now: z.date(),
});

export const manualPaymentSchema = orderTransitionSchema.extend({
  note: z.string().trim().max(2000).optional().nullable(),
});

export const verifiedCallbackApplicationSchema = z.object({
  orderId: z.string().trim().min(1),
  callbackKey: z.string().trim().min(1).max(300),
  provider: z.string().trim().min(1).max(100).optional().nullable(),
  now: z.date(),
});

export const verifiedWebhookApplicationSchema = z.object({
  orderId: z.string().trim().min(1),
  providerState: z.string().trim().min(1).max(200),
  amountMinor: z.number().int().nonnegative().optional().nullable(),
  currency: z.string().trim().regex(/^[A-Z]{3}$/).optional().nullable(),
  rawBody: z.union([z.string(), z.instanceof(Uint8Array)]),
  signature: z.string().min(1),
  headers: z.record(z.string(), z.string()).optional(),
  provider: z.string().trim().min(1).max(100).optional().nullable(),
  now: z.date(),
});

export const orderFulfillmentSchema = orderTransitionSchema.extend({
  actorId: z.string().trim().min(1).max(200).optional().nullable(),
});

export type CreateOrderInput = z.infer<typeof createOrderSchema>;
export type OrderTransitionInput = z.infer<typeof orderTransitionSchema>;
export type ManualPaymentInput = z.infer<typeof manualPaymentSchema>;
export type VerifiedCallbackApplicationInput = z.infer<
  typeof verifiedCallbackApplicationSchema
>;
export type VerifiedWebhookApplicationInput = z.infer<
  typeof verifiedWebhookApplicationSchema
>;
export type OrderFulfillmentInput = z.infer<typeof orderFulfillmentSchema>;
