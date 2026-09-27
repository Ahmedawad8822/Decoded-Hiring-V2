/**
 * MISSION 08.7 — Studio Scheduling / Commerce Control Plane
 *
 * Regression targets:
 * - Booking Type configuration preserves identity and linked-Offer ownership.
 * - Server Actions and aggregate reads fail closed without admin auth.
 * - Authenticated admin-operation seams compose each state-changing category.
 * - Booking lifecycle keeps CAS/stale-version protection through Studio.
 * - Manual payment requires evidence and enqueues durable fulfillment.
 * - Operational totals stay authoritative while bounded lists paginate honestly.
 * - Browser projection excludes unused sensitive/provider-internal fields.
 * - Studio stays discoverable without provider activation/credential controls.
 */

import "./helpers/env";

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { count, eq } from "drizzle-orm";

import { disposeCloudflareBindings } from "../src/lib/cloudflare/bindings";
import {
  bookingTypes,
  bookings,
  orchestrationEffects,
  orders,
} from "../src/lib/db";
import { getDb } from "../src/lib/db";
import { migrateLocalDb } from "../src/lib/db/migrate";
import { createOffer } from "@/features/offers/service";
import {
  createOrder,
  __commerceTestOnly,
} from "@/features/commerce/orders";
import { createCommerceAdminOperations } from "@/features/commerce/admin-operations";
import {
  getCommerceAdminDashboard,
  getCommerceAdminDashboardWithGuard,
} from "@/features/commerce/admin";
import { createBookingTypeAdminAction } from "@/features/commerce/admin-actions";
import { deleteAvailabilityWindow } from "@/features/scheduling/policy";
import {
  acquireSlotHold,
  createAvailabilityWindow,
  createBookingRequest,
  createBookingType,
  generateAcquisitionKey,
  getActiveBookingType,
  getBookingTypeById,
  getBookingTypeWindows,
  updateBookingType,
} from "@/features/scheduling";
import { __bookingLifecycleTestOnly } from "@/features/scheduling/bookings";

if (!__commerceTestOnly || !__bookingLifecycleTestOnly) {
  throw new Error("Mission 08.7 test seams were not enabled by tests/helpers/env.");
}
const commerceTest = __commerceTestOnly;
const lifecycleTest = __bookingLifecycleTestOnly;

const PREFIX = `studio-commerce-${Date.now().toString(36)}`;
const BOOK_NOW = new Date("2026-10-27T12:00:00.000Z");
const BOOK_SLOT = new Date("2026-10-27T14:00:00.000Z");
let seq = 0;

function unique(prefix: string): string {
  return `${PREFIX}-${prefix}-${seq++}`;
}

async function makeBookingType(
  confirmationPolicy: "AUTO_CONFIRM" | "AHMED_APPROVAL" | "REQUEST_ONLY",
) {
  const bookingType = await createBookingType({
    slug: unique("booking"),
    title: `Studio Booking ${seq}`,
    description: null,
    durationMinutes: 60,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    minimumNoticeMinutes: 0,
    bookingHorizonDays: 30,
    timezone: "America/New_York",
    confirmationPolicy,
    accessMode: "FREE",
    meetingMethod: "TO_BE_CONFIRMED",
    attendeeLimit: 1,
  });
  await createAvailabilityWindow({
    bookingTypeId: bookingType.id,
    weekday: 2,
    startMinute: 540,
    endMinute: 1020,
  });
  return bookingType;
}

async function makeBooking(
  confirmationPolicy: "AHMED_APPROVAL" | "REQUEST_ONLY",
  emailSuffix: string,
) {
  const bookingType = await makeBookingType(confirmationPolicy);
  const acquisitionKey = generateAcquisitionKey();
  const held = await acquireSlotHold({
    bookingTypeId: bookingType.id,
    startAt: BOOK_SLOT,
    now: BOOK_NOW,
    ttlMinutes: 60,
    acquisitionKey,
  });
  assert.equal(held.success, true);
  if (!held.success) throw new Error("Expected slot hold.");

  const booking = await createBookingRequest({
    bookingTypeId: bookingType.id,
    holdId: held.hold.id,
    holdAcquisitionKey: held.acquisitionKey,
    requestKey: crypto.randomUUID(),
    requesterName: "Studio Operator Test",
    requesterEmail: `studio-${emailSuffix}@example.com`,
    requesterPhone: "+201000000000",
    notes: "Sensitive qualification note must not enter dashboard projection.",
    now: BOOK_NOW,
  });
  return { bookingType, booking };
}

async function makeManualOrder() {
  const offer = await createOffer({
    kind: "PRODUCT",
    title: "Manual invoice product",
    slug: unique("manual-offer"),
    accessMode: "MANUAL_INVOICE",
    active: true,
  });
  const order = await createOrder({
    offerId: offer.id,
    requestKey: crypto.randomUUID(),
    customerEmail: `${unique("payer")}@example.com`,
    quantity: 1,
    now: BOOK_NOW,
  });
  return { offer, order };
}

function trustedDependencies() {
  return {
    approveBooking: (input: Parameters<typeof lifecycleTest.approve>[0]) =>
      lifecycleTest.approve(input, "studio-admin"),
    declineBooking: (input: Parameters<typeof lifecycleTest.decline>[0]) =>
      lifecycleTest.decline(input, "studio-admin"),
    cancelBooking: (input: Parameters<typeof lifecycleTest.cancel>[0]) =>
      lifecycleTest.cancel(input, "studio-admin"),
    completeBooking: (input: Parameters<typeof lifecycleTest.complete>[0]) =>
      lifecycleTest.complete(input, "studio-admin"),
    recordManualPayment: (
      input: Parameters<typeof commerceTest.recordManualPayment>[0],
    ) => commerceTest.recordManualPayment(input, "studio-admin"),
  };
}

test.before(async () => {
  await migrateLocalDb();
});

test.after(async () => {
  await disposeCloudflareBindings();
});

test("STUDIO 08.7: Booking Type configuration updates in place and can fail closed", async () => {
  const created = await createBookingType({
    slug: unique("base"),
    title: "Studio Coaching",
    description: "Initial policy",
    durationMinutes: 60,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    minimumNoticeMinutes: 60,
    bookingHorizonDays: 30,
    timezone: "Africa/Cairo",
    confirmationPolicy: "AHMED_APPROVAL",
    accessMode: "FREE",
    meetingMethod: "TO_BE_CONFIRMED",
    attendeeLimit: 1,
  });

  const updated = await updateBookingType({
    id: created.id,
    title: "Studio Coaching Updated",
    durationMinutes: 75,
    minimumNoticeMinutes: 180,
    active: false,
  });

  assert.equal(updated.id, created.id);
  assert.equal(updated.title, "Studio Coaching Updated");
  assert.equal(updated.durationMinutes, 75);
  assert.equal(updated.minimumNoticeMinutes, 180);
  assert.equal(updated.active, false);
  assert.equal(await getActiveBookingType(created.slug), null);

  const reread = await getBookingTypeById(created.id);
  assert.equal(reread?.id, created.id);
  assert.equal(reread?.active, false);
});

test("STUDIO 08.7: linked Offer owns Booking Type access mode", async () => {
  const bookingType = await createBookingType({
    slug: unique("offer-owned"),
    title: "Offer-owned Booking Type",
    description: null,
    durationMinutes: 60,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    minimumNoticeMinutes: 60,
    bookingHorizonDays: 30,
    timezone: "Africa/Cairo",
    confirmationPolicy: "AHMED_APPROVAL",
    accessMode: "FREE",
    meetingMethod: "TO_BE_CONFIRMED",
    attendeeLimit: 1,
  });

  await createOffer({
    kind: "COACHING",
    bookingTypeId: bookingType.id,
    title: "Offer-owned Coaching",
    slug: unique("offer"),
    accessMode: "MANUAL_INVOICE",
    active: true,
  });

  await assert.rejects(
    updateBookingType({
      id: bookingType.id,
      accessMode: "PAYMENT_DISABLED",
    }),
    /Booking access is owned by linked Offer/i,
  );

  const reread = await getBookingTypeById(bookingType.id);
  assert.equal(reread?.accessMode, "FREE");
});

test("STUDIO 08.7: availability-window removal targets one exact row", async () => {
  const bookingType = await createBookingType({
    slug: unique("windows"),
    title: "Studio Availability",
    description: null,
    durationMinutes: 45,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    minimumNoticeMinutes: 0,
    bookingHorizonDays: 14,
    timezone: "Africa/Cairo",
    confirmationPolicy: "AUTO_CONFIRM",
    accessMode: "FREE",
    meetingMethod: "TO_BE_CONFIRMED",
    attendeeLimit: 1,
  });

  const first = await createAvailabilityWindow({
    bookingTypeId: bookingType.id,
    weekday: 0,
    startMinute: 540,
    endMinute: 720,
  });
  const second = await createAvailabilityWindow({
    bookingTypeId: bookingType.id,
    weekday: 1,
    startMinute: 600,
    endMinute: 780,
  });

  assert.equal(await deleteAvailabilityWindow(first.id), true);
  assert.equal(await deleteAvailabilityWindow(first.id), false);

  const remaining = await getBookingTypeWindows(bookingType.id);
  assert.deepEqual(remaining.map((row) => row.id), [second.id]);
});

test("STUDIO 08.7: public Server Action fails closed without admin auth", async () => {
  const slug = unique("blocked");
  const result = await createBookingTypeAdminAction({
    slug,
    title: "Must Not Persist",
    durationMinutes: 60,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    minimumNoticeMinutes: 0,
    bookingHorizonDays: 30,
    timezone: "Africa/Cairo",
    confirmationPolicy: "AUTO_CONFIRM",
    accessMode: "FREE",
    meetingMethod: "TO_BE_CONFIRMED",
    attendeeLimit: 1,
  });

  assert.equal(result.ok, false);
  const db = await getDb();
  const persisted = await db
    .select({ id: bookingTypes.id })
    .from(bookingTypes)
    .where(eq(bookingTypes.slug, slug))
    .get();
  assert.equal(persisted, undefined);
});

test("STUDIO 08.7: aggregate read model fails closed without admin auth", async () => {
  await assert.rejects(getCommerceAdminDashboard());
});

test("STUDIO 08.7: authenticated operation seam composes Offer, Booking Type and availability mutations", async () => {
  let guardCalls = 0;
  const operations = createCommerceAdminOperations(
    async () => {
      guardCalls += 1;
      return { id: "studio-admin" };
    },
    () => BOOK_NOW,
    trustedDependencies(),
  );

  const offerResult = await operations.createOffer({
    kind: "PRODUCT",
    title: "Studio Product",
    slug: unique("ops-offer"),
    accessMode: "COMING_SOON",
    alternativeCtaLabel: "Ask us",
    alternativeCtaUrl: "/contact",
    active: true,
  });
  assert.equal(offerResult.ok, true);
  assert.ok(offerResult.data?.id);

  const offerUpdate = await operations.updateOffer({
    id: offerResult.data!.id,
    title: "Studio Product Updated",
    active: false,
  });
  assert.equal(offerUpdate.ok, true);

  const typeResult = await operations.createBookingType({
    slug: unique("ops-type"),
    title: "Operations Type",
    durationMinutes: 30,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    minimumNoticeMinutes: 0,
    bookingHorizonDays: 30,
    timezone: "Africa/Cairo",
    confirmationPolicy: "AHMED_APPROVAL",
    accessMode: "FREE",
    meetingMethod: "TO_BE_CONFIRMED",
    attendeeLimit: 1,
  });
  assert.equal(typeResult.ok, true);

  const typeUpdate = await operations.updateBookingType({
    id: typeResult.data!.id,
    title: "Operations Type Updated",
  });
  assert.equal(typeUpdate.ok, true);

  const windowResult = await operations.createAvailabilityWindow({
    bookingTypeId: typeResult.data!.id,
    weekday: 3,
    startMinute: 600,
    endMinute: 720,
  });
  assert.equal(windowResult.ok, true);

  const windowDelete = await operations.deleteAvailabilityWindow(
    windowResult.data!.id,
  );
  assert.equal(windowDelete.ok, true);
  assert.equal(windowDelete.data?.deleted, true);
  assert.equal(guardCalls, 6);
});

test("STUDIO 08.7: booking operation success and stale-version rejection preserve lifecycle CAS", async () => {
  const { booking } = await makeBooking("AHMED_APPROVAL", unique("approve"));
  const operations = createCommerceAdminOperations(
    async () => ({ id: "studio-admin" }),
    () => BOOK_NOW,
    trustedDependencies(),
  );

  const approved = await operations.bookingDecision({
    action: "approve",
    bookingId: booking.id,
    expectedVersion: booking.version,
  });
  assert.equal(approved.ok, true);
  assert.equal(approved.data?.status, "CONFIRMED");

  const staleCancel = await operations.bookingDecision({
    action: "cancel",
    bookingId: booking.id,
    expectedVersion: booking.version,
    reason: "Stale operator tab",
  });
  assert.equal(staleCancel.ok, false);
  assert.match(staleCancel.error ?? "", /version mismatch/i);
});

test("STUDIO 08.7: manual payment evidence commits PAID truth and enqueues durable fulfillment", async () => {
  const { order } = await makeManualOrder();
  const operations = createCommerceAdminOperations(
    async () => ({ id: "studio-admin" }),
    () => BOOK_NOW,
    trustedDependencies(),
  );

  const missingEvidence = await operations.recordManualPayment({
    orderId: order.id,
    expectedVersion: order.version,
    note: "x",
  });
  assert.equal(missingEvidence.ok, false);
  assert.match(missingEvidence.error ?? "", /payment reference|evidence note/i);

  const paid = await operations.recordManualPayment({
    orderId: order.id,
    expectedVersion: order.version,
    note: "Bank transfer ref DH-12345",
  });
  assert.equal(paid.ok, true);
  assert.equal(paid.data?.status, "PAID");

  const db = await getDb();
  const persisted = await db
    .select()
    .from(orders)
    .where(eq(orders.id, order.id))
    .get();
  assert.equal(persisted?.status, "PAID");

  const effect = await db
    .select()
    .from(orchestrationEffects)
    .where(eq(orchestrationEffects.subjectId, order.id))
    .get();
  assert.equal(effect?.effectType, "ORDER_FULFILL");

  const history = await commerceTest.getHistory(order.id);
  assert.match(history.at(-1)?.detail ?? "", /DH-12345/);
});

test("STUDIO 08.7: operational read model reports authoritative totals and paginates bounded state honestly", async () => {
  const requested = await makeBooking("REQUEST_ONLY", unique("request"));
  const approval = await makeBooking("AHMED_APPROVAL", unique("approval"));
  const manual = await makeManualOrder();

  const db = await getDb();
  const blockedRows = Array.from({ length: 55 }, (_, index) => ({
    id: unique(`blocked-${index}`),
    subjectType: "BOOKING" as const,
    subjectId: unique(`subject-${index}`),
    effectType: "CALENDAR_CREATE" as const,
    providerKind: "calendar" as const,
    idempotencyKey: unique(`idem-${index}`),
    dependsOnEffectId: null,
    payload: "{}",
    status: "BLOCKED" as const,
    attemptCount: 0,
    createdAt: BOOK_NOW,
    updatedAt: BOOK_NOW,
  }));
  for (let offset = 0; offset < blockedRows.length; offset += 5) {
    await db
      .insert(orchestrationEffects)
      .values(blockedRows.slice(offset, offset + 5))
      .run();
  }

  const dashboard = await getCommerceAdminDashboardWithGuard(
    async () => ({ id: "studio-admin" }),
    { effects: 1 },
  );

  const blockedCount = await db
    .select({ value: count() })
    .from(orchestrationEffects)
    .where(eq(orchestrationEffects.status, "BLOCKED"))
    .get();
  const requestedCount = await db
    .select({ value: count() })
    .from(bookings)
    .where(eq(bookings.status, "REQUESTED"))
    .get();
  const approvalCount = await db
    .select({ value: count() })
    .from(bookings)
    .where(eq(bookings.status, "PENDING_APPROVAL"))
    .get();

  assert.equal(
    dashboard.summary.blockedEffects,
    Number(blockedCount?.value ?? 0),
  );
  assert.equal(
    dashboard.summary.requestedBookings,
    Number(requestedCount?.value ?? 0),
  );
  assert.equal(
    dashboard.summary.approvalQueue,
    Number(approvalCount?.value ?? 0),
  );
  assert.ok(dashboard.orchestrationEffects.total > 50);
  assert.equal(dashboard.orchestrationEffects.items.length, 50);
  assert.equal(dashboard.orchestrationEffects.page, 1);
  assert.ok(dashboard.orchestrationEffects.totalPages >= 2);
  assert.equal(dashboard.orchestrationEffects.truncated, true);

  const secondPage = await getCommerceAdminDashboardWithGuard(
    async () => ({ id: "studio-admin" }),
    { effects: 2 },
  );
  assert.equal(secondPage.orchestrationEffects.page, 2);
  assert.equal(
    secondPage.orchestrationEffects.total,
    dashboard.orchestrationEffects.total,
  );

  assert.ok(
    dashboard.requestedBookings.items.some(
      (row) => row.id === requested.booking.id,
    ),
  );
  assert.ok(
    dashboard.approvalQueue.items.some(
      (row) => row.id === approval.booking.id,
    ),
  );
  assert.ok(dashboard.orders.items.some((row) => row.id === manual.order.id));

  const bookingProjection =
    dashboard.approvalQueue.items.find(
      (row) => row.id === approval.booking.id,
    )!;
  assert.equal("notes" in bookingProjection, false);
  assert.equal("requesterPhone" in bookingProjection, false);

  const orderProjection =
    dashboard.orders.items.find((row) => row.id === manual.order.id)!;
  assert.equal("providerPaymentId" in orderProjection, false);
  assert.equal("providerCheckoutId" in orderProjection, false);
});

test("STUDIO 08.7: unexpected admin-operation errors are sanitized", async () => {
  const dependencies = trustedDependencies();
  dependencies.approveBooking = async () => {
    throw new Error("SQLITE_INTERNAL secret_table leaked");
  };
  const operations = createCommerceAdminOperations(
    async () => ({ id: "studio-admin" }),
    () => BOOK_NOW,
    dependencies,
  );

  const result = await operations.bookingDecision({
    action: "approve",
    bookingId: "bk_nonexistent",
    expectedVersion: 1,
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "Failed to update booking.");
});

test("STUDIO 08.7: Studio modules are discoverable, decomposed and cannot activate providers", () => {
  const shell = readFileSync("src/app/admin/studio-shell.tsx", "utf8");
  const client = readFileSync(
    "src/app/admin/commerce/commerce-client.tsx",
    "utf8",
  );
  const overview = readFileSync(
    "src/app/admin/commerce/commerce-overview.tsx",
    "utf8",
  );
  const bookingsUi = readFileSync(
    "src/app/admin/commerce/booking-operations.tsx",
    "utf8",
  );
  const ordersUi = readFileSync(
    "src/app/admin/commerce/orders-section.tsx",
    "utf8",
  );
  const bookingTypesUi = readFileSync(
    "src/app/admin/commerce/booking-types-section.tsx",
    "utf8",
  );
  const actions = readFileSync(
    "src/features/commerce/admin-actions.ts",
    "utf8",
  );

  assert.match(shell, /\/admin\/commerce/);
  assert.match(shell, /Scheduling & Commerce/);
  assert.match(client, /CommerceOverview/);
  assert.match(client, /BookingOperations/);
  assert.match(client, /OffersSection/);
  assert.match(client, /BookingTypesSection/);
  assert.match(client, /OrdersSection/);
  assert.match(overview, /Provider readiness/);
  assert.match(bookingsUi, /Requested bookings/);
  assert.match(bookingsUi, /Approval queue/);
  assert.match(ordersUi, /Payment reference \/ evidence note/);
  assert.match(ordersUi, /window\.confirm/);
  assert.match(bookingTypesUi, /Managed by linked Offer/);
  assert.match(actions, /requireAdmin/);

  assert.doesNotMatch(
    actions,
    /activateProvider|setProviderSecret|saveCredential/i,
  );
  assert.doesNotMatch(
    client,
    /Activate provider|Save secret|API key/i,
  );
});
