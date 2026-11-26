/**
 * OFFER LIMITS — seat caps and close dates.
 *
 * Proves:
 * - seat_limit / closes_at validation (1..10000, valid date) and persistence
 * - availability maths per kind (course enrollments, booking claims + active
 *   unlinked holds, product orders; cancelled/expired/consumed free the seat)
 * - enforcement on free enrollment, hold acquisition, booking creation and
 *   the dormant checkout path (friendly AppError conflict)
 * - the last-seat race: two concurrent attempts, exactly one wins
 * - closed-by-date refuses new claims but keeps existing ones
 * - admin-only Studio updates with an audit row, and the offers list showing
 *   seats taken / limit / state
 */

import "./helpers/env";

import { strict as assert } from "node:assert";
import { after, before, test } from "node:test";
import { eq } from "drizzle-orm";

import { disposeCloudflareBindings } from "../src/lib/cloudflare/bindings";
import { getDb } from "../src/lib/db";
import { migrateLocalDb } from "../src/lib/db/migrate";
import {
  adminAuditLog,
  bookingHistory,
  bookings,
  bookingAvailabilityWindows,
  bookingTypes,
  courses,
  enrollments,
  offers,
  orderHistory,
  orders,
  slotHolds,
  users,
} from "@/lib/db";
import { isAppError } from "@/lib/errors";
import { cancelMyEnrollment, enrollFree } from "@/features/enrollments/service";
import { createOffer, updateOffer } from "@/features/offers/service";
import { getAvailabilityForOffer, getOfferAvailability } from "@/features/offers/availability";
import { createCommerceAdminOperations } from "@/features/commerce/admin-operations";
import { getCommerceAdminDashboardWithGuard } from "@/features/commerce/admin";
import { createOrder } from "@/features/commerce/orders";
import {
  acquireSlotHold,
  createAvailabilityWindow,
  createBookingRequest,
  createBookingType,
  generateAcquisitionKey,
} from "@/features/scheduling";
import { resolvePublicSchedulingModel } from "@/features/scheduling/public-scheduling";
import { submitPublicBooking } from "@/features/scheduling/public-actions";

const NOW = new Date("2026-10-27T12:00:00.000Z");
const PAST = new Date("2020-05-01T10:00:00.000Z");
const FUTURE = new Date("2030-05-01T10:00:00.000Z");
let seq = 0;

function id(prefix: string): string {
  return `ol_${prefix}_${Date.now().toString(36)}_${seq++}`;
}

function slug(prefix: string): string {
  return `ol-${prefix}-${Date.now().toString(36)}-${seq++}`;
}

async function makeUser(): Promise<string> {
  const db = await getDb();
  const userId = id("user");
  await db.insert(users).values({
    id: userId,
    name: "Offer Limit Learner",
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

async function makeCourse() {
  const db = await getDb();
  const courseId = id("course");
  await db
    .insert(courses)
    .values({
      id: courseId,
      title: `Limit Course ${seq}`,
      slug: slug("course"),
      description: "Offer limits test course",
      status: "published",
      accessMode: "FREE",
      coverImage: null,
      createdAt: NOW,
      updatedAt: NOW,
      publishedAt: NOW,
    });
  return (await db.select().from(courses).where(eq(courses.id, courseId)).get())!;
}

async function makeBookingType() {
  const bookingType = await createBookingType({
    slug: slug("booking"),
    title: `Limit Booking ${seq}`,
    description: null,
    durationMinutes: 60,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    minimumNoticeMinutes: 0,
    bookingHorizonDays: 30,
    timezone: "UTC",
    confirmationPolicy: "AUTO_CONFIRM",
    accessMode: "FREE",
    meetingMethod: "TO_BE_CONFIRMED",
    attendeeLimit: 1,
  });
  await createAvailabilityWindow({
    bookingTypeId: bookingType.id,
    weekday: NOW.getUTCDay(),
    startMinute: 0,
    endMinute: 1440,
  });
  return bookingType;
}

function slotAt(hour: number): Date {
  return new Date(
    Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth(), NOW.getUTCDate(), hour, 0, 0, 0),
  );
}

async function holdSlot(bookingTypeId: string, startAt: Date) {
  const held = await acquireSlotHold({
    bookingTypeId,
    startAt,
    now: NOW,
    ttlMinutes: 30,
    acquisitionKey: generateAcquisitionKey(),
  });
  assert.equal(held.success, true, `hold should land: ${held.success ? "" : held.error}`);
  if (!held.success) throw new Error("Expected slot hold.");
  return held;
}

async function bookSlot(bookingTypeId: string, startAt: Date, emailSuffix: string) {
  const held = await holdSlot(bookingTypeId, startAt);
  return createBookingRequest({
    bookingTypeId,
    holdId: held.hold.id,
    holdAcquisitionKey: held.acquisitionKey,
    requestKey: crypto.randomUUID(),
    requesterName: "Limit Booker",
    requesterEmail: `limit-${emailSuffix}@example.com`,
    requesterPhone: null,
    notes: null,
    now: NOW,
  });
}

before(async () => {
  await migrateLocalDb();
  const db = await getDb();
  await db.delete(orderHistory).run();
  await db.delete(orders).run();
  await db.delete(bookingHistory).run();
  await db.delete(bookings).run();
  await db.delete(slotHolds).run();
  await db.delete(offers).run();
  await db.delete(bookingAvailabilityWindows).run();
  await db.delete(bookingTypes).run();
  await db.delete(enrollments).run();
  await db.delete(courses).run();
});

after(async () => {
  await disposeCloudflareBindings();
});

test("LIMITS: seat_limit validation rejects 0 and 10001, accepts a valid cap", async () => {
  const course = await makeCourse();
  await assert.rejects(
    () =>
      createOffer({
        kind: "COURSE",
        courseId: course.id,
        title: "Zero cap",
        slug: slug("offer"),
        accessMode: "FREE",
        seatLimit: 0,
      }),
    (error: unknown) => error instanceof Error && /Seat limit/.test(error.message),
  );
  await assert.rejects(
    () =>
      createOffer({
        kind: "COURSE",
        courseId: course.id,
        title: "Huge cap",
        slug: slug("offer"),
        accessMode: "FREE",
        seatLimit: 10001,
      }),
    (error: unknown) => error instanceof Error && /Seat limit/.test(error.message),
  );

  const offer = await createOffer({
    kind: "COURSE",
    courseId: course.id,
    title: "Capped course",
    slug: slug("offer"),
    accessMode: "FREE",
    seatLimit: 25,
    closesAt: FUTURE,
  });
  assert.equal(offer.seatLimit, 25);
  assert.equal(offer.closesAt?.toISOString(), FUTURE.toISOString());
});

test("LIMITS: updateOffer can set and clear limits", async () => {
  const course = await makeCourse();
  const offer = await createOffer({
    kind: "COURSE",
    courseId: course.id,
    title: "Mutable cap",
    slug: slug("offer"),
    accessMode: "FREE",
  });
  assert.equal(offer.seatLimit, null);
  assert.equal(offer.closesAt, null);

  const capped = await updateOffer({ id: offer.id, seatLimit: 3, closesAt: FUTURE });
  assert.equal(capped.seatLimit, 3);

  const cleared = await updateOffer({ id: offer.id, seatLimit: null, closesAt: null });
  assert.equal(cleared.seatLimit, null);
  assert.equal(cleared.closesAt, null);
});

test("LIMITS: course availability counts active enrolments, cancelled frees the seat", async () => {
  const course = await makeCourse();
  const offer = await createOffer({
    kind: "COURSE",
    courseId: course.id,
    title: "Counted course",
    slug: slug("offer"),
    accessMode: "FREE",
    seatLimit: 2,
  });

  const empty = await getOfferAvailability(offer.id, NOW);
  assert.equal(empty.seatsTaken, 0);
  assert.equal(empty.seatsLeft, 2);
  assert.equal(empty.state, "open");

  const userA = await makeUser();
  await enrollFree(userA, course.id);
  const one = await getOfferAvailability(offer.id, NOW);
  assert.equal(one.seatsTaken, 1);
  assert.equal(one.seatsLeft, 1);

  // Completed enrolments still occupy a seat.
  const db = await getDb();
  const userB = await makeUser();
  await enrollFree(userB, course.id);
  const enrolledB = await db
    .select()
    .from(enrollments)
    .where(eq(enrollments.courseId, course.id));
  assert.equal(enrolledB.length, 2);
  await db
    .update(enrollments)
    .set({ status: "completed" })
    .where(eq(enrollments.userId, userB));
  const full = await getOfferAvailability(offer.id, NOW);
  assert.equal(full.seatsTaken, 2);
  assert.equal(full.seatsLeft, 0);
  assert.equal(full.state, "sold_out");

  // Cancelling frees the seat again.
  await cancelMyEnrollment(userA, course.id);
  const freed = await getOfferAvailability(offer.id, NOW);
  assert.equal(freed.seatsTaken, 1);
  assert.equal(freed.state, "open");
});

test("LIMITS: free enrollment refuses sold out and closed with AppError conflict", async () => {
  const course = await makeCourse();
  const offer = await createOffer({
    kind: "COURSE",
    courseId: course.id,
    title: "Tiny course",
    slug: slug("offer"),
    accessMode: "FREE",
    seatLimit: 1,
  });
  await enrollFree(await makeUser(), course.id);

  await assert.rejects(
    async () => {
      await enrollFree(await makeUser(), course.id);
    },
    (error: unknown) => {
      assert.ok(isAppError(error));
      assert.equal(error.kind, "conflict");
      assert.match(error.message, /sold out/);
      return true;
    },
  );

  await updateOffer({ id: offer.id, seatLimit: null, closesAt: PAST });
  await assert.rejects(
    async () => {
      await enrollFree(await makeUser(), course.id);
    },
    (error: unknown) => {
      assert.ok(isAppError(error));
      assert.equal(error.kind, "conflict");
      assert.match(error.message, /closed/);
      return true;
    },
  );

  // Existing enrolments are never revoked by the close.
  const db = await getDb();
  const rows = await db
    .select()
    .from(enrollments)
    .where(eq(enrollments.courseId, course.id));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "active");

  const closed = await getOfferAvailability(offer.id, NOW);
  assert.equal(closed.state, "closed");
});

test("LIMITS: last-seat enrollment race — two concurrent attempts, one wins", async () => {
  const course = await makeCourse();
  await createOffer({
    kind: "COURSE",
    courseId: course.id,
    title: "Racy course",
    slug: slug("offer"),
    accessMode: "FREE",
    seatLimit: 1,
  });
  const [userA, userB] = [await makeUser(), await makeUser()];

  const results = await Promise.allSettled([
    enrollFree(userA, course.id),
    enrollFree(userB, course.id),
  ]);
  const won = results.filter((r) => r.status === "fulfilled");
  const lost = results.filter((r) => r.status === "rejected");
  assert.equal(won.length, 1);
  assert.equal(lost.length, 1);
  const reason = (lost[0] as PromiseRejectedResult).reason;
  assert.ok(isAppError(reason));
  assert.equal(reason.kind, "conflict");
  assert.match(reason.message, /sold out/);

  const db = await getDb();
  const rows = await db
    .select()
    .from(enrollments)
    .where(eq(enrollments.courseId, course.id));
  assert.equal(rows.length, 1);
});

test("LIMITS: booking availability counts bookings plus active unlinked holds", async () => {
  const bookingType = await makeBookingType();
  const offer = await createOffer({
    kind: "COACHING",
    bookingTypeId: bookingType.id,
    title: "Counted coaching",
    slug: slug("offer"),
    accessMode: "FREE",
    seatLimit: 5,
  });

  // A confirmed booking occupies one seat (its hold is consumed, not double-counted).
  await bookSlot(bookingType.id, slotAt(14), "taken-1");
  const afterBooking = await getOfferAvailability(offer.id, NOW);
  assert.equal(afterBooking.seatsTaken, 1);

  // An active hold without a booking yet occupies a seat too.
  await holdSlot(bookingType.id, slotAt(15));
  const afterHold = await getOfferAvailability(offer.id, NOW);
  assert.equal(afterHold.seatsTaken, 2);
  assert.equal(afterHold.seatsLeft, 3);

  const db = await getDb();
  // Expired, consumed and released holds, and non-active bookings, free the seat.
  const expiredId = id("hold");
  await db.insert(slotHolds).values({
    id: expiredId,
    bookingTypeId: bookingType.id,
    slotKey: `ol-expired-${seq}`,
    startAt: slotAt(16),
    endAt: slotAt(17),
    ownerToken: "hold_deadbeef",
    acquisitionKey: crypto.randomUUID(),
    status: "HELD",
    expiresAt: new Date(NOW.getTime() - 60_000),
    consumedAt: null,
    releasedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  });
  const unchanged = await getOfferAvailability(offer.id, NOW);
  assert.equal(unchanged.seatsTaken, 2);
});

test("LIMITS: hold and booking creation refuse sold out with AppError conflict", async () => {
  const bookingType = await makeBookingType();
  await createOffer({
    kind: "COACHING",
    bookingTypeId: bookingType.id,
    title: "Single seat coaching",
    slug: slug("offer"),
    accessMode: "FREE",
    seatLimit: 1,
  });

  await bookSlot(bookingType.id, slotAt(14), "solo");

  await assert.rejects(
    () =>
      acquireSlotHold({
        bookingTypeId: bookingType.id,
        startAt: slotAt(15),
        now: NOW,
        ttlMinutes: 30,
        acquisitionKey: generateAcquisitionKey(),
      }),
    (error: unknown) => {
      assert.ok(isAppError(error));
      assert.equal(error.kind, "conflict");
      assert.match(error.message, /sold out/);
      return true;
    },
  );
});

test("LIMITS: last-seat hold race — two concurrent acquires, one wins", async () => {
  const bookingType = await makeBookingType();
  await createOffer({
    kind: "COACHING",
    bookingTypeId: bookingType.id,
    title: "Racy coaching",
    slug: slug("offer"),
    accessMode: "FREE",
    seatLimit: 1,
  });

  const results = await Promise.allSettled([
    acquireSlotHold({
      bookingTypeId: bookingType.id,
      startAt: slotAt(14),
      now: NOW,
      ttlMinutes: 30,
      acquisitionKey: generateAcquisitionKey(),
    }),
    acquireSlotHold({
      bookingTypeId: bookingType.id,
      startAt: slotAt(15),
      now: NOW,
      ttlMinutes: 30,
      acquisitionKey: generateAcquisitionKey(),
    }),
  ]);
  const won = results.filter(
    (r) => r.status === "fulfilled" && r.value.success,
  );
  assert.equal(won.length, 1);
  const lostCount = results.length - won.length;
  assert.equal(lostCount, 1);
});

test("LIMITS: closed offer refuses holds, bookings and checkout", async () => {
  const bookingType = await makeBookingType();
  const offer = await createOffer({
    kind: "COACHING",
    bookingTypeId: bookingType.id,
    title: "Closed coaching",
    slug: slug("offer"),
    accessMode: "FREE",
    closesAt: PAST,
  });
  const availability = await getAvailabilityForOffer(offer, NOW);
  assert.equal(availability.state, "closed");

  await assert.rejects(
    () =>
      acquireSlotHold({
        bookingTypeId: bookingType.id,
        startAt: slotAt(9),
        now: NOW,
        ttlMinutes: 30,
        acquisitionKey: generateAcquisitionKey(),
      }),
    (error: unknown) => {
      assert.ok(isAppError(error));
      assert.equal(error.kind, "conflict");
      assert.match(error.message, /closed/);
      return true;
    },
  );

  // Live scheduler reports closed instead of slots.
  const model = await resolvePublicSchedulingModel({
    offerSlug: offer.slug,
    kind: "COACHING",
    now: NOW,
  });
  assert.equal(model.enabled, false);
  if (!model.enabled) assert.equal(model.reason, "OFFER_CLOSED");

  // Public submit fails fast with the enquiry fallback.
  const form = new FormData();
  form.set("offerSlug", offer.slug);
  form.set("offerKind", "COACHING");
  form.set("bookingTypeId", bookingType.id);
  form.set("startAt", slotAt(9).toISOString());
  form.set("requestKey", crypto.randomUUID());
  form.set("acquisitionKey", crypto.randomUUID());
  form.set("requesterName", "Closed Booker");
  form.set("requesterEmail", "closed-booker@example.com");
  form.set("requesterPhone", "");
  form.set("notes", "");
  form.set("privacyAcknowledged", "on");
  form.set("website", "");
  const result = await submitPublicBooking(undefined, form);
  assert.ok(result && !result.ok);
  assert.equal(result.code, "UNAVAILABLE");
  assert.match(result.message, /closed/);
});

test("LIMITS: sold-out offer disables the live scheduler", async () => {
  const bookingType = await makeBookingType();
  const offer = await createOffer({
    kind: "COACHING",
    bookingTypeId: bookingType.id,
    title: "Full coaching",
    slug: slug("offer"),
    accessMode: "FREE",
    seatLimit: 1,
  });
  await bookSlot(bookingType.id, slotAt(14), "full");

  const model = await resolvePublicSchedulingModel({
    offerSlug: offer.slug,
    kind: "COACHING",
    now: NOW,
  });
  assert.equal(model.enabled, false);
  if (!model.enabled) assert.equal(model.reason, "OFFER_SOLD_OUT");
});

test("LIMITS: dormant checkout refuses sold out and closed with conflict", async () => {
  const offer = await createOffer({
    kind: "PRODUCT",
    title: "Limited print",
    slug: slug("offer"),
    accessMode: "PAID_ONE_TIME",
    currency: "USD",
    amountMinor: 2500,
    seatLimit: 2,
  });

  const first = await createOrder({
    offerId: offer.id,
    requestKey: crypto.randomUUID(),
    customerEmail: "buyer-one@example.com",
    now: NOW,
  });
  assert.equal(first.status, "PENDING");
  const mid = await getOfferAvailability(offer.id, NOW);
  assert.equal(mid.seatsTaken, 1);
  assert.equal(mid.seatsLeft, 1);

  await createOrder({
    offerId: offer.id,
    requestKey: crypto.randomUUID(),
    customerEmail: "buyer-two@example.com",
    now: NOW,
  });
  const full = await getOfferAvailability(offer.id, NOW);
  assert.equal(full.state, "sold_out");

  await assert.rejects(
    () =>
      createOrder({
        offerId: offer.id,
        requestKey: crypto.randomUUID(),
        customerEmail: "buyer-three@example.com",
        now: NOW,
      }),
    (error: unknown) => {
      assert.ok(isAppError(error));
      assert.equal(error.kind, "conflict");
      assert.match(error.message, /sold out/);
      return true;
    },
  );

  await updateOffer({ id: offer.id, seatLimit: null, closesAt: PAST });
  await assert.rejects(
    () =>
      createOrder({
        offerId: offer.id,
        requestKey: crypto.randomUUID(),
        customerEmail: "buyer-four@example.com",
        now: NOW,
      }),
    (error: unknown) => {
      assert.ok(isAppError(error));
      assert.equal(error.kind, "conflict");
      assert.match(error.message, /closed/);
      return true;
    },
  );
});

test("LIMITS: product seats count order quantity, not order rows", async () => {
  const offer = await createOffer({
    kind: "PRODUCT",
    title: "Bulk seats",
    slug: slug("offer"),
    accessMode: "PAID_ONE_TIME",
    currency: "USD",
    amountMinor: 1000,
    seatLimit: 5,
  });
  await createOrder({
    offerId: offer.id,
    requestKey: crypto.randomUUID(),
    customerEmail: "bulk-one@example.com",
    quantity: 4,
    now: NOW,
  });
  const mid = await getOfferAvailability(offer.id, NOW);
  assert.equal(mid.seatsTaken, 4);
  assert.equal(mid.seatsLeft, 1);
  await assert.rejects(
    () =>
      createOrder({
        offerId: offer.id,
        requestKey: crypto.randomUUID(),
        customerEmail: "bulk-two@example.com",
        quantity: 2,
        now: NOW,
      }),
    (error: unknown) => isAppError(error) && error.kind === "conflict",
  );
  await createOrder({
    offerId: offer.id,
    requestKey: crypto.randomUUID(),
    customerEmail: "bulk-three@example.com",
    quantity: 1,
    now: NOW,
  });
  assert.equal((await getOfferAvailability(offer.id, NOW)).state, "sold_out");
});

test("LIMITS: Studio updates are admin-only and write an audit row", async () => {
  const denied = createCommerceAdminOperations(async () => {
    throw new Error("Unauthorized: sign in required.");
  });
  const blocked = await denied.createOffer({
    kind: "PRODUCT",
    title: "Nope",
    slug: slug("offer"),
    accessMode: "FREE",
  });
  assert.equal(blocked.ok, false);

  const course = await makeCourse();
  const ops = createCommerceAdminOperations(async () => ({ user: { id: "admin-1" } }));
  const created = await ops.createOffer({
    kind: "COURSE",
    courseId: course.id,
    title: "Audited cap",
    slug: slug("offer"),
    accessMode: "FREE",
    seatLimit: 7,
    closesAt: FUTURE.toISOString(),
  });
  assert.equal(created.ok, true);
  if (!created.ok || !created.data) throw new Error("Expected created offer.");
  const offerId = created.data.id;

  const updated = await ops.updateOffer({
    id: offerId,
    seatLimit: 9,
    closesAt: null,
  });
  assert.equal(updated.ok, true);

  const db = await getDb();
  const auditRows = await db
    .select()
    .from(adminAuditLog)
    .where(eq(adminAuditLog.entityId, offerId));
  assert.ok(auditRows.length >= 2);
  const details = auditRows.map((row) => row.details ?? "");
  assert.ok(details.some((detail) => detail.includes("seatLimit")));
});

test("LIMITS: Studio offers list shows seats taken, limit and state", async () => {
  const course = await makeCourse();
  const offer = await createOffer({
    kind: "COURSE",
    courseId: course.id,
    title: "Listed cap",
    slug: slug("offer"),
    accessMode: "FREE",
    seatLimit: 4,
  });
  await enrollFree(await makeUser(), course.id);

  const dashboard = await getCommerceAdminDashboardWithGuard(
    async () => ({ user: { id: "admin-1" } }),
  );
  const listed = dashboard.offers.items.find((item) => item.id === offer.id);
  assert.ok(listed);
  assert.equal(listed.seatLimit, 4);
  assert.equal(listed.seatsTaken, 1);
  assert.equal(listed.seatsLeft, 3);
  assert.equal(listed.limitState, "open");
  assert.equal(listed.closesAt, null);
});
