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
  processDueOrchestrationEffects,
  processOrchestrationEffect,
  resumeConfiguredBlockedEffects,
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
  const userId = `user_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
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
    verifyWebhookPayment: async (input) => ({
      verified: true,
      orderId: input.orderId,
      state: params.state ?? "PAID",
      providerEventId: params.eventId ?? "webhook-event",
      providerPaymentId: `payment-${input.orderId}`,
      amountMinor: params.amountMinor ?? 12500,
      currency: params.currency ?? "USD",
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

async function createPaidBooking(
  confirmationPolicy: "AUTO_CONFIRM" | "AHMED_APPROVAL" | "REQUEST_ONLY" = "AHMED_APPROVAL",
) {
  const bookingType = await createBookingType({
    slug: slug("paid-session"),
    title: "Paid Coaching",
    durationMinutes: 60,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    minimumNoticeMinutes: 0,
    bookingHorizonDays: 30,
    timezone: "America/New_York",
    confirmationPolicy,
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

test("COMMERCE 08.5: linked course orders reject quantity greater than one", async () => {
  const setup = await createCourseOffer();
  await assert.rejects(
    createOrder({
      offerId: setup.offer.id,
      userId: setup.userId,
      requestKey: crypto.randomUUID(),
      customerEmail: `${setup.userId}@example.com`,
      quantity: 2,
      now: NOW,
    }),
    (error: unknown) =>
      error instanceof CommerceDomainError &&
      error.code === "ORDER_NOT_ALLOWED",
  );
});

test("COMMERCE 08.5: booking-linked manual invoice cannot create an orphan order", async () => {
  const bookingType = await createBookingType({
    slug: slug("manual-invoice-session"),
    title: "Manual Invoice Session",
    durationMinutes: 60,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    minimumNoticeMinutes: 0,
    bookingHorizonDays: 30,
    timezone: "America/New_York",
    confirmationPolicy: "AHMED_APPROVAL",
    accessMode: "MANUAL_INVOICE",
    meetingMethod: "TO_BE_CONFIRMED",
    attendeeLimit: 1,
  });
  const offer = await createOffer({
    kind: "COACHING",
    bookingTypeId: bookingType.id,
    title: "Manual Invoice Offer",
    slug: slug("manual-invoice-offer"),
    accessMode: "MANUAL_INVOICE",
  });

  await assert.rejects(
    createOrder({
      offerId: offer.id,
      requestKey: crypto.randomUUID(),
      customerEmail: "manual@example.com",
      now: NOW,
    }),
    (error: unknown) =>
      error instanceof CommerceDomainError &&
      error.code === "ORDER_NOT_ALLOWED",
  );
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

test("COMMERCE 08.5: webhook payment truth comes only from the verified signed-envelope boundary", async () => {
  const setup = await createPaidCourseOrder();
  let legacySplitCalls = 0;
  const gateway: PaymentGateway = {
    ...verifiedGateway(),
    verifyWebhookPayment: async (input) => ({
      verified: false,
      orderId: input.orderId,
    }),
    verifyWebhookSignature: async () => {
      legacySplitCalls += 1;
      return { valid: true, providerEventId: "must-not-be-used" };
    },
    normalizePaymentState: async (input) => {
      legacySplitCalls += 1;
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
      rawBody: '{"event":"payment","state":"paid"}',
      signature: "invalid",
      provider: "test-pay",
      now: NOW,
    }),
    (error: unknown) =>
      error instanceof CommerceDomainError &&
      error.code === "PAYMENT_EVIDENCE_INVALID",
  );

  assert.equal(legacySplitCalls, 0);
  assert.equal((await __commerceTestOnly!.getOrder(setup.order.id))?.status, "PENDING");
  assert.equal((await getPaymentEvents(setup.order.id)).length, 0);
});

test("COMMERCE 08.5: verified webhook dedupes by provider event identity", async () => {
  const setup = await createPaidCourseOrder();
  const gateway = verifiedGateway({ eventId: "webhook-event-unique" });
  const input = {
    orderId: setup.order.id,
    rawBody: '{"event":"same","state":"paid","amountMinor":12500,"currency":"USD"}',
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

test("COMMERCE 08.5: provider event identity dedupes even when local callback key changes", async () => {
  const setup = await createPaidCourseOrder();
  const gateway = verifiedGateway({ eventId: "provider-event-stable" });

  const first = await applyVerifiedPaymentCallback(gateway, {
    orderId: setup.order.id,
    callbackKey: "callback-local-a",
    callbackPayload: "opaque-a",
    provider: "test-pay",
    now: NOW,
  });
  const second = await applyVerifiedPaymentCallback(gateway, {
    orderId: setup.order.id,
    callbackKey: "callback-local-b",
    callbackPayload: "opaque-b",
    provider: "test-pay",
    now: new Date(NOW.getTime() + 1000),
  });

  assert.equal(first.status, "PAID");
  assert.equal(second.version, first.version);
  assert.equal((await getPaymentEvents(first.id)).length, 1);
});

test("COMMERCE 08.5: concurrent same provider event collapses across different local callback keys", async () => {
  const setup = await createPaidCourseOrder();
  const gateway = verifiedGateway({ eventId: "provider-event-concurrent" });

  const [a, b] = await Promise.all([
    applyVerifiedPaymentCallback(gateway, {
      orderId: setup.order.id,
      callbackKey: "callback-concurrent-a",
      callbackPayload: "opaque-a",
      provider: "test-pay",
      now: NOW,
    }),
    applyVerifiedPaymentCallback(gateway, {
      orderId: setup.order.id,
      callbackKey: "callback-concurrent-b",
      callbackPayload: "opaque-b",
      provider: "test-pay",
      now: NOW,
    }),
  ]);

  assert.equal(a.id, b.id);
  assert.equal(a.status, "PAID");
  assert.equal(b.status, "PAID");
  assert.equal((await getPaymentEvents(a.id)).length, 1);
});

test("COMMERCE 08.5: callback provider metadata cannot contradict adapter identity", async () => {
  const setup = await createPaidCourseOrder();
  await assert.rejects(
    applyVerifiedPaymentCallback(
      verifiedGateway({ eventId: "provider-event-mismatch" }),
      {
        orderId: setup.order.id,
        callbackKey: "callback-provider-mismatch",
        callbackPayload: "opaque",
        provider: "spoofed-provider",
        now: NOW,
      },
    ),
    (error: unknown) =>
      error instanceof CommerceDomainError &&
      error.code === "PAYMENT_EVIDENCE_INVALID",
  );
  assert.equal((await __commerceTestOnly!.getOrder(setup.order.id))?.status, "PENDING");
  assert.equal((await getPaymentEvents(setup.order.id)).length, 0);
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
    .all()
    .then((rows) => rows.find((row) => row.effectType === "ORDER_FULFILL"));
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

test("COMMERCE 08.5: refund before fulfillment closes obsolete effect without granting course access", async () => {
  const setup = await createPaidCourseOrder();
  const paidGateway = verifiedGateway({ eventId: "event-refund-before-fulfillment" });

  const paid = await applyVerifiedPaymentCallback(paidGateway, {
    orderId: setup.order.id,
    callbackKey: "callback-paid-before-refund",
    callbackPayload: "opaque-paid",
    provider: "test-pay",
    now: NOW,
  });
  assert.equal(paid.status, "PAID");

  const db = await getDb();
  const effect = await db
    .select()
    .from(orchestrationEffects)
    .where(eq(orchestrationEffects.subjectId, paid.id))
    .all()
    .then((rows) => rows.find((row) => row.effectType === "ORDER_FULFILL"));
  assert.ok(effect);

  const refunded = await applyVerifiedPaymentCallback(
    verifiedGateway({
      state: "REFUNDED",
      eventId: "event-refund-final",
    }),
    {
      orderId: paid.id,
      callbackKey: "callback-refund-final",
      callbackPayload: "opaque-refund",
      provider: "test-pay",
      now: new Date(NOW.getTime() + 1000),
    },
  );
  assert.equal(refunded.status, "REFUNDED");

  const closed = await processOrchestrationEffect({
    effectId: effect.id,
    now: new Date(NOW.getTime() + 2000),
  });
  assert.equal(closed.status, "SUCCEEDED");

  const refundEffect = await db
    .select()
    .from(orchestrationEffects)
    .where(eq(orchestrationEffects.subjectId, paid.id))
    .all()
    .then((rows) => rows.find((row) => row.effectType === "ORDER_REFUND_RECONCILE"));
  assert.ok(refundEffect);
  const reconciled = await processOrchestrationEffect({
    effectId: refundEffect.id,
    now: new Date(NOW.getTime() + 3000),
  });
  assert.equal(reconciled.status, "SUCCEEDED");

  const enrollment = await db
    .select()
    .from(enrollments)
    .where(eq(enrollments.userId, setup.userId))
    .get();
  assert.equal(enrollment, undefined);
  assert.equal((await __commerceTestOnly!.getOrder(paid.id))?.status, "REFUNDED");
});

test("COMMERCE 08.5: refund after fulfillment revokes only access owned by that order", async () => {
  const setup = await createPaidCourseOrder();
  const paid = await applyVerifiedPaymentCallback(
    verifiedGateway({ eventId: "event-refund-after-fulfillment-paid" }),
    {
      orderId: setup.order.id,
      callbackKey: "callback-refund-after-fulfillment-paid",
      callbackPayload: "opaque-paid",
      provider: "test-pay",
      now: NOW,
    },
  );

  const db = await getDb();
  const fulfillment = await db
    .select()
    .from(orchestrationEffects)
    .where(eq(orchestrationEffects.subjectId, paid.id))
    .all()
    .then((rows) => rows.find((row) => row.effectType === "ORDER_FULFILL"));
  assert.ok(fulfillment);

  await processOrchestrationEffect({
    effectId: fulfillment.id,
    now: new Date(NOW.getTime() + 1000),
  });

  const granted = await db
    .select()
    .from(enrollments)
    .where(eq(enrollments.userId, setup.userId))
    .get();
  assert.equal(granted?.status, "active");
  assert.equal(granted?.accessSource, `order:${paid.id}`);

  const refunded = await applyVerifiedPaymentCallback(
    verifiedGateway({
      state: "REFUNDED",
      eventId: "event-refund-after-fulfillment-final",
    }),
    {
      orderId: paid.id,
      callbackKey: "callback-refund-after-fulfillment-final",
      callbackPayload: "opaque-refund",
      provider: "test-pay",
      now: new Date(NOW.getTime() + 2000),
    },
  );
  assert.equal(refunded.status, "REFUNDED");

  const refundEffect = await db
    .select()
    .from(orchestrationEffects)
    .where(eq(orchestrationEffects.subjectId, paid.id))
    .all()
    .then((rows) => rows.find((row) => row.effectType === "ORDER_REFUND_RECONCILE"));
  assert.ok(refundEffect);

  const reconciled = await processOrchestrationEffect({
    effectId: refundEffect.id,
    now: new Date(NOW.getTime() + 3000),
  });
  assert.equal(reconciled.status, "SUCCEEDED");

  const revoked = await db
    .select()
    .from(enrollments)
    .where(eq(enrollments.userId, setup.userId))
    .get();
  assert.equal(revoked?.status, "cancelled");
  assert.equal(revoked?.accessSource, `order:${paid.id}`);
});

test("COMMERCE 08.5: paid standalone PRODUCT stays PAID when no fulfillment strategy exists", async () => {
  const offer = await createOffer({
    kind: "PRODUCT",
    title: "Future Paid Product",
    slug: slug("future-paid-product"),
    accessMode: "PAID_ONE_TIME",
    currency: "USD",
    amountMinor: 9900,
  });
  const order = await createOrder({
    offerId: offer.id,
    requestKey: crypto.randomUUID(),
    customerEmail: "product@example.com",
    now: NOW,
  });

  const paid = await applyVerifiedPaymentCallback(
    verifiedGateway({
      amountMinor: 9900,
      eventId: "event-product-no-fulfillment",
    }),
    {
      orderId: order.id,
      callbackKey: "callback-product-no-fulfillment",
      callbackPayload: "opaque",
      provider: "test-pay",
      now: NOW,
    },
  );
  assert.equal(paid.status, "PAID");

  const db = await getDb();
  const fulfillment = await db
    .select()
    .from(orchestrationEffects)
    .where(eq(orchestrationEffects.subjectId, paid.id))
    .all()
    .then((rows) => rows.find((row) => row.effectType === "ORDER_FULFILL"));
  assert.ok(fulfillment);

  const blocked = await processOrchestrationEffect({
    effectId: fulfillment.id,
    now: new Date(NOW.getTime() + 1000),
  });
  assert.equal(blocked.status, "BLOCKED");
  assert.equal(blocked.lastErrorCode, "FULFILLMENT_NOT_CONFIGURED");
  assert.equal((await __commerceTestOnly!.getOrder(order.id))?.status, "PAID");
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

test("COMMERCE 08.5: PAID_SESSION AUTO_CONFIRM completes through durable fulfillment orchestration", async () => {
  const setup = await createPaidBooking("AUTO_CONFIRM");
  assert.equal(setup.booking.status, "REQUESTED");

  const paid = await applyVerifiedPaymentCallback(
    verifiedGateway({ amountMinor: 20000, eventId: "event-paid-auto-confirm" }),
    {
      orderId: setup.order.id,
      callbackKey: "callback-paid-auto-confirm",
      callbackPayload: "opaque",
      provider: "test-pay",
      now: NOW,
    },
  );
  assert.equal(paid.status, "PAID");

  const db = await getDb();
  const fulfillment = await db
    .select()
    .from(orchestrationEffects)
    .where(eq(orchestrationEffects.subjectId, paid.id))
    .all()
    .then((rows) => rows.find((row) => row.effectType === "ORDER_FULFILL"));
  assert.ok(fulfillment);

  const completed = await processOrchestrationEffect({
    effectId: fulfillment.id,
    now: new Date(NOW.getTime() + 1000),
  });
  assert.equal(completed.status, "SUCCEEDED");
  assert.equal((await __commerceTestOnly!.getOrder(paid.id))?.status, "FULFILLED");

  const confirmed = await __bookingLifecycleTestOnly!.getBooking(setup.booking.id);
  assert.equal(confirmed?.status, "CONFIRMED");

  const bookingEffects = await db
    .select()
    .from(orchestrationEffects)
    .where(eq(orchestrationEffects.subjectId, setup.booking.id))
    .all();
  assert.ok(bookingEffects.some((effect) => effect.effectType === "CALENDAR_CREATE"));
  assert.ok(bookingEffects.some((effect) => effect.effectType === "MAIL_CONFIRMATION"));
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

test("COMMERCE 08.5: configured providers resume BLOCKED work into bounded worker flow", async () => {
  const setup = await createPaidBooking();
  await applyVerifiedPaymentCallback(
    verifiedGateway({ amountMinor: 20000, eventId: "event-worker-resume" }),
    {
      orderId: setup.order.id,
      callbackKey: "callback-worker-resume",
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
  const calendar = await db
    .select()
    .from(orchestrationEffects)
    .where(eq(orchestrationEffects.subjectId, confirmed.id))
    .all()
    .then((rows) => rows.find((row) => row.effectType === "CALENDAR_CREATE"));
  const mail = await db
    .select()
    .from(orchestrationEffects)
    .where(eq(orchestrationEffects.subjectId, confirmed.id))
    .all()
    .then((rows) => rows.find((row) => row.effectType === "MAIL_CONFIRMATION"));
  assert.ok(calendar);
  assert.ok(mail);

  const blocked = await processOrchestrationEffect({
    effectId: calendar.id,
    now: NOW,
  });
  assert.equal(blocked.status, "BLOCKED");

  const providers = providerBundle({
    calendar: configuredCalendar(),
    mailbox: configuredMailbox(),
  });
  const resumed = await resumeConfiguredBlockedEffects(
    new Date(NOW.getTime() + 1000),
    providers,
  );
  assert.ok(resumed >= 1);
  assert.equal((await getOrchestrationEffect(calendar.id))?.status, "PENDING");

  const firstPass = await processDueOrchestrationEffects(
    { now: new Date(NOW.getTime() + 2000), limit: 20 },
    providers,
  );
  assert.ok(firstPass.some((effect) => effect.id === calendar.id && effect.status === "SUCCEEDED"));

  const secondPass = await processDueOrchestrationEffects(
    { now: new Date(NOW.getTime() + 3000), limit: 20 },
    providers,
  );
  assert.ok(secondPass.some((effect) => effect.id === mail.id && effect.status === "SUCCEEDED"));
});

test("COMMERCE 08.5: invalid provider configuration stays BLOCKED and is not auto-resumed", async () => {
  const setup = await createPaidBooking();
  await applyVerifiedPaymentCallback(
    verifiedGateway({ amountMinor: 20000, eventId: "event-invalid-config" }),
    {
      orderId: setup.order.id,
      callbackKey: "callback-invalid-config",
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
    reminderKey: "invalid-config",
    now: NOW,
  });

  const mailbox: MailboxProvider = {
    ...configuredMailbox(),
    sendReminder: async () => {
      throw new SchedulingProviderError({
        message: "Mailbox sender identity is invalid",
        code: "INVALID_CONFIGURATION",
        providerKind: "mailbox",
        operation: "sendReminder",
        retryable: false,
      });
    },
  };

  const blocked = await processOrchestrationEffect(
    { effectId: reminder.id, now: NOW },
    providerBundle({ mailbox }),
  );
  assert.equal(blocked.status, "BLOCKED");
  assert.equal(blocked.lastErrorCode, "INVALID_CONFIGURATION");

  const directRetry = await processOrchestrationEffect(
    { effectId: reminder.id, now: new Date(NOW.getTime() + 500) },
    providerBundle({ mailbox: configuredMailbox() }),
  );
  assert.equal(directRetry.status, "BLOCKED");

  const resumed = await resumeConfiguredBlockedEffects(
    new Date(NOW.getTime() + 1000),
    providerBundle({ mailbox: configuredMailbox() }),
  );
  assert.equal(resumed, 0);
  assert.equal((await getOrchestrationEffect(reminder.id))?.status, "BLOCKED");
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
