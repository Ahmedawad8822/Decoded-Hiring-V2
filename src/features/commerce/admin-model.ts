export type CommerceAdminPageKey =
  | "offers"
  | "bookingTypes"
  | "requested"
  | "approvals"
  | "upcoming"
  | "orders"
  | "effects"
  | "courses";

export type CommerceAdminPageRequest = Partial<Record<CommerceAdminPageKey, number>>;

export type BoundedAdminList<T> = {
  items: T[];
  total: number;
  limit: number;
  page: number;
  totalPages: number;
  truncated: boolean;
};

export type CommerceAdminOffer = {
  id: string;
  kind: "COURSE" | "COACHING" | "WORKSHOP" | "PRODUCT";
  courseId: string | null;
  bookingTypeId: string | null;
  title: string;
  slug: string;
  accessMode:
    | "FREE"
    | "PAID_ONE_TIME"
    | "PAID_SESSION"
    | "MANUAL_INVOICE"
    | "PAYMENT_DISABLED"
    | "COMING_SOON";
  currency: string | null;
  amountMinor: number | null;
  alternativeCtaLabel: string | null;
  alternativeCtaUrl: string | null;
  active: boolean;
  updatedAt: string;
};

export type CommerceAdminBookingType = {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  durationMinutes: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  minimumNoticeMinutes: number;
  bookingHorizonDays: number;
  timezone: string;
  confirmationPolicy: "AUTO_CONFIRM" | "AHMED_APPROVAL" | "REQUEST_ONLY";
  accessMode: "FREE" | "PAID_SESSION" | "MANUAL_INVOICE" | "PAYMENT_DISABLED";
  meetingMethod:
    | "GOOGLE_MEET"
    | "EXTERNAL_LINK"
    | "PHONE"
    | "IN_PERSON"
    | "TO_BE_CONFIRMED";
  attendeeLimit: number;
  active: boolean;
};

export type CommerceAdminAvailabilityWindow = {
  id: string;
  bookingTypeId: string;
  weekday: number;
  startMinute: number;
  endMinute: number;
};

export type CommerceAdminBooking = {
  id: string;
  bookingTypeId: string;
  bookingTypeTitle: string;
  confirmationPolicy: "AUTO_CONFIRM" | "AHMED_APPROVAL" | "REQUEST_ONLY";
  requesterName: string;
  requesterEmail: string;
  startAt: string;
  endAt: string;
  status:
    | "REQUESTED"
    | "PENDING_APPROVAL"
    | "CONFIRMED"
    | "COMPLETED"
    | "CANCELLED"
    | "DECLINED";
  version: number;
};

export type CommerceAdminOrder = {
  id: string;
  offerId: string;
  offerTitle: string;
  accessMode: string;
  customerEmail: string;
  amountMinor: number | null;
  currency: string | null;
  status: string;
  version: number;
  createdAt: string;
};

export type CommerceAdminProviderStatus = {
  kind: "payment" | "calendar" | "mailbox" | "meeting";
  provider: string | null;
  configured: boolean;
  capabilities: string[];
  statusError?: string | null;
};

export type CommerceAdminOrchestrationEffect = {
  id: string;
  subjectType: string;
  subjectId: string;
  effectType: string;
  providerKind: string;
  status: string;
  attemptCount: number;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  updatedAt: string;
};

export type CommerceAdminCourse = {
  id: string;
  title: string;
  slug: string;
  status: string;
};

export type CommerceAdminBookingHistory = {
  id: string;
  bookingId: string;
  action: string;
  fromStatus: string | null;
  toStatus: string;
  actorId: string | null;
  createdAt: string;
};

export type CommerceAdminOrderHistory = {
  id: string;
  orderId: string;
  fromStatus: string | null;
  toStatus: string;
  source: string;
  createdAt: string;
};

export type CommerceAdminPaymentEvent = {
  id: string;
  orderId: string;
  source: string;
  provider: string | null;
  state: string;
  createdAt: string;
};

export type CommerceAdminDashboard = {
  generatedAt: string;
  summary: {
    activeOffers: number;
    activeBookingTypes: number;
    approvalQueue: number;
    requestedBookings: number;
    upcomingBookings: number;
    openOrders: number;
    blockedEffects: number;
  };
  offers: BoundedAdminList<CommerceAdminOffer>;
  bookingTypes: BoundedAdminList<CommerceAdminBookingType>;
  windows: BoundedAdminList<CommerceAdminAvailabilityWindow>;
  requestedBookings: BoundedAdminList<CommerceAdminBooking>;
  approvalQueue: BoundedAdminList<CommerceAdminBooking>;
  upcomingBookings: BoundedAdminList<CommerceAdminBooking>;
  orders: BoundedAdminList<CommerceAdminOrder>;
  orchestrationEffects: BoundedAdminList<CommerceAdminOrchestrationEffect>;
  providers: CommerceAdminProviderStatus[];
  courses: BoundedAdminList<CommerceAdminCourse>;
  linkedOfferBookingTypeIds: string[];
};

export type CommerceAdminBookingAudit = {
  bookingId: string;
  history: BoundedAdminList<CommerceAdminBookingHistory>;
};

export type CommerceAdminOrderAudit = {
  orderId: string;
  history: BoundedAdminList<CommerceAdminOrderHistory>;
  paymentEvents: BoundedAdminList<CommerceAdminPaymentEvent>;
};
