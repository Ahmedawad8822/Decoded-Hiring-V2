import { z } from "zod";

export const createBookingRequestSchema = z.object({
  bookingTypeId: z.string().trim().min(1),
  holdId: z.string().trim().min(1),
  holdAcquisitionKey: z.string().uuid(),
  requestKey: z.string().uuid(),
  requesterName: z.string().trim().min(1).max(160),
  requesterEmail: z.string().trim().email().max(320),
  requesterPhone: z.string().trim().max(80).optional().nullable(),
  notes: z.string().trim().max(4000).optional().nullable(),
  now: z.date(),
});

export const bookingTransitionSchema = z.object({
  bookingId: z.string().trim().min(1),
  expectedVersion: z.number().int().positive(),
  now: z.date(),
});

export const bookingDecisionSchema = bookingTransitionSchema.extend({
  reason: z.string().trim().max(2000).optional().nullable(),
});

export const rescheduleBookingSchema = bookingTransitionSchema.extend({
  newHoldId: z.string().trim().min(1),
  newHoldAcquisitionKey: z.string().uuid(),
  reason: z.string().trim().max(2000).optional().nullable(),
});

export type CreateBookingRequestInput = z.infer<typeof createBookingRequestSchema>;
export type BookingTransitionInput = z.infer<typeof bookingTransitionSchema>;
export type BookingDecisionInput = z.infer<typeof bookingDecisionSchema>;
export type RescheduleBookingInput = z.infer<typeof rescheduleBookingSchema>;
