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

// One shared anonymous front-funnel budget prevents analytics abuse from
// consuming the D1 write allowance needed by real booking/content flows.
// At continuous saturation this budget admits at most 9,600 events/day;
// with one limiter-row write + one event-row write per admission, that is
// at most 19,200 D1 row writes/day before business traffic.
export const PUBLIC_ANALYTICS_BUDGET = {
  scopeKey: "analytics:public-funnel",
  windowMinutes: 15,
  maxCount: 100,
} as const;

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
