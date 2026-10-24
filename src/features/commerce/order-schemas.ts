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
  callbackPayload: z.string(),
  provider: z.string().trim().min(1).max(100).optional().nullable(),
  now: z.date(),
});

export const verifiedWebhookApplicationSchema = z.object({
  orderId: z.string().trim().min(1),
  rawBody: z.union([z.string(), z.instanceof(Uint8Array)]),
  signature: z.string().min(1),
  headers: z.record(z.string(), z.string()).optional(),
  provider: z.string().trim().min(1).max(100).optional().nullable(),
  now: z.date(),
});

export const orderFulfillmentSchema = orderTransitionSchema.extend({
  actorId: z.string().trim().min(1).max(200).optional().nullable(),
});

export type CreateOrderInput = z.input<typeof createOrderSchema>;
export type OrderTransitionInput = z.input<typeof orderTransitionSchema>;
export type ManualPaymentInput = z.input<typeof manualPaymentSchema>;
export type VerifiedCallbackApplicationInput = z.input<
  typeof verifiedCallbackApplicationSchema
>;
export type VerifiedWebhookApplicationInput = z.input<
  typeof verifiedWebhookApplicationSchema
>;
export type OrderFulfillmentInput = z.input<typeof orderFulfillmentSchema>;
