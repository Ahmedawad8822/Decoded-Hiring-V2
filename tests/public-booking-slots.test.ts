/**
 * perf/cached-booking-pages — GET /api/public/booking-slots
 *
 * The /coaching and /workshop pages are cached shells; live slots come from
 * this route handler (src/features/scheduling/public-slots-handler.ts).
 */

import "./helpers/env";

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { disposeCloudflareBindings } from "../src/lib/cloudflare/bindings";
import { getDb } from "../src/lib/db";
import { migrateLocalDb } from "../src/lib/db/migrate";
import {
  bookingAvailabilityWindows,
  bookingHistory,
  bookings,
  bookingTypes,
  offers,
  publicRateLimits,
  slotHolds,
  businessEvents,
} from "@/lib/db";
import { createOffer, updateOffer } from "@/features/offers/service";
import {
  acquireSlotHold,
  createAvailabilityWindow,
  createBookingType,
} from "@/features/scheduling";
import {
  handlePublicBookingSlotsRequest,
  type PublicBookingSlotsResponse,
} from "@/features/scheduling/public-slots-handler";
import { submitPublicBooking } from "@/features/scheduling/public-actions";

const NOW = new Date("2026-10-27T12:00:00.000Z");

function req(query: string): Request {
  return new Request("http://localhost/api/public/booking-slots" + query);
}

async function call(query: string, now: Date = NOW) {
  const response = await handlePublicBookingSlotsRequest(req(query), { now });
  return { response, body: (await response.json()) as unknown };
}

async function setup(params: {
  slug: "coaching" | "workshop";
  confirmationPolicy?: "AUTO_CONFIRM" | "AHMED_APPROVAL";
}) {
  const bookingType = await createBookingType({
    slug: params.slug + "-booking",
    title: "Slots Route Booking",
    description: "Slots route regression",
    durationMinutes: 60,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    minimumNoticeMinutes: 0,
    bookingHorizonDays: 30,
    timezone: "UTC",
    confirmationPolicy: params.confirmationPolicy ?? "AUTO_CONFIRM",
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
  const offer = await createOffer({
    kind: params.slug === "coaching" ? "COACHING" : "WORKSHOP",
    bookingTypeId: bookingType.id,
    title: "Slots Route Offer",
    slug: params.slug,
    accessMode: "FREE",
  });
  return { bookingType, offer };
}

async function resetTables() {
  const db = await getDb();
  await db.delete(businessEvents).run();
  await db.delete(publicRateLimits).run();
  await db.delete(bookingHistory).run();
  await db.delete(bookings).run();
  await db.delete(offers).run();
  await db.delete(slotHolds).run();
  await db.delete(bookingAvailabilityWindows).run();
  await db.delete(bookingTypes).run();
}

test.before(async () => {
  await migrateLocalDb();
  await resetTables();
});

test.after(async () => {
  await disposeCloudflareBindings();
});

test("SLOTS ROUTE: validates the offer query with zod and never caches", async () => {
  for (const query of [
    "",
    "?offer=",
    "?offer=unknown-offer",
    "?offer=mission-01",
    "?offer=__proto__",
    "?offer=" + "x".repeat(500),
  ]) {
    const { response, body } = await call(query);
    assert.equal(response.status, 400, query);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.ok((body as { error?: string }).error);
  }
});

test("SLOTS ROUTE: returns minimal slot JSON, no-store, and reads only", async () => {
  await resetTables();
  const { bookingType } = await setup({ slug: "coaching" });
  const db = await getDb();
  const rateRowsBefore = (await db.select().from(publicRateLimits)).length;
  const eventsBefore = (await db.select().from(businessEvents)).length;

  const { response, body } = await call("?offer=coaching");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");

  const data = body as Extract<PublicBookingSlotsResponse, { enabled: true }>;
  assert.equal(data.enabled, true);
  assert.equal(data.offerSlug, "coaching");
  assert.equal(data.bookingTypeId, bookingType.id);
  assert.ok(data.slots.length > 0 && data.slots.length <= 60);
  assert.deepEqual(Object.keys(data.slots[0]).sort(), [
    "endAt",
    "slotKey",
    "startAt",
  ]);
  assert.deepEqual(Object.keys(data).sort(), [
    "bookingTypeId",
    "enabled",
    "offerSlug",
    "rangeEnd",
    "slots",
  ]);

  // GET is read-only: no rate-limit counters, no events, no holds.
  assert.equal(
    (await db.select().from(publicRateLimits)).length,
    rateRowsBefore,
  );
  assert.equal((await db.select().from(businessEvents)).length, eventsBefore);
  assert.equal((await db.select().from(slotHolds)).length, 0);
});

test("SLOTS ROUTE: held slots disappear from the live list", async () => {
  await resetTables();
  const { bookingType } = await setup({ slug: "coaching" });
  const first = (
    (await call("?offer=coaching")).body as Extract<
      PublicBookingSlotsResponse,
      { enabled: true }
    >
  ).slots[0];

  const acquisition = await acquireSlotHold({
    bookingTypeId: bookingType.id,
    startAt: new Date(first.startAt),
    now: NOW,
    ttlMinutes: 5,
    acquisitionKey: crypto.randomUUID(),
  });
  assert.equal(acquisition.success, true);

  const after = (await call("?offer=coaching")).body as Extract<
    PublicBookingSlotsResponse,
    { enabled: true }
  >;
  assert.equal(
    after.slots.some((slot) => slot.startAt === first.startAt),
    false,
  );
});

test("SLOTS ROUTE: disabled states mirror the server-rendered reasons", async () => {
  await resetTables();
  // No offer at all.
  let result = await call("?offer=workshop");
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.body, { enabled: false, reason: "OFFER_MISSING" });

  // Approval-required booking type stays lead-first.
  await setup({ slug: "workshop", confirmationPolicy: "AHMED_APPROVAL" });
  result = await call("?offer=workshop");
  assert.deepEqual(result.body, {
    enabled: false,
    reason: "APPROVAL_REQUIRED",
  });

  // Deactivated offer.
  await resetTables();
  const { offer } = await setup({ slug: "coaching" });
  await updateOffer({ id: offer.id, active: false });
  result = await call("?offer=coaching");
  assert.deepEqual(result.body, { enabled: false, reason: "OFFER_INACTIVE" });
});

test("SLOTS ROUTE: submit path still re-validates the slot server-side", async () => {
  await resetTables();
  const { bookingType } = await setup({ slug: "coaching" });
  const form = new FormData();
  form.set("offerSlug", "coaching");
  form.set("offerKind", "COACHING");
  form.set("bookingTypeId", bookingType.id);
  // A time that was never offered by the route.
  form.set("startAt", "2026-01-01T03:17:00.000Z");
  form.set("requestKey", crypto.randomUUID());
  form.set("acquisitionKey", crypto.randomUUID());
  form.set("requesterName", "Route Tester");
  form.set("requesterEmail", "route-tester@example.com");
  form.set("requesterPhone", "");
  form.set("notes", "");
  form.set("privacyAcknowledged", "on");
  form.set("website", "");
  const result = await submitPublicBooking(undefined, form);
  assert.ok(result && !result.ok && result.code === "SLOT_UNAVAILABLE");
});

test("SLOTS ROUTE: pages are cached shells and the route is wired", () => {
  const read = (...parts: string[]) =>
    readFileSync(join(process.cwd(), ...parts), "utf8");
  for (const page of ["coaching", "workshop"]) {
    const source = read("src", "app", "(site)", page, "page.tsx");
    assert.equal(source.includes('"force-dynamic"'), false, page);
    assert.ok(source.includes("export const revalidate"), page);
    assert.equal(source.includes("resolvePublicSchedulingModel"), false, page);
    assert.ok(source.includes("resolvePublicSchedulingConfig"), page);
  }
  const route = read("src", "app", "api", "public", "booking-slots", "route.ts");
  assert.ok(route.includes("handlePublicBookingSlotsRequest"));
  const scheduler = read("src", "components", "products", "public-scheduler.tsx");
  assert.ok(scheduler.includes("/api/public/booking-slots"));
  assert.ok(scheduler.includes("recordPublicBookingStarted"));
});
