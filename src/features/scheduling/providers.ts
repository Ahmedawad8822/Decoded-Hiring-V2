// ============================================================================
// SCHEDULING PROVIDER CONTRACTS (Mission 08.1)
// ----------------------------------------------------------------------------
// Narrow, provider-neutral TypeScript interfaces for the external systems
// scheduling will eventually integrate with. These contracts contain NO
// Google/Stripe/Lemon-Squeezy-specific request/response types.
//
// Concrete providers are NOT implemented in this slice. Unconfigured/no-op
// implementations are provided as fail-closed placeholders so the domain can
// be exercised without any external dependency.
// ============================================================================

// -- Calendar ----------------------------------------------------------------

export interface CalendarEventRef {
  id: string;
  provider: string;
}

export interface FreeBusyRequest {
  calendarId: string;
  rangeStart: Date;
  rangeEnd: Date;
}

export interface FreeBusyEntry {
  startAt: Date;
  endAt: Date;
  busy: boolean;
}

export interface CalendarProvider {
  getFreeBusy(request: FreeBusyRequest): Promise<FreeBusyEntry[]>;
  createEvent(params: CreateCalendarEventParams): Promise<CalendarEventRef>;
  updateEvent(ref: CalendarEventRef, params: Partial<CreateCalendarEventParams>): Promise<void>;
  cancelEvent(ref: CalendarEventRef): Promise<void>;
}

export interface CreateCalendarEventParams {
  calendarId: string;
  summary: string;
  description?: string | null;
  startAt: Date;
  endAt: Date;
  attendees?: EmailAttendee[];
  location?: string | null;
}

export interface EmailAttendee {
  email: string;
  displayName?: string | null;
}

// -- Payment -----------------------------------------------------------------

export interface CheckoutResult {
  checkoutUrl: string;
  checkoutId: string;
}

export interface PaymentGateway {
  createCheckout(params: CreateCheckoutParams): Promise<CheckoutResult>;
  verifyCallback(params: VerifyCallbackParams): Promise<VerifyCallbackResult>;
  refundOrCancel(checkoutId: string): Promise<void>;
}

export interface CreateCheckoutParams {
  priceId: string;
  quantity: number;
  successUrl: string;
  cancelUrl: string;
}

export interface VerifyCallbackParams {
  checkoutId: string;
  sessionId: string;
}

export interface VerifyCallbackResult {
  verified: boolean;
  paid: boolean;
  checkoutId: string;
}

// -- Mailbox -----------------------------------------------------------------

export interface SendEmailParams {
  to: string;
  subject: string;
  html: string;
}

export interface MailboxProvider {
  sendConfirmation(params: SendEmailParams): Promise<void>;
  sendReschedule(params: SendEmailParams): Promise<void>;
  sendCancellation(params: SendEmailParams): Promise<void>;
  sendReminder(params: SendEmailParams): Promise<void>;
}

// -- Meeting -----------------------------------------------------------------

export interface MeetingLocationParams {
  method: MeetingMethod;
  overrideUrl?: string | null;
  overridePhone?: string | null;
  overrideAddress?: string | null;
}

export interface MeetingProvider {
  resolveMeetingLocation(params: MeetingLocationParams): Promise<ResolvedMeetingLocation>;
}

export interface ResolvedMeetingLocation {
  method: MeetingMethod;
  url?: string | null;
  phone?: string | null;
  address?: string | null;
  displayText: string;
}

// Re-use the domain enum for meeting methods.
import type { MeetingMethod } from "./types";

// -- Fail-closed unconfigured providers --------------------------------------

export class SchedulingProviderError extends Error {
  public readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "SchedulingProviderError";
    this.code = code;
  }
}

/**
 * Fail-closed PaymentGateway: createCheckout throws immediately.
 * It never returns a fake "paid: true" or dummy checkout success.
 */
export const UnconfiguredPaymentGateway: PaymentGateway = {
  createCheckout: async () => {
    throw new SchedulingProviderError(
      "Payment provider is not configured. Cannot create checkout.",
      "PROVIDER_NOT_CONFIGURED",
    );
  },
  verifyCallback: async () => {
    throw new SchedulingProviderError(
      "Payment provider is not configured. Cannot verify callback.",
      "PROVIDER_NOT_CONFIGURED",
    );
  },
  refundOrCancel: async () => {
    throw new SchedulingProviderError(
      "Payment provider is not configured. Cannot refund.",
      "PROVIDER_NOT_CONFIGURED",
    );
  },
};

/**
 * No-op CalendarProvider: signals that external free/busy was NOT consulted.
 * Calendar availability for this slice works with policy only when no
 * calendar provider is configured. Callers must NOT interpret empty free/busy
 * results as "all slots free".
 */
export const NullCalendarProvider: CalendarProvider = {
  getFreeBusy: async () => {
    throw new SchedulingProviderError(
      "No calendar provider is configured. Availability must not query external calendars.",
      "PROVIDER_NOT_CONFIGURED",
    );
  },
  createEvent: async () => {
    throw new SchedulingProviderError(
      "No calendar provider is configured. Cannot create events.",
      "PROVIDER_NOT_CONFIGURED",
    );
  },
  updateEvent: async () => {
    throw new SchedulingProviderError(
      "No calendar provider is configured. Cannot update events.",
      "PROVIDER_NOT_CONFIGURED",
    );
  },
  cancelEvent: async () => {
    throw new SchedulingProviderError(
      "No calendar provider is configured. Cannot cancel events.",
      "PROVIDER_NOT_CONFIGURED",
    );
  },
};
