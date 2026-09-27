export const BUSINESS_EVENT_NAMES = [
  "offer_cta_clicked",
  "booking_started",
  "slot_held",
  "booking_requested",
  "booking_approved",
  "booking_confirmed",
  "booking_declined",
  "booking_cancelled",
  "booking_rescheduled",
  "checkout_started",
  "payment_confirmed",
  "payment_failed",
] as const;

export type BusinessEventName = (typeof BUSINESS_EVENT_NAMES)[number];

export type BusinessEventMetadataValue =
  | string
  | number
  | boolean
  | null;

export type BusinessEventInput = {
  dedupeKey: string;
  eventName: BusinessEventName;
  subjectType?: "OFFER" | "BOOKING_TYPE" | "BOOKING" | "ORDER" | "PUBLIC";
  subjectId?: string | null;
  offerId?: string | null;
  bookingTypeId?: string | null;
  bookingId?: string | null;
  orderId?: string | null;
  route?: string | null;
  surface?: string | null;
  metadata?: Record<string, BusinessEventMetadataValue>;
  occurredAt?: Date;
};

export type BusinessEventCounts = Record<BusinessEventName, number>;

export type BusinessEventSummary = {
  windowDays: number;
  windowStart: string;
  generatedAt: string;
  total: number;
  counts: BusinessEventCounts;
  lastEventAt: string | null;
};
