/**
 * MISSION 08.5 — Order/payment truth + durable orchestration
 */

import "./helpers/env";

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { eq } from "drizzle-orm";

import { disposeCloudflareBindings } from "../src/lib/cloudflare/bindings";
import { getDb } from "../src/lib/db";
import { migrateLocalDb } from "../src/lib/db/migrate";
import {
  bookingAvailabilityWindows,
  bookingHistory,
  bookings,
  bookingTypes,
  courseSections,
  courses,
  enrollments,
  lessonProgress,
  lessonResources,
  lessons,
  offers,
  orchestrationEffects,
  orchestrationHistory,
  orderHistory,
  orders,
  paymentEvents,
  slotHolds,
  users,
} from "@/lib/db";
import {
  CommerceDomainError,
  applyVerifiedPaymentCallback,
  applyVerifiedPaymentWebhook,
  createOrder,
  enqueueBookingReminder,
  enqueuePaymentCheckout,
  getOrchestrationEffect,
  getOrchestrationHistory,
  processOrchestrationEffect,
} from "@/features/commerce";
import { createOffer } from "@/features/offers/service";
import {
  __commerceTestOnly,
  getOrderHistory,
  getPaymentEvents,
} from "@/features/commerce/orders";
import {
  SchedulingProviderError,
  NullCalendarProvider,
  UnconfiguredMailboxProvider,
  UnconfiguredMeetingProvider,
  UnconfiguredPaymentGateway,
  acquireSlotHold,
  createAvailabilityWindow,
  createBookingRequest,
  createBookingType,
  generateAcquisitionKey,
  type CalendarProvider,
  type CommerceSchedulingProviders,
  type MailboxProvider,
  type PaymentGateway,
} from "@/features/scheduling";
import { __bookingLifecycleTestOnly } from "@/features/scheduling/bookings";

const NOW = new Date("2026-10-27T12:00:00.000Z");
const SLOT_A = new Date("2026-10-27T14:00:00.000Z");
let seq = 0;

function id(prefix: string): string {
  return `${prefix}_${seq++}`;
}

function slug(prefix: string): string {
  return `${prefix}-${seq++}`;
}

async function createTestUser() {
  const db = await getDb();
  const userId = id("user");
  await db.insert(users).values({
    id: userId,
    name: "Commerce Test User",
    email: `${userId}@example.com`,
    emailVerified: true,
    image: null,
    createdAt: NOW,
    updatedAt: NOW,
    role: "user",
    banned: false,
    banReason: null,
    banExpires: null,
  });
  return userId;
}

async function createCourseOffer(
  accessMode: "PAID_ONE_TIME" | "MANUAL_INVOICE" = "PAID_ONE_TIME",
) {
  const db = await getDb();
  const courseId = id("course");
  const userId = await createTestUser();
  await db.insert(courses).values({
    id: courseId,
    title: "Paid Course",
    slug: slug("paid-course"),
    description: "Commerce test",
    status: "published",
    accessMode: "PAID_ONE_TIME",
    coverImage: null,
    createdAt: NOW,
    updatedAt: NOW,
    publishedAt: NOW,
  });
  const offer = await createOffer({
    kind: "COURSE",
    courseId,
    title: "Paid Course Offer",
    slug: slug("paid-offer"),
    accessMode,
    currency: accessMode === "PAID_ONE_TIME" ? "USD" : null,
    amountMinor: accessMode === "PAID_ONE_TIME" ? 12500 : null,
  });
  return { courseId, userId, offer };
}

async function createPaidCourseOrder(
  accessMode: "PAID_ONE_TIME" | "MANUAL_INVOICE" = "PAID_ONE_TIME",
) {
  const setup = await createCourseOffer(accessMode);
  const requestKey = crypto.randomUUID();
  const order = await createOrder({
    offerId: setup.offer.id,
    userId: setup.userId,
    requestKey,
    customerEmail: `${setup.userId}@example.com`,
    now: NOW,
  });
  return { ...setup, order, requestKey };
}

function verifiedGateway(params: {
  state?: "PENDING" | "REQUIRES_ACTION" | "PAID" | "CANCELLED" | "FAILED" | "REFUNDED";
  amountMinor?: number;
  currency?: string;
  eventId?: string;
} = {}): PaymentGateway {
  return {
    getStatus: async () => ({
      kind: "payment",
      provider: "test-pay",
      configured: true,
      capabilities: ["checkout", "callback_verification", "webhook_signature_verification", "state_normalization"],
    }),
    createCheckout: async (input) => ({
      checkoutUrl: "https://pay.example.com/checkout",
      providerCheckoutId: `checkout-${input.orderId}`,
      provider: "test-pay",
    }),
    verifyCallback: async (input) => ({
      verified: true,
      orderId: input.orderId,
      state: params.state ?? "PAID",
      providerCheckoutId: `checkout-${input.orderId}`,
      providerPaymentId: `payment-${input.orderId}`,
      providerEventId: params.eventId ?? `event-${input.orderId}`,
      amountMinor: params.amountMinor ?? 12500,
      currency: params.currency ?? "USD",
    }),
    verifyWebhookSignature: async () => ({
      valid: true,
      providerEventId: params.eventId ?? "webhook-event",
    }),
    normalizePaymentState: async (input) => ({
      orderId: input.orderId,
      providerState: input.providerState,
      state: params.state ?? "PAID",
      amountMinor: params.amountMinor ?? input.amountMinor ?? 12500,
      currency: params.currency ?? input.currency ?? "USD",
    }),
    refundOrCancel: async () => undefined,
  };
}

function configuredCalendar(counter?: { calls: number }): CalendarProvider {
  return {
    getStatus: async () => ({
      kind: "calendar",
      provider: "test-calendar",
      configured: true,
      capabilities: ["free_busy", "create_event", "update_event", "cancel_event"],
    }),
    getFreeBusy: async () => [],
    createEvent: async (input) => {
      if (counter) counter.calls += 1;
      return {
        event: { id: `event-${input.bookingId}`, provider: "test-calendar" },
        location: null,
      };
    },
    updateEvent: async (ref) => {
      if (counter) counter.calls += 1;
      return { event: ref, location: null };
    },
    cancelEvent: async () => {
      if (counter) counter.calls += 1;
    },
  };
}

function configuredMailbox(counter?: { calls: number }): MailboxProvider {
  return {
    getStatus: async () => ({
      kind: "mailbox",
      provider: "test-mail",
      configured: true,
      capabilities: ["send_confirmation", "send_reschedule", "send_cancellation", "send_reminder"],
    }),
    sendConfirmation: async (input) => {
      if (counter) counter.calls += 1;
      return { id: `mail-confirm-${input.bookingId}`, provider: "test-mail" };
    },
    sendReschedule: async (input) => {
      if (counter) counter.calls += 1;
      return { id: `mail-reschedule-${input.bookingId}`, provider: "test-mail" };
    },
    sendCancellation: async (input) => {
      if (counter) counter.calls += 1;
      return { id: `mail-cancel-${input.bookingId}`, provider: "test-mail" };
    },
    sendReminder: async (input) => {
      if (counter) counter.calls += 1;
      return { id: `mail-reminder-${input.bookingId}`, provider: "test-mail" };
    },
  };
}

function providerBundle(overrides: Partial<CommerceSchedulingProviders> = {}): CommerceSchedulingProviders {
  return {
    payment: overrides.payment ?? UnconfiguredPaymentGateway,
    calendar: overrides.calendar ?? NullCalendarProvider,
    mailbox: overrides.mailbox ?? UnconfiguredMailboxProvider,
    meeting: overrides.meeting ?? UnconfiguredMeetingProvider,
  };
}

async function createPaidBooking() {
  const bookingType = await createBookingType({
    slug: slug("paid-session"),
    title: "Paid Coaching",
    durationMinutes: 60,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    minimumNoticeMinutes: 0,
    bookingHorizonDays: 30,
    timezone: "America/New_York",
    confirmationPolicy: "AHMED_APPROVAL",
    accessMode: "PAID_SESSION",
    meetingMethod: "TO_BE_CONFIRMED",
    attendeeLimit: 1,
  });
  await createAvailabilityWindow({
    bookingTypeId: bookingType.id,
    weekday: 2,
    startMinute: 540,
    endMinute: 1020,
  });
  const acquisitionKey = generateAcquisitionKey();
  const hold = await acquireSlotHold({
    bookingTypeId: bookingType.id,
    startAt: SLOT_A,
    now: NOW,
    ttlMinutes: 10,
    acquisitionKey,
  });
  assert.ok(hold.success);

  const booking = await createBookingRequest({
    bookingTypeId: bookingType.id,
    holdId: hold.hold.id,
    holdAcquisitionKey: acquisitionKey,
    requestKey: crypto.randomUUID(),
    requesterName: "Paid Guest",
    requesterEmail: "paid-guest@example.com",
    now: NOW,
  });

  const offer = await createOffer({
    kind: "COACHING",
    bookingTypeId: bookingType.id,
    title: "Paid Coaching Offer",
    slug: slug("paid-coaching"),
    accessMode: "PAID_SESSION",
    currency: "USD",
    amountMinor: 20000,
  });

  const order = await createOrder({
    offerId: offer.id,
    bookingId: booking.id,
    requestKey: crypto.randomUUID(),
    customerEmail: "paid-guest@example.com",
    now: NOW,
  });

  return { bookingType, booking, offer, order };
}

test.before(async () => {
  await migrateLocalDb();
  const db = await getDb();
  await db.delete(orchestrationHistory).run();
  await db.delete(orchestrationEffects).run();
  await db.delete(paymentEvents).run();
  await db.delete(orderHistory).run();
  await db.delete(orders).run();
  await db.delete(lessonProgress).run();
  await db.delete(lessonResources).run();
  await db.delete(lessons).run();
  await db.delete(courseSections).run();
  await db.delete(enrollments).run();
  await db.delete(bookingHistory).run();
  await db.delete(bookings).run();
  await db.delete(offers).run();
  await db.delete(slotHolds).run();
  await db.delete(bookingAvailabilityWindows).run();
  await db.delete(bookingTypes).run();
  await db.delete(courses).run();
});

test.after(async () => {
  await disposeCloudflareBindings();
});

test("COMMERCE 08.5: order request is idempotent and snapshots Offer price", async () => {
  const setup = await createPaidCourseOrder();
  const duplicate = await createOrder({
    offerId: setup.offer.id,
    userId: setup.userId,
    requestKey: setup.requestKey,
    customerEmail: `${setup.userId}@example.com`,
    now: NOW,
  });
  assert.equal(duplicate.id, setup.order.id);
  assert.equal(setup.order.status, "PENDING");
  assert.equal(setup.order.amountMinor, 12500);
  assert.equal(setup.order.currency, "USD");

  const history = await getOrderHistory(setup.order.id);
  assert.equal(history.length, 1);
  assert.equal(history[0].toStatus, "PENDING");
});

test("COMMERCE 08.5: requestKey cannot be rebound to another order", async () => {
  const first = await createPaidCourseOrder();
  const secondOffer = await createCourseOffer();

  await assert.rejects(
    createOrder({
      offerId: secondOffer.offer.id,
      userId: secondOffer.userId,
      requestKey: first.requestKey,
      customerEmail: `${secondOffer.userId}@example.com`,
      now: NOW,
    }),
    (error: unknown) =>
      error instanceof CommerceDomainError &&
      error.code === "IDEMPOTENCY_CONFLICT",
  );
});

test("COMMERCE 08.5: unverified callback cannot mutate Order truth", async () => {
  const setup = await createPaidCourseOrder();
  const gateway: PaymentGateway = {
    ...verifiedGateway(),
    verifyCallback: async (input) => ({
      verified: false,
      orderId: input.orderId,
    }),
  };

  await assert.rejects(
    applyVerifiedPaymentCallback(gateway, {
      orderId: setup.order.id,
      callbackKey: "callback-unverified",
      callbackPayload: "opaque",
      provider: "test-pay",
      now: NOW,
    }),
    (error: unknown) =>
      error instanceof CommerceDomainError &&
      error.code === "PAYMENT_EVIDENCE_INVALID",
  );

  const stored = await __commerceTestOnly!.getOrder(setup.order.id);
  assert.equal(stored?.status, "PENDING");
  assert.equal((await getPaymentEvents(setup.order.id)).length, 0);
});

test("COMMERCE 08.5: verified PAID callback is durable and callback-idempotent", async () => {
  const setup = await createPaidCourseOrder();
  const gateway = verifiedGateway({ eventId: "event-paid-idempotent" });
  const input = {
    orderId: setup.order.id,
    callbackKey: "callback-paid-idempotent",
    callbackPayload: "opaque",
    provider: "test-pay",
    now: NOW,
  };

  const paid = await applyVerifiedPaymentCallback(gateway, input);
  const duplicate = await applyVerifiedPaymentCallback(gateway, input);

  assert.equal(paid.status, "PAID");
  assert.equal(duplicate.id, paid.id);
  assert.equal(duplicate.version, paid.version);

  const events = await getPaymentEvents(paid.id);
  assert.equal(events.length, 1);
  const db = await getDb();
  const effects = await db
    .select()
    .from(orchestrationEffects)
    .where(eq(orchestrationEffects.subjectId, paid.id))
    .all();
  assert.equal(effects.filter((e) => e.effectType === "ORDER_FULFILL").length, 1);
});

test("COMMERCE 08.5: payment amount mismatch is rejected before persistence", async () => {
  const setup = await createPaidCourseOrder();
  await assert.rejects(
    applyVerifiedPaymentCallback(
      verifiedGateway({ amountMinor: 999 }),
      {
        orderId: setup.order.id,
        callbackKey: "callback-wrong-amount",
        callbackPayload: "opaque",
        provider: "test-pay",
        now: NOW,
      },
    ),
    (error: unknown) =>
      error instanceof CommerceDomainError &&
      error.code === "PAYMENT_AMOUNT_MISMATCH",
  );
  assert.equal((await getPaymentEvents(setup.order.id)).length, 0);
});

test("COMMERCE 08.5: webhook signature verification is mandatory before normalization", async () => {
  const setup = await createPaidCourseOrder();
  let normalized = 0;
  const gateway: PaymentGateway = {
    ...verifiedGateway(),
    verifyWebhookSignature: async () => ({ valid: false }),
    normalizePaymentState: async (input) => {
      normalized += 1;
      return {
        orderId: input.orderId,
        providerState: input.providerState,
        state: "PAID",
      };
    },
  };

  await assert.rejects(
    applyVerifiedPaymentWebhook(gateway, {
      orderId: setup.order.id,
      providerState: "settled",
      rawBody: '{"event":"payment"}',
      signature: "invalid",
      provider: "test-pay",
      now: NOW,
    }),
    (error: unknown) =>
      error instanceof CommerceDomainError &&
      error.code === "PAYMENT_EVIDENCE_INVALID",
  );

  assert.equal(normalized, 0);
  assert.equal((await __commerceTestOnly!.getOrder(setup.order.id))?.status, "PENDING");
});

test("COMMERCE 08.5: verified webhook dedupes by provider event identity", async () => {
  const setup = await createPaidCourseOrder();
  const gateway = verifiedGateway({ eventId: "webhook-event-unique" });
  const input = {
    orderId: setup.order.id,
    providerState: "settled",
    amountMinor: 12500,
    currency: "USD",
    rawBody: '{"event":"same"}',
    signature: "valid",
    provider: "test-pay",
    now: NOW,
  } as const;

  const paid = await applyVerifiedPaymentWebhook(gateway, input);
  const same = await applyVerifiedPaymentWebhook(gateway, input);
  assert.equal(paid.status, "PAID");
  assert.equal(same.version, paid.version);
  assert.equal((await getPaymentEvents(paid.id)).length, 1);
});

test("COMMERCE 08.5: manual invoice requires trusted admin transition and enqueues fulfillment", async () => {
  const setup = await createPaidCourseOrder("MANUAL_INVOICE");
  const paid = await __commerceTestOnly!.recordManualPayment({
    orderId: setup.order.id,
    expectedVersion: setup.order.version,
    now: NOW,
    note: "Bank transfer received",
  });
  assert.equal(paid.status, "PAID");

  const db = await getDb();
  const effect = await db
    .select()
    .from(orchestrationEffects)
    .where(eq(orchestrationEffects.subjectId, paid.id))
    .get();
  assert.equal(effect?.effectType, "ORDER_FULFILL");
});

test("COMMERCE 08.5: internal course fulfillment grants durable enrollment atomically", async () => {
  const setup = await createPaidCourseOrder();
  const paid = await applyVerifiedPaymentCallback(
    verifiedGateway({ eventId: "event-course-fulfill" }),
    {
      orderId: setup.order.id,
      callbackKey: "callback-course-fulfill",
      callbackPayload: "opaque",
      provider: "test-pay",
      now: NOW,
    },
  );
  const db = await getDb();
  const effect = await db
    .select()
    .from(orchestrationEffects)
    .where(eq(orchestrationEffects.subjectId, paid.id))
    .get();
  assert.ok(effect);

  const completed = await processOrchestrationEffect({
    effectId: effect.id,
    now: new Date(NOW.getTime() + 1000),
  });
  assert.equal(completed.status, "SUCCEEDED");

  const order = await __commerceTestOnly!.getOrder(paid.id);
  assert.equal(order?.status, "FULFILLED");
  const enrollment = await db
    .select()
    .from(enrollments)
    .where(eq(enrollments.userId, setup.userId))
    .get();
  assert.equal(enrollment?.courseId, setup.courseId);
  assert.equal(enrollment?.accessSource, `order:${paid.id}`);

  const retry = await processOrchestrationEffect({
    effectId: effect.id,
    now: new Date(NOW.getTime() + 2000),
  });
  assert.equal(retry.status, "SUCCEEDED");
});

test("COMMERCE 08.5: payment checkout side effect is retry-safe and transitions order to REQUIRES_ACTION", async () => {
  const setup = await createPaidCourseOrder();
  const effect = await enqueuePaymentCheckout({
    orderId: setup.order.id,
    successUrl: "https://example.com/success",
    cancelUrl: "https://example.com/cancel",
    now: NOW,
  });
  let checkoutCalls = 0;
  const payment: PaymentGateway = {
    ...verifiedGateway(),
    createCheckout: async (input) => {
      checkoutCalls += 1;
      return {
        checkoutUrl: "https://pay.example.com/session",
        providerCheckoutId: `checkout-${input.orderId}`,
        provider: "test-pay",
      };
    },
  };

  const result = await processOrchestrationEffect(
    { effectId: effect.id, now: NOW },
    providerBundle({ payment }),
  );
  assert.equal(result.status, "SUCCEEDED");
  assert.equal(checkoutCalls, 1);
  assert.equal((await __commerceTestOnly!.getOrder(setup.order.id))?.status, "REQUIRES_ACTION");

  await processOrchestrationEffect(
    { effectId: effect.id, now: new Date(NOW.getTime() + 1000) },
    providerBundle({ payment }),
  );
  assert.equal(checkoutCalls, 1);
});

test("COMMERCE 08.5: PAID_SESSION booking cannot confirm until matching order is PAID", async () => {
  const setup = await createPaidBooking();

  await assert.rejects(
    __bookingLifecycleTestOnly!.approve({
      bookingId: setup.booking.id,
      expectedVersion: setup.booking.version,
      now: NOW,
    }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      (error as { code?: string }).code === "PAYMENT_REQUIRED",
  );

  const paid = await applyVerifiedPaymentCallback(
    verifiedGateway({ amountMinor: 20000, eventId: "event-paid-session" }),
    {
      orderId: setup.order.id,
      callbackKey: "callback-paid-session",
      callbackPayload: "opaque",
      provider: "test-pay",
      now: NOW,
    },
  );
  assert.equal(paid.status, "PAID");

  const confirmed = await __bookingLifecycleTestOnly!.approve({
    bookingId: setup.booking.id,
    expectedVersion: setup.booking.version,
    now: NOW,
  });
  assert.equal(confirmed.status, "CONFIRMED");

  const db = await getDb();
  const fulfillment = await db
    .select()
    .from(orchestrationEffects)
    .where(eq(orchestrationEffects.subjectId, paid.id))
    .get();
  assert.ok(fulfillment);
  await processOrchestrationEffect({
    effectId: fulfillment.id,
    now: new Date(NOW.getTime() + 1000),
  });
  assert.equal((await __commerceTestOnly!.getOrder(paid.id))?.status, "FULFILLED");
});

test("COMMERCE 08.5: booking confirmation commits calendar -> mail dependency outbox atomically", async () => {
  const setup = await createPaidBooking();
  await applyVerifiedPaymentCallback(
    verifiedGateway({ amountMinor: 20000, eventId: "event-outbox-booking" }),
    {
      orderId: setup.order.id,
      callbackKey: "callback-outbox-booking",
      callbackPayload: "opaque",
      provider: "test-pay",
      now: NOW,
    },
  );
  const confirmed = await __bookingLifecycleTestOnly!.approve({
    bookingId: setup.booking.id,
    expectedVersion: setup.booking.version,
    now: NOW,
  });

  const db = await getDb();
  const effects = await db
    .select()
    .from(orchestrationEffects)
    .where(eq(orchestrationEffects.subjectId, confirmed.id))
    .all();
  const calendar = effects.find((e) => e.effectType === "CALENDAR_CREATE");
  const mail = effects.find((e) => e.effectType === "MAIL_CONFIRMATION");
  assert.ok(calendar);
  assert.ok(mail);
  assert.equal(mail.dependsOnEffectId, calendar.id);

  const blocked = await processOrchestrationEffect({
    effectId: calendar.id,
    now: new Date(NOW.getTime() + 1000),
  });
  assert.equal(blocked.status, "BLOCKED");

  const waitingMail = await processOrchestrationEffect({
    effectId: mail.id,
    now: new Date(NOW.getTime() + 2000),
  });
  assert.equal(waitingMail.status, "PENDING");

  const calendarCounter = { calls: 0 };
  const mailCounter = { calls: 0 };
  const providers = providerBundle({
    calendar: configuredCalendar(calendarCounter),
    mailbox: configuredMailbox(mailCounter),
  });
  const calendarDone = await processOrchestrationEffect(
    { effectId: calendar.id, now: new Date(NOW.getTime() + 3000) },
    providers,
  );
  assert.equal(calendarDone.status, "SUCCEEDED");

  const mailDone = await processOrchestrationEffect(
    { effectId: mail.id, now: new Date(NOW.getTime() + 4000) },
    providers,
  );
  assert.equal(mailDone.status, "SUCCEEDED");
  assert.equal(calendarCounter.calls, 1);
  assert.equal(mailCounter.calls, 1);
});

test("COMMERCE 08.5: concurrent workers collapse to one provider side effect", async () => {
  const setup = await createPaidBooking();
  await applyVerifiedPaymentCallback(
    verifiedGateway({ amountMinor: 20000, eventId: "event-concurrent-reminder" }),
    {
      orderId: setup.order.id,
      callbackKey: "callback-concurrent-reminder",
      callbackPayload: "opaque",
      provider: "test-pay",
      now: NOW,
    },
  );
  const confirmed = await __bookingLifecycleTestOnly!.approve({
    bookingId: setup.booking.id,
    expectedVersion: setup.booking.version,
    now: NOW,
  });
  const reminder = await enqueueBookingReminder({
    bookingId: confirmed.id,
    reminderKey: "24h",
    now: NOW,
  });

  const counter = { calls: 0 };
  const providers = providerBundle({ mailbox: configuredMailbox(counter) });
  await Promise.all([
    processOrchestrationEffect({ effectId: reminder.id, now: NOW }, providers),
    processOrchestrationEffect({ effectId: reminder.id, now: NOW }, providers),
  ]);

  assert.equal(counter.calls, 1);
  assert.equal((await getOrchestrationEffect(reminder.id))?.status, "SUCCEEDED");
});

test("COMMERCE 08.5: retryable provider failure waits then recovers with same effect identity", async () => {
  const setup = await createPaidBooking();
  await applyVerifiedPaymentCallback(
    verifiedGateway({ amountMinor: 20000, eventId: "event-retry-mail" }),
    {
      orderId: setup.order.id,
      callbackKey: "callback-retry-mail",
      callbackPayload: "opaque",
      provider: "test-pay",
      now: NOW,
    },
  );
  const confirmed = await __bookingLifecycleTestOnly!.approve({
    bookingId: setup.booking.id,
    expectedVersion: setup.booking.version,
    now: NOW,
  });
  const reminder = await enqueueBookingReminder({
    bookingId: confirmed.id,
    reminderKey: "retry",
    now: NOW,
  });

  let calls = 0;
  const flaky: MailboxProvider = {
    ...configuredMailbox(),
    sendReminder: async (input) => {
      calls += 1;
      if (calls === 1) {
        throw new SchedulingProviderError({
          message: "Temporary provider outage",
          code: "INVALID_PROVIDER_RESPONSE",
          providerKind: "mailbox",
          operation: "sendReminder",
          retryable: true,
        });
      }
      return { id: `mail-${input.bookingId}`, provider: "test-mail" };
    },
  };

  const first = await processOrchestrationEffect(
    { effectId: reminder.id, now: NOW },
    providerBundle({ mailbox: flaky }),
  );
  assert.equal(first.status, "RETRYABLE_FAILURE");
  assert.ok(first.nextAttemptAt);

  const tooEarly = await processOrchestrationEffect(
    { effectId: reminder.id, now: new Date(NOW.getTime() + 1000) },
    providerBundle({ mailbox: flaky }),
  );
  assert.equal(tooEarly.status, "RETRYABLE_FAILURE");
  assert.equal(calls, 1);

  const recovered = await processOrchestrationEffect(
    { effectId: reminder.id, now: new Date(NOW.getTime() + 60_000) },
    providerBundle({ mailbox: flaky }),
  );
  assert.equal(recovered.status, "SUCCEEDED");
  assert.equal(calls, 2);
  assert.equal(recovered.attemptCount, 2);
});

test("COMMERCE 08.5: expired processing lease is recoverable and auditable", async () => {
  const setup = await createPaidBooking();
  await applyVerifiedPaymentCallback(
    verifiedGateway({ amountMinor: 20000, eventId: "event-lease-recovery" }),
    {
      orderId: setup.order.id,
      callbackKey: "callback-lease-recovery",
      callbackPayload: "opaque",
      provider: "test-pay",
      now: NOW,
    },
  );
  const confirmed = await __bookingLifecycleTestOnly!.approve({
    bookingId: setup.booking.id,
    expectedVersion: setup.booking.version,
    now: NOW,
  });
  const reminder = await enqueueBookingReminder({
    bookingId: confirmed.id,
    reminderKey: "lease-recovery",
    now: NOW,
  });

  const db = await getDb();
  await db
    .update(orchestrationEffects)
    .set({
      status: "PROCESSING",
      claimToken: "dead-worker",
      leaseExpiresAt: new Date(NOW.getTime() - 1000),
    })
    .where(eq(orchestrationEffects.id, reminder.id));

  const recovered = await processOrchestrationEffect(
    { effectId: reminder.id, now: NOW },
    providerBundle({ mailbox: configuredMailbox() }),
  );
  assert.equal(recovered.status, "SUCCEEDED");
  const history = await getOrchestrationHistory(reminder.id);
  assert.ok(history.some((entry) => entry.action === "LEASE_RECOVERED"));
});

test("COMMERCE 08.5: migration journal/snapshot include unique 0015 identity", async () => {
  const { existsSync, readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const journal = JSON.parse(
    readFileSync(join(process.cwd(), "drizzle", "migrations", "meta", "_journal.json"), "utf8"),
  );
  const tags = journal.entries.map((entry: { tag: string }) => entry.tag);
  assert.equal(tags.filter((tag: string) => tag.startsWith("0015_")).length, 1);
  assert.ok(tags.includes("0015_order_orchestration"));
  assert.ok(
    existsSync(join(process.cwd(), "drizzle", "migrations", "meta", "0015_snapshot.json")),
  );
});
