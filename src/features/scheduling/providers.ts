// ============================================================================
// COMMERCE + SCHEDULING PROVIDER CONTRACTS (Mission 08.4)
// ----------------------------------------------------------------------------
// Provider-neutral boundaries for payment, calendar, mailbox and meeting
// capabilities. Domain/business identity stays internal to Decoded Hiring.
// Provider identifiers are adapter metadata only.
//
// No concrete SDKs, credentials, provider selection or production activation
// live in this module. Unconfigured implementations fail closed and never
// manufacture successful external side effects.
// ============================================================================

import type { MeetingMethod } from "./types";

// -- Shared provider primitives ------------------------------------------------

export type ProviderKind = "payment" | "calendar" | "mailbox" | "meeting";

export interface ProviderRuntimeStatus {
  kind: ProviderKind;
  provider: string | null;
  configured: boolean;
  capabilities: readonly string[];
}

export type SchedulingProviderErrorCode =
  | "PROVIDER_NOT_CONFIGURED"
  | "INVALID_CONFIGURATION"
  | "UNSUPPORTED_OPERATION"
  | "INVALID_PROVIDER_RESPONSE"
  | "SIGNATURE_VERIFICATION_FAILED";

export class SchedulingProviderError extends Error {
  public readonly code: SchedulingProviderErrorCode;
  public readonly providerKind: ProviderKind;
  public readonly operation: string;
  public readonly retryable: boolean;

  constructor(params: {
    message: string;
    code: SchedulingProviderErrorCode;
    providerKind: ProviderKind;
    operation: string;
    retryable?: boolean;
  }) {
    super(params.message);
    this.name = "SchedulingProviderError";
    this.code = params.code;
    this.providerKind = params.providerKind;
    this.operation = params.operation;
    this.retryable = params.retryable ?? false;
  }
}

function notConfigured(
  providerKind: ProviderKind,
  operation: string,
  message: string,
): never {
  throw new SchedulingProviderError({
    message,
    code: "PROVIDER_NOT_CONFIGURED",
    providerKind,
    operation,
    retryable: false,
  });
}

// -- Calendar -----------------------------------------------------------------

export interface CalendarEventRef {
  /** Provider-owned event identifier. Never used as Decoded Hiring identity. */
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

export interface EmailAttendee {
  email: string;
  displayName?: string | null;
}

export interface CreateCalendarEventParams {
  /** Internal Decoded Hiring booking identity. */
  bookingId: string;
  /** Stable internal key reused for retries of the same side effect. */
  idempotencyKey: string;
  calendarId: string;
  summary: string;
  description?: string | null;
  startAt: Date;
  endAt: Date;
  timezone: string;
  attendees?: EmailAttendee[];
  location?: string | null;
}

export interface CreateCalendarEventResult {
  event: CalendarEventRef;
  /** Provider-returned/resolved meeting or physical location metadata. */
  location?: ResolvedMeetingLocation | null;
}

export interface UpdateCalendarEventParams {
  bookingId: string;
  idempotencyKey: string;
  summary?: string;
  description?: string | null;
  startAt?: Date;
  endAt?: Date;
  timezone?: string;
  attendees?: EmailAttendee[];
  location?: string | null;
}

export interface CancelCalendarEventParams {
  bookingId: string;
  idempotencyKey: string;
  reason?: string | null;
}

export interface CalendarProvider {
  getStatus(): Promise<ProviderRuntimeStatus>;
  getFreeBusy(request: FreeBusyRequest): Promise<FreeBusyEntry[]>;
  createEvent(params: CreateCalendarEventParams): Promise<CreateCalendarEventResult>;
  updateEvent(
    ref: CalendarEventRef,
    params: UpdateCalendarEventParams,
  ): Promise<CreateCalendarEventResult>;
  cancelEvent(ref: CalendarEventRef, params: CancelCalendarEventParams): Promise<void>;
}

// -- Payment ------------------------------------------------------------------

/**
 * Provider-neutral payment state produced by an external payment adapter.
 *
 * Deliberately excludes FULFILLED. A provider may prove payment, cancellation
 * or refund, but only Decoded Hiring's internal orchestration may mark an order
 * fulfilled / grant durable product access.
 */
export type NormalizedPaymentState =
  | "PENDING"
  | "REQUIRES_ACTION"
  | "PAID"
  | "CANCELLED"
  | "FAILED"
  | "REFUNDED";

export interface CheckoutResult {
  checkoutUrl: string;
  /** Provider-owned checkout/session identifier, adapter metadata only. */
  providerCheckoutId: string;
  provider: string;
  expiresAt?: Date | null;
}

export interface PaymentCustomer {
  email: string;
  name?: string | null;
}

export interface CreateCheckoutParams {
  /** Internal Decoded Hiring order identity. */
  orderId: string;
  /** Internal Decoded Hiring offer identity. */
  offerId: string;
  amountMinor: number;
  currency: string;
  quantity: number;
  customer?: PaymentCustomer | null;
  successUrl: string;
  cancelUrl: string;
  idempotencyKey: string;
  metadata?: Readonly<Record<string, string>>;
}

export interface VerifyCallbackParams {
  orderId: string;
  /** Opaque callback body/query representation owned by the adapter boundary. */
  callbackPayload: string;
}

export type VerifyCallbackResult =
  | {
      verified: true;
      orderId: string;
      state: NormalizedPaymentState;
      providerCheckoutId?: string | null;
      providerPaymentId?: string | null;
      providerEventId?: string | null;
      amountMinor?: number | null;
      currency?: string | null;
    }
  | {
      verified: false;
      orderId: string;
      state?: never;
      providerCheckoutId?: string | null;
      providerPaymentId?: never;
      providerEventId?: string | null;
      amountMinor?: never;
      currency?: never;
    };

export interface VerifyWebhookSignatureParams {
  rawBody: string | Uint8Array;
  signature: string;
  headers?: Readonly<Record<string, string>>;
}

export type VerifyWebhookSignatureResult =
  | {
      valid: true;
      providerEventId?: string | null;
    }
  | {
      valid: false;
      providerEventId?: never;
    };

export interface NormalizePaymentStateParams {
  orderId: string;
  providerState: string;
  amountMinor?: number | null;
  currency?: string | null;
}

export interface NormalizePaymentStateResult {
  orderId: string;
  providerState: string;
  state: NormalizedPaymentState;
  amountMinor?: number | null;
  currency?: string | null;
}

export interface RefundOrCancelParams {
  orderId: string;
  providerPaymentId?: string | null;
  providerCheckoutId?: string | null;
  amountMinor?: number | null;
  reason?: string | null;
  idempotencyKey: string;
}

export interface PaymentGateway {
  getStatus(): Promise<ProviderRuntimeStatus>;
  createCheckout(params: CreateCheckoutParams): Promise<CheckoutResult>;
  verifyCallback(params: VerifyCallbackParams): Promise<VerifyCallbackResult>;
  verifyWebhookSignature(
    params: VerifyWebhookSignatureParams,
  ): Promise<VerifyWebhookSignatureResult>;
  normalizePaymentState(
    params: NormalizePaymentStateParams,
  ): Promise<NormalizePaymentStateResult>;
  refundOrCancel(params: RefundOrCancelParams): Promise<void>;
}

// -- Mailbox ------------------------------------------------------------------

export interface SendEmailParams {
  /** Internal booking identity for audit/orchestration correlation. */
  bookingId: string;
  idempotencyKey: string;
  to: string;
  subject: string;
  html: string;
  text?: string | null;
  replyTo?: string | null;
}

export interface MailboxMessageRef {
  id: string;
  provider: string;
}

export interface MailboxProvider {
  getStatus(): Promise<ProviderRuntimeStatus>;
  sendConfirmation(params: SendEmailParams): Promise<MailboxMessageRef>;
  sendReschedule(params: SendEmailParams): Promise<MailboxMessageRef>;
  sendCancellation(params: SendEmailParams): Promise<MailboxMessageRef>;
  sendReminder(params: SendEmailParams): Promise<MailboxMessageRef>;
}

// -- Meeting ------------------------------------------------------------------

export interface MeetingLocationParams {
  /** Internal booking identity for retry/audit correlation. */
  bookingId: string;
  idempotencyKey: string;
  method: MeetingMethod;
  overrideUrl?: string | null;
  overridePhone?: string | null;
  overrideAddress?: string | null;
}

export interface MeetingProvider {
  getStatus(): Promise<ProviderRuntimeStatus>;
  resolveMeetingLocation(
    params: MeetingLocationParams,
  ): Promise<ResolvedMeetingLocation>;
}

export interface ResolvedMeetingLocation {
  method: MeetingMethod;
  url?: string | null;
  phone?: string | null;
  address?: string | null;
  displayText: string;
}

// -- Fail-closed unconfigured providers ---------------------------------------

export const UnconfiguredPaymentGateway: PaymentGateway = {
  getStatus: async () => ({
    kind: "payment",
    provider: null,
    configured: false,
    capabilities: [
      "checkout",
      "callback_verification",
      "webhook_signature_verification",
      "state_normalization",
      "refund_or_cancel",
    ],
  }),
  createCheckout: async () =>
    notConfigured(
      "payment",
      "createCheckout",
      "Payment provider is not configured. Cannot create checkout.",
    ),
  verifyCallback: async () =>
    notConfigured(
      "payment",
      "verifyCallback",
      "Payment provider is not configured. Cannot verify payment callbacks.",
    ),
  verifyWebhookSignature: async () =>
    notConfigured(
      "payment",
      "verifyWebhookSignature",
      "Payment provider is not configured. Cannot verify webhook signatures.",
    ),
  normalizePaymentState: async () =>
    notConfigured(
      "payment",
      "normalizePaymentState",
      "Payment provider is not configured. Cannot normalize provider payment state.",
    ),
  refundOrCancel: async () =>
    notConfigured(
      "payment",
      "refundOrCancel",
      "Payment provider is not configured. Cannot cancel or refund payment.",
    ),
};

export const NullCalendarProvider: CalendarProvider = {
  getStatus: async () => ({
    kind: "calendar",
    provider: null,
    configured: false,
    capabilities: ["free_busy", "create_event", "update_event", "cancel_event"],
  }),
  getFreeBusy: async () =>
    notConfigured(
      "calendar",
      "getFreeBusy",
      "No calendar provider is configured. External free/busy is unavailable.",
    ),
  createEvent: async () =>
    notConfigured(
      "calendar",
      "createEvent",
      "No calendar provider is configured. Cannot create calendar events.",
    ),
  updateEvent: async () =>
    notConfigured(
      "calendar",
      "updateEvent",
      "No calendar provider is configured. Cannot update calendar events.",
    ),
  cancelEvent: async () =>
    notConfigured(
      "calendar",
      "cancelEvent",
      "No calendar provider is configured. Cannot cancel calendar events.",
    ),
};

export const UnconfiguredMailboxProvider: MailboxProvider = {
  getStatus: async () => ({
    kind: "mailbox",
    provider: null,
    configured: false,
    capabilities: [
      "send_confirmation",
      "send_reschedule",
      "send_cancellation",
      "send_reminder",
    ],
  }),
  sendConfirmation: async () =>
    notConfigured(
      "mailbox",
      "sendConfirmation",
      "No mailbox provider is configured. Cannot send booking confirmation.",
    ),
  sendReschedule: async () =>
    notConfigured(
      "mailbox",
      "sendReschedule",
      "No mailbox provider is configured. Cannot send reschedule message.",
    ),
  sendCancellation: async () =>
    notConfigured(
      "mailbox",
      "sendCancellation",
      "No mailbox provider is configured. Cannot send cancellation message.",
    ),
  sendReminder: async () =>
    notConfigured(
      "mailbox",
      "sendReminder",
      "No mailbox provider is configured. Cannot send reminder.",
    ),
};

function requireOverride(
  providerKind: ProviderKind,
  operation: string,
  value: string | null | undefined,
  message: string,
): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new SchedulingProviderError({
      message,
      code: "INVALID_CONFIGURATION",
      providerKind,
      operation,
      retryable: false,
    });
  }
  return normalized;
}

function requireHttpsUrl(value: string, operation: string): string {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:") throw new Error("not https");
    return parsed.toString();
  } catch {
    throw new SchedulingProviderError({
      message: "External meeting links must use HTTPS.",
      code: "INVALID_CONFIGURATION",
      providerKind: "meeting",
      operation,
      retryable: false,
    });
  }
}

/**
 * Unconfigured meeting adapter.
 *
 * Static, caller-supplied locations remain usable because they do not require
 * an external provider. Provider-generated meeting methods fail closed.
 */
export const UnconfiguredMeetingProvider: MeetingProvider = {
  getStatus: async () => ({
    kind: "meeting",
    provider: null,
    configured: false,
    capabilities: ["static_location_resolution", "provider_generated_meeting"],
  }),
  resolveMeetingLocation: async (params) => {
    const operation = "resolveMeetingLocation";

    switch (params.method) {
      case "EXTERNAL_LINK": {
        const raw = requireOverride(
          "meeting",
          operation,
          params.overrideUrl,
          "External-link meetings require an explicit URL.",
        );
        const url = requireHttpsUrl(raw, operation);
        return {
          method: params.method,
          url,
          displayText: url,
        };
      }
      case "PHONE": {
        const phone = requireOverride(
          "meeting",
          operation,
          params.overridePhone,
          "Phone meetings require an explicit phone number.",
        );
        return {
          method: params.method,
          phone,
          displayText: phone,
        };
      }
      case "IN_PERSON": {
        const address = requireOverride(
          "meeting",
          operation,
          params.overrideAddress,
          "In-person meetings require an explicit address.",
        );
        return {
          method: params.method,
          address,
          displayText: address,
        };
      }
      case "TO_BE_CONFIRMED":
        return {
          method: params.method,
          displayText: "To be confirmed",
        };
      case "GOOGLE_MEET":
        return notConfigured(
          "meeting",
          operation,
          "No meeting provider is configured. Cannot create a provider-generated meeting link.",
        );
    }
  },
};

// -- Provider bundle -----------------------------------------------------------

export interface CommerceSchedulingProviders {
  payment: PaymentGateway;
  calendar: CalendarProvider;
  mailbox: MailboxProvider;
  meeting: MeetingProvider;
}

/**
 * Safe default dependency bundle for later orchestration slices.
 *
 * Importing/using this object can never activate a real provider.
 */
export const UnconfiguredCommerceSchedulingProviders: Readonly<CommerceSchedulingProviders> =
  Object.freeze({
    payment: UnconfiguredPaymentGateway,
    calendar: NullCalendarProvider,
    mailbox: UnconfiguredMailboxProvider,
    meeting: UnconfiguredMeetingProvider,
  });
