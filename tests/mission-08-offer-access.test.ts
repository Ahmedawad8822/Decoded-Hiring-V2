/**
 * MISSION 08.3 — Offer / Access Integration
 *
 * Proves:
 * - Offer policy validation and linked-entity integrity
 * - one primary Offer per course / booking type
 * - safe public CTA resolution with no fake checkout
 * - course access hand-off: Offer authoritative when present, Mission 06 fallback otherwise
 * - inactive Offer fails closed
 * - FREE Offer can grant normal Mission 06 enrollment
 * - public product pages consume Offer state without breaking lead-first fallback
 * - migration 0014 identity/drift inputs are present
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
  bookingTypes,
  bookings,
  bookingHistory,
  courseSections,
  courses,
  enrollments,
  lessonProgress,
  lessonResources,
  lessons,
  offers,
  slotHolds,
  users,
  type CourseAccessMode,
} from "@/lib/db";
import { enrollFree, getEnrollment } from "@/features/enrollments/service";
import { updateCourse } from "@/features/courses/service";
import {
  createOffer,
  getEffectiveCourseAccessPolicy,
  getPublicOfferBySlug,
  updateOffer,
} from "@/features/offers/service";
import { createOfferSchema } from "@/features/offers/types";
import { resolveOfferPublicPresentation } from "@/features/offers/presentation";
import { createBookingType } from "@/features/scheduling";

const NOW = new Date("2026-09-26T10:00:00.000Z");
let seq = 0;

function id(prefix: string): string {
  return `${prefix}_${seq++}`;
}

function validSlug(prefix: string): string {
  return `${prefix}-${seq++}`;
}

async function createPublishedCourse(accessMode: CourseAccessMode = "FREE") {
  const db = await getDb();
  const courseId = id("course");
  const slug = validSlug("course");
  await db.insert(courses).values({
    id: courseId,
    title: `Course ${seq}`,
    slug,
    description: "Offer integration test course",
    status: "published",
    accessMode,
    coverImage: null,
    createdAt: NOW,
    updatedAt: NOW,
    publishedAt: NOW,
  });
  return (await db.select().from(courses).where(eq(courses.id, courseId)).get())!;
}

async function createTestUser() {
  const db = await getDb();
  const userId = id("user");
  await db.insert(users).values({
    id: userId,
    name: "Offer Test Learner",
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

test.before(async () => {
  await migrateLocalDb();
  const db = await getDb();

  // Dependency-safe cleanup for this isolated test process.
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

test("OFFER 08.3: course without Offer retains Mission 06 access fallback", async () => {
  const course = await createPublishedCourse("MANUAL_INVOICE");
  const policy = await getEffectiveCourseAccessPolicy(course);
  assert.equal(policy.source, "LEGACY_COURSE");
  assert.equal(policy.mode, "MANUAL_INVOICE");
  assert.equal(policy.available, true);
  assert.equal(policy.offer, null);
});

test("OFFER 08.3: linked Offer becomes authoritative over legacy course mode", async () => {
  const course = await createPublishedCourse("FREE");
  const offer = await createOffer({
    kind: "COURSE",
    courseId: course.id,
    title: "Paid course offer",
    slug: validSlug("offer"),
    accessMode: "PAID_ONE_TIME",
    currency: "USD",
    amountMinor: 9900,
    alternativeCtaLabel: "Ask about access",
    alternativeCtaUrl: "/contact?reason=course",
  });

  const policy = await getEffectiveCourseAccessPolicy(course);
  assert.equal(policy.source, "OFFER");
  assert.equal(policy.mode, "PAID_ONE_TIME");
  assert.equal(policy.available, true);
  assert.equal(policy.offer?.id, offer.id);
});

test("OFFER 08.3: paid Offer blocks FREE enrollment even when legacy course says FREE", async () => {
  const course = await createPublishedCourse("FREE");
  const userId = await createTestUser();
  await createOffer({
    kind: "COURSE",
    courseId: course.id,
    title: "Paid override",
    slug: validSlug("offer"),
    accessMode: "PAID_ONE_TIME",
    currency: "USD",
    amountMinor: 4900,
  });

  await assert.rejects(
    enrollFree(userId, course.id),
    /requires a one-time payment/i,
  );
  assert.equal(await getEnrollment(userId, course.id), null);
});

test("OFFER 08.3: FREE Offer can open enrollment for legacy paid course", async () => {
  const course = await createPublishedCourse("PAID_ONE_TIME");
  const userId = await createTestUser();
  await createOffer({
    kind: "COURSE",
    courseId: course.id,
    title: "Free launch offer",
    slug: validSlug("offer"),
    accessMode: "FREE",
  });

  const enrollment = await enrollFree(userId, course.id);
  assert.equal(enrollment.userId, userId);
  assert.equal(enrollment.courseId, course.id);
  assert.equal(enrollment.accessSource, "free");
});

test("OFFER 08.3: inactive linked Offer fails closed instead of falling back", async () => {
  const course = await createPublishedCourse("FREE");
  const userId = await createTestUser();
  const offer = await createOffer({
    kind: "COURSE",
    courseId: course.id,
    title: "Paused offer",
    slug: validSlug("offer"),
    accessMode: "FREE",
    active: false,
  });

  const policy = await getEffectiveCourseAccessPolicy(course);
  assert.equal(policy.source, "OFFER");
  assert.equal(policy.available, false);

  await assert.rejects(enrollFree(userId, course.id), /currently unavailable/i);
  assert.equal(await getPublicOfferBySlug(offer.slug), null);
});

test("OFFER 08.3: one course cannot acquire two primary Offers", async () => {
  const course = await createPublishedCourse();
  await createOffer({
    kind: "COURSE",
    courseId: course.id,
    title: "First offer",
    slug: validSlug("offer"),
    accessMode: "FREE",
  });

  await assert.rejects(
    createOffer({
      kind: "COURSE",
      courseId: course.id,
      title: "Second offer",
      slug: validSlug("offer"),
      accessMode: "FREE",
    }),
    /already has a primary offer/i,
  );

  const db = await getDb();
  const rows = await db.select().from(offers).where(eq(offers.courseId, course.id)).all();
  assert.equal(rows.length, 1);
});

test("OFFER 08.3: booking type also has one primary Offer backstop", async () => {
  const bookingType = await createBookingType({
    slug: validSlug("booking-type"),
    title: "Coaching slot",
    durationMinutes: 60,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    minimumNoticeMinutes: 0,
    bookingHorizonDays: 30,
    timezone: "Africa/Cairo",
    confirmationPolicy: "AHMED_APPROVAL",
    accessMode: "PAYMENT_DISABLED",
    meetingMethod: "TO_BE_CONFIRMED",
    attendeeLimit: 1,
  });

  await createOffer({
    kind: "COACHING",
    bookingTypeId: bookingType.id,
    title: "Coaching offer",
    slug: validSlug("offer"),
    accessMode: "PAYMENT_DISABLED",
    alternativeCtaLabel: "Send a decision brief",
    alternativeCtaUrl: "#hg-coaching-brief",
  });

  await assert.rejects(
    createOffer({
      kind: "COACHING",
      bookingTypeId: bookingType.id,
      title: "Duplicate coaching offer",
      slug: validSlug("offer"),
      accessMode: "PAYMENT_DISABLED",
      alternativeCtaLabel: "Contact",
      alternativeCtaUrl: "/contact",
    }),
    /already has a primary offer/i,
  );
});

test("OFFER 08.3: COURSE cannot use PAID_SESSION", async () => {
  const course = await createPublishedCourse();
  await assert.rejects(
    createOffer({
      kind: "COURSE",
      courseId: course.id,
      title: "Invalid session course",
      slug: validSlug("offer"),
      accessMode: "PAID_SESSION",
      currency: "USD",
      amountMinor: 1000,
    }),
    /cannot use PAID_SESSION/i,
  );
});

test("OFFER 08.3: provider-paid modes require price + currency", async () => {
  const course = await createPublishedCourse();
  await assert.rejects(
    createOffer({
      kind: "COURSE",
      courseId: course.id,
      title: "Unpriced paid offer",
      slug: validSlug("offer"),
      accessMode: "PAID_ONE_TIME",
    }),
    /require a currency and a positive amountMinor/i,
  );
});

test("OFFER 08.3: disabled/coming-soon modes require a usable alternative CTA", async () => {
  await assert.rejects(
    createOffer({
      kind: "PRODUCT",
      title: "Disabled product",
      slug: validSlug("offer"),
      accessMode: "PAYMENT_DISABLED",
    }),
    /require an alternative CTA/i,
  );

  assert.equal(
    createOfferSchema.safeParse({
      kind: "PRODUCT",
      title: "Unsafe CTA",
      slug: validSlug("offer"),
      accessMode: "COMING_SOON",
      alternativeCtaLabel: "Join",
      alternativeCtaUrl: "javascript:alert(1)",
    }).success,
    false,
  );
});

test("OFFER 08.3: paid presentation fails closed to alternative/contact, never checkout", async () => {
  const course = await createPublishedCourse();
  const paid = await createOffer({
    kind: "COURSE",
    courseId: course.id,
    title: "Paid offer",
    slug: validSlug("offer"),
    accessMode: "PAID_ONE_TIME",
    currency: "USD",
    amountMinor: 12500,
  });

  const presentation = resolveOfferPublicPresentation(paid, {
    freeHref: "/login",
    contactHref: "/contact?reason=paid-course",
  });

  assert.equal(presentation.action, "CONTACT");
  assert.equal(presentation.ctaHref, "/contact?reason=paid-course");
  assert.equal(presentation.ctaLabel, "Contact us");
  assert.match(presentation.badge, /\$125|USD/i);
  assert.equal(JSON.stringify(presentation).toLowerCase().includes("checkout"), false);
});

test("OFFER 08.3: price formatting respects zero-decimal currencies", async () => {
  const offer = await createOffer({
    kind: "PRODUCT",
    title: "JPY product",
    slug: validSlug("offer"),
    accessMode: "PAID_ONE_TIME",
    currency: "JPY",
    amountMinor: 12500,
  });

  const presentation = resolveOfferPublicPresentation(offer, {
    freeHref: "/login",
  });
  assert.match(presentation.badge.replace(/\s/g, ""), /12,500|12500/);
});

test("OFFER 08.3: PAYMENT_DISABLED presentation uses configured alternative path", async () => {
  const offer = await createOffer({
    kind: "PRODUCT",
    title: "Waitlisted product",
    slug: validSlug("offer"),
    accessMode: "PAYMENT_DISABLED",
    alternativeCtaLabel: "Join the list",
    alternativeCtaUrl: "/ai-recruiter-os",
  });

  const presentation = resolveOfferPublicPresentation(offer, {
    freeHref: "/login",
  });
  assert.equal(presentation.action, "ALTERNATIVE");
  assert.equal(presentation.ctaLabel, "Join the list");
  assert.equal(presentation.ctaHref, "/ai-recruiter-os");
});

test("OFFER 08.3: linked Offer blocks legacy course access-mode drift at service boundary", async () => {
  const course = await createPublishedCourse("FREE");
  await createOffer({
    kind: "COURSE",
    courseId: course.id,
    title: "Authoritative offer",
    slug: validSlug("offer"),
    accessMode: "FREE",
  });

  await assert.rejects(
    updateCourse(course.id, { id: course.id, accessMode: "PAID_ONE_TIME" }),
    /access is owned by linked Offer/i,
  );

  const db = await getDb();
  const stored = await db.select().from(courses).where(eq(courses.id, course.id)).get();
  assert.equal(stored?.accessMode, "FREE");
});

test("OFFER 08.3: updating a linked Offer changes effective access without mutating legacy course field", async () => {
  const course = await createPublishedCourse("FREE");
  const offer = await createOffer({
    kind: "COURSE",
    courseId: course.id,
    title: "Launch offer",
    slug: validSlug("offer"),
    accessMode: "FREE",
  });

  await updateOffer({
    id: offer.id,
    accessMode: "COMING_SOON",
    alternativeCtaLabel: "Join waitlist",
    alternativeCtaUrl: "/contact?reason=waitlist",
  });

  const db = await getDb();
  const storedCourse = await db.select().from(courses).where(eq(courses.id, course.id)).get();
  assert.equal(storedCourse?.accessMode, "FREE", "legacy field remains a compatibility fallback only");

  const policy = await getEffectiveCourseAccessPolicy(course);
  assert.equal(policy.mode, "COMING_SOON");
});

test("OFFER 08.3: inactive Offer presentation exposes no CTA or price", async () => {
  const offer = await createOffer({
    kind: "PRODUCT",
    title: "Inactive priced product",
    slug: validSlug("offer"),
    accessMode: "PAID_ONE_TIME",
    currency: "USD",
    amountMinor: 5000,
    active: false,
  });

  const presentation = resolveOfferPublicPresentation(offer, {
    freeHref: "/login",
  });
  assert.equal(presentation.action, "UNAVAILABLE");
  assert.equal(presentation.ctaHref, null);
  assert.equal(presentation.ctaLabel, null);
  assert.equal(presentation.priceLabel, null);
});

test("OFFER 08.3: public product pages are wired to Offer lookup with safe fallback", async () => {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");

  const mission01 = readFileSync(
    join(process.cwd(), "src", "app", "(site)", "mission-01", "page.tsx"),
    "utf8",
  );
  const coaching = readFileSync(
    join(process.cwd(), "src", "app", "(site)", "coaching", "page.tsx"),
    "utf8",
  );
  const workshop = readFileSync(
    join(process.cwd(), "src", "app", "(site)", "workshop", "page.tsx"),
    "utf8",
  );
  const coursePage = readFileSync(
    join(process.cwd(), "src", "app", "learn", "courses", "[courseSlug]", "page.tsx"),
    "utf8",
  );

  assert.ok(mission01.includes("PUBLIC_OFFER_SLUGS.mission01"));
  assert.ok(mission01.includes('"COURSE"'));
  assert.ok(coaching.includes('getOfferBySlugForKind(PUBLIC_OFFER_SLUGS.coaching, "COACHING")'));
  assert.ok(workshop.includes('getOfferBySlugForKind(PUBLIC_OFFER_SLUGS.workshop, "WORKSHOP")'));
  assert.ok(coursePage.includes("getEffectiveCourseAccessPolicy(course)"));
  assert.ok(coursePage.includes("resolveOfferPublicPresentation"));
});

test("OFFER 08.3: migration journal/snapshot include unique 0014 Offer identity", async () => {
  const { existsSync, readFileSync } = await import("node:fs");
  const { join } = await import("node:path");

  const journal = JSON.parse(
    readFileSync(join(process.cwd(), "drizzle", "migrations", "meta", "_journal.json"), "utf8"),
  );
  const tags = journal.entries.map((entry: { tag: string }) => entry.tag);
  assert.equal(tags.filter((tag: string) => tag.startsWith("0014_")).length, 1);
  assert.ok(tags.includes("0014_offer_access"));
  assert.ok(
    existsSync(join(process.cwd(), "drizzle", "migrations", "meta", "0014_snapshot.json")),
  );
});
