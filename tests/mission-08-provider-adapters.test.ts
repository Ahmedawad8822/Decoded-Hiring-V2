/**
 * MISSION 08.4 — Provider-Neutral Adapters
 *
 * Pure contract/fail-closed regression suite.
 * No database, network, credentials, SDKs or provider activation.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  NullCalendarProvider,
  SchedulingProviderError,
  UnconfiguredCommerceSchedulingProviders,
  UnconfiguredMailboxProvider,
  UnconfiguredMeetingProvider,
  UnconfiguredPaymentGateway,
  type CalendarProvider,
  type CreateCalendarEventParams,
  type PaymentGateway,
  type NormalizedPaymentState,
  type VerifyCallbackResult,
} from "@/features/scheduling";

async function expectProviderError(
  promise: Promise<unknown>,
  providerKind: "payment" | "calendar" | "mailbox" | "meeting",
  operation: string,
  code: "PROVIDER_NOT_CONFIGURED" | "INVALID_CONFIGURATION" = "PROVIDER_NOT_CONFIGURED",
) {
  await assert.rejects(
    promise,
    (error: unknown) => {
      assert.ok(error instanceof SchedulingProviderError);
      assert.equal(error.providerKind, providerKind);
      assert.equal(error.operation, operation);
      assert.equal(error.code, code);
      assert.equal(error.retryable, false);
      return true;
    },
  );
}

type ProviderCannotFulfill =
  "FULFILLED" extends NormalizedPaymentState ? never : true;
const providerCannotFulfill: ProviderCannotFulfill = true;

type UnverifiedCallback = Extract<VerifyCallbackResult, { verified: false }>;
type UnverifiedStateMustBeEmpty =
  Exclude<UnverifiedCallback["state"], undefined> extends never ? true : never;
const unverifiedStateMustBeEmpty: UnverifiedStateMustBeEmpty = true;

void providerCannotFulfill;
void unverifiedStateMustBeEmpty;

const checkoutInput = {
  orderId: "order_test_08_4",
  offerId: "offer_test_08_4",
  amountMinor: 12500,
  currency: "USD",
  quantity: 1,
  successUrl: "https://example.com/success",
  cancelUrl: "https://example.com/cancel",
  idempotencyKey: "checkout:order_test_08_4",
} as const;

test("PROVIDERS 08.4: payment adapter fails closed for every external capability", async () => {
  await expectProviderError(
    UnconfiguredPaymentGateway.createCheckout(checkoutInput),
    "payment",
    "createCheckout",
  );

  await expectProviderError(
    UnconfiguredPaymentGateway.verifyCallback({
      orderId: checkoutInput.orderId,
      callbackPayload: "opaque-callback",
    }),
    "payment",
    "verifyCallback",
  );

  await expectProviderError(
    UnconfiguredPaymentGateway.verifyWebhookSignature({
      rawBody: '{"type":"payment"}',
      signature: "opaque-signature",
    }),
    "payment",
    "verifyWebhookSignature",
  );

  await expectProviderError(
    UnconfiguredPaymentGateway.normalizePaymentState({
      orderId: checkoutInput.orderId,
      providerState: "succeeded",
      amountMinor: checkoutInput.amountMinor,
      currency: checkoutInput.currency,
    }),
    "payment",
    "normalizePaymentState",
  );

  await expectProviderError(
    UnconfiguredPaymentGateway.refundOrCancel({
      orderId: checkoutInput.orderId,
      providerPaymentId: "provider_payment_opaque",
      amountMinor: checkoutInput.amountMinor,
      reason: "test",
      idempotencyKey: "refund:order_test_08_4",
    }),
    "payment",
    "refundOrCancel",
  );
});

test("PROVIDERS 08.4: unconfigured payment can never manufacture paid state", async () => {
  let returned = false;
  try {
    await UnconfiguredPaymentGateway.verifyCallback({
      orderId: checkoutInput.orderId,
      callbackPayload: "anything",
    });
    returned = true;
  } catch (error) {
    assert.ok(error instanceof SchedulingProviderError);
    assert.equal(error.code, "PROVIDER_NOT_CONFIGURED");
  }
  assert.equal(returned, false);
});

test("PROVIDERS 08.4: calendar adapter fails closed instead of treating no provider as free", async () => {
  await expectProviderError(
    NullCalendarProvider.getFreeBusy({
      calendarId: "calendar_internal_alias",
      rangeStart: new Date("2026-10-01T08:00:00Z"),
      rangeEnd: new Date("2026-10-01T18:00:00Z"),
    }),
    "calendar",
    "getFreeBusy",
  );

  const createParams: CreateCalendarEventParams = {
    bookingId: "booking_08_4",
    idempotencyKey: "calendar:create:booking_08_4",
    calendarId: "calendar_internal_alias",
    summary: "Coaching session",
    startAt: new Date("2026-10-01T10:00:00Z"),
    endAt: new Date("2026-10-01T11:00:00Z"),
    timezone: "Africa/Cairo",
    attendees: [{ email: "guest@example.com", displayName: "Guest" }],
  };

  await expectProviderError(
    NullCalendarProvider.createEvent(createParams),
    "calendar",
    "createEvent",
  );

  const ref = { id: "provider_event_opaque", provider: "unconfigured" };

  await expectProviderError(
    NullCalendarProvider.updateEvent(ref, {
      bookingId: createParams.bookingId,
      idempotencyKey: "calendar:update:booking_08_4:v2",
      startAt: new Date("2026-10-01T11:00:00Z"),
      endAt: new Date("2026-10-01T12:00:00Z"),
      timezone: "Africa/Cairo",
    }),
    "calendar",
    "updateEvent",
  );

  await expectProviderError(
    NullCalendarProvider.cancelEvent(ref, {
      bookingId: createParams.bookingId,
      idempotencyKey: "calendar:cancel:booking_08_4",
      reason: "cancelled",
    }),
    "calendar",
    "cancelEvent",
  );
});

test("PROVIDERS 08.4: mailbox adapter fails closed for every operational message", async () => {
  const mail = {
    bookingId: "booking_08_4",
    idempotencyKey: "mail:booking_08_4",
    to: "guest@example.com",
    subject: "Booking update",
    html: "<p>Booking update</p>",
  };

  await expectProviderError(
    UnconfiguredMailboxProvider.sendConfirmation({
      ...mail,
      idempotencyKey: "mail:confirm:booking_08_4",
    }),
    "mailbox",
    "sendConfirmation",
  );
  await expectProviderError(
    UnconfiguredMailboxProvider.sendReschedule({
      ...mail,
      idempotencyKey: "mail:reschedule:booking_08_4",
    }),
    "mailbox",
    "sendReschedule",
  );
  await expectProviderError(
    UnconfiguredMailboxProvider.sendCancellation({
      ...mail,
      idempotencyKey: "mail:cancel:booking_08_4",
    }),
    "mailbox",
    "sendCancellation",
  );
  await expectProviderError(
    UnconfiguredMailboxProvider.sendReminder({
      ...mail,
      idempotencyKey: "mail:reminder:booking_08_4",
    }),
    "mailbox",
    "sendReminder",
  );
});

test("PROVIDERS 08.4: unconfigured meeting adapter safely resolves static locations", async () => {
  const external = await UnconfiguredMeetingProvider.resolveMeetingLocation({
    bookingId: "booking_external",
    idempotencyKey: "meeting:booking_external",
    method: "EXTERNAL_LINK",
    overrideUrl: "https://meet.example.com/room",
  });
  assert.equal(external.method, "EXTERNAL_LINK");
  assert.equal(external.url, "https://meet.example.com/room");
  assert.equal(external.displayText, "https://meet.example.com/room");

  const phone = await UnconfiguredMeetingProvider.resolveMeetingLocation({
    bookingId: "booking_phone",
    idempotencyKey: "meeting:booking_phone",
    method: "PHONE",
    overridePhone: "+20 100 000 0000",
  });
  assert.equal(phone.phone, "+20 100 000 0000");

  const inPerson = await UnconfiguredMeetingProvider.resolveMeetingLocation({
    bookingId: "booking_in_person",
    idempotencyKey: "meeting:booking_in_person",
    method: "IN_PERSON",
    overrideAddress: "Cairo, Egypt",
  });
  assert.equal(inPerson.address, "Cairo, Egypt");

  const tbc = await UnconfiguredMeetingProvider.resolveMeetingLocation({
    bookingId: "booking_tbc",
    idempotencyKey: "meeting:booking_tbc",
    method: "TO_BE_CONFIRMED",
  });
  assert.equal(tbc.displayText, "To be confirmed");
});

test("PROVIDERS 08.4: provider-generated meeting links fail closed when unconfigured", async () => {
  await expectProviderError(
    UnconfiguredMeetingProvider.resolveMeetingLocation({
      bookingId: "booking_generated",
      idempotencyKey: "meeting:booking_generated",
      method: "GOOGLE_MEET",
    }),
    "meeting",
    "resolveMeetingLocation",
  );
});

test("PROVIDERS 08.4: static meeting configuration rejects missing or unsafe locations", async () => {
  await expectProviderError(
    UnconfiguredMeetingProvider.resolveMeetingLocation({
      bookingId: "booking_missing_link",
      idempotencyKey: "meeting:booking_missing_link",
      method: "EXTERNAL_LINK",
    }),
    "meeting",
    "resolveMeetingLocation",
    "INVALID_CONFIGURATION",
  );

  await expectProviderError(
    UnconfiguredMeetingProvider.resolveMeetingLocation({
      bookingId: "booking_http_link",
      idempotencyKey: "meeting:booking_http_link",
      method: "EXTERNAL_LINK",
      overrideUrl: "http://example.com/not-secure",
    }),
    "meeting",
    "resolveMeetingLocation",
    "INVALID_CONFIGURATION",
  );

  await expectProviderError(
    UnconfiguredMeetingProvider.resolveMeetingLocation({
      bookingId: "booking_missing_phone",
      idempotencyKey: "meeting:booking_missing_phone",
      method: "PHONE",
    }),
    "meeting",
    "resolveMeetingLocation",
    "INVALID_CONFIGURATION",
  );

  await expectProviderError(
    UnconfiguredMeetingProvider.resolveMeetingLocation({
      bookingId: "booking_missing_address",
      idempotencyKey: "meeting:booking_missing_address",
      method: "IN_PERSON",
    }),
    "meeting",
    "resolveMeetingLocation",
    "INVALID_CONFIGURATION",
  );
});

test("PROVIDERS 08.4: unconfigured provider status is explicit and side-effect free", async () => {
  const statuses = await Promise.all([
    UnconfiguredPaymentGateway.getStatus(),
    NullCalendarProvider.getStatus(),
    UnconfiguredMailboxProvider.getStatus(),
    UnconfiguredMeetingProvider.getStatus(),
  ]);

  assert.deepEqual(
    statuses.map((status) => status.kind),
    ["payment", "calendar", "mailbox", "meeting"],
  );
  for (const status of statuses) {
    assert.equal(status.configured, false);
    assert.equal(status.provider, null);
    assert.ok(status.capabilities.length > 0);
  }
});

test("PROVIDERS 08.4: safe default bundle contains only unconfigured adapters", () => {
  assert.equal(
    UnconfiguredCommerceSchedulingProviders.payment,
    UnconfiguredPaymentGateway,
  );
  assert.equal(
    UnconfiguredCommerceSchedulingProviders.calendar,
    NullCalendarProvider,
  );
  assert.equal(
    UnconfiguredCommerceSchedulingProviders.mailbox,
    UnconfiguredMailboxProvider,
  );
  assert.equal(
    UnconfiguredCommerceSchedulingProviders.meeting,
    UnconfiguredMeetingProvider,
  );
  assert.equal(Object.isFrozen(UnconfiguredCommerceSchedulingProviders), true);
});

test("PROVIDERS 08.4: calendar contract supports provider event + location metadata without SDK types", async () => {
  const deterministicAdapter: CalendarProvider = {
    getStatus: async () => ({
      kind: "calendar",
      provider: "test-adapter",
      configured: true,
      capabilities: ["free_busy", "create_event"],
    }),
    getFreeBusy: async () => [],
    createEvent: async (params) => ({
      event: { id: `event-for-${params.bookingId}`, provider: "test-adapter" },
      location: {
        method: "EXTERNAL_LINK",
        url: "https://meet.example.com/test-room",
        displayText: "https://meet.example.com/test-room",
      },
    }),
    updateEvent: async (ref) => ({
      event: ref,
      location: null,
    }),
    cancelEvent: async () => undefined,
  };

  const result = await deterministicAdapter.createEvent({
    bookingId: "booking_contract",
    idempotencyKey: "calendar:create:booking_contract",
    calendarId: "calendar_alias",
    summary: "Contract test",
    startAt: new Date("2026-10-01T10:00:00Z"),
    endAt: new Date("2026-10-01T11:00:00Z"),
    timezone: "Africa/Cairo",
  });

  assert.equal(result.event.id, "event-for-booking_contract");
  assert.equal(result.event.provider, "test-adapter");
  assert.equal(result.location?.method, "EXTERNAL_LINK");
});

test("PROVIDERS 08.4: payment contract can normalize provider state without provider SDK types", async () => {
  const deterministicAdapter: PaymentGateway = {
    getStatus: async () => ({
      kind: "payment",
      provider: "test-adapter",
      configured: true,
      capabilities: ["checkout", "state_normalization"],
    }),
    createCheckout: async (params) => ({
      checkoutUrl: "https://pay.example.com/session",
      providerCheckoutId: `checkout-${params.orderId}`,
      provider: "test-adapter",
    }),
    verifyCallback: async (params) => ({
      verified: true,
      orderId: params.orderId,
      state: "PAID",
      providerPaymentId: "payment-opaque",
    }),
    verifyWebhookSignature: async () => ({
      valid: true,
      providerEventId: "event-opaque",
    }),
    normalizePaymentState: async (params) => ({
      orderId: params.orderId,
      providerState: params.providerState,
      state: params.providerState === "settled" ? "PAID" : "PENDING",
      amountMinor: params.amountMinor,
      currency: params.currency,
    }),
    refundOrCancel: async () => undefined,
  };

  const normalized = await deterministicAdapter.normalizePaymentState({
    orderId: "order_contract",
    providerState: "settled",
    amountMinor: 12500,
    currency: "USD",
  });

  assert.equal(normalized.orderId, "order_contract");
  assert.equal(normalized.state, "PAID");
  assert.equal(normalized.providerState, "settled");
});
