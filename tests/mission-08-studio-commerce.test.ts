/**
 * MISSION 08.7 — Studio Scheduling / Commerce Control Plane
 *
 * Proves:
 * - booking-type configuration can be edited without replacing domain identity
 * - availability windows have explicit admin removal semantics
 * - Studio write actions fail closed without an authenticated admin session
 * - the aggregate admin read model is auth-gated
 * - Studio navigation exposes the control plane and no provider activation action
 */

import "./helpers/env";

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { eq } from "drizzle-orm";

import { disposeCloudflareBindings } from "../src/lib/cloudflare/bindings";
import { getDb, bookingTypes } from "../src/lib/db";
import { createOffer } from "@/features/offers/service";
import { deleteAvailabilityWindow } from "@/features/scheduling/policy";
import { migrateLocalDb } from "../src/lib/db/migrate";
import {
  createAvailabilityWindow,
  createBookingType,
  getActiveBookingType,
  getBookingTypeById,
  getBookingTypeWindows,
  updateBookingType,
} from "@/features/scheduling";
import { createBookingTypeAdminAction } from "@/features/commerce/admin-actions";
import { getCommerceAdminDashboard } from "@/features/commerce/admin";

const NOW_SLUG = `studio-commerce-${Date.now().toString(36)}`;

test.before(async () => {
  await migrateLocalDb();
});

test.after(async () => {
  await disposeCloudflareBindings();
});

test("STUDIO 08.7: booking type configuration updates in place and can fail closed", async () => {
  const created = await createBookingType({
    slug: NOW_SLUG,
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

test("STUDIO 08.7: linked Offer owns booking access mode", async () => {
  const bookingType = await createBookingType({
    slug: `${NOW_SLUG}-offer-owned`,
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
    slug: `${NOW_SLUG}-offer`,
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

test("STUDIO 08.7: availability window removal targets one exact row", async () => {
  const bookingType = await createBookingType({
    slug: `${NOW_SLUG}-windows`,
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

test("STUDIO 08.7: server action cannot create booking policy without admin auth", async () => {
  const slug = `${NOW_SLUG}-blocked`;
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

test("STUDIO 08.7: Studio surface is discoverable and cannot activate providers", () => {
  const shell = readFileSync("src/app/admin/studio-shell.tsx", "utf8");
  const page = readFileSync("src/app/admin/commerce/commerce-client.tsx", "utf8");
  const actions = readFileSync("src/features/commerce/admin-actions.ts", "utf8");

  assert.match(shell, /\/admin\/commerce/);
  assert.match(shell, /Scheduling & Commerce/);
  assert.match(page, /Provider readiness/);
  assert.match(page, /Requests & approval queue/);
  assert.match(page, /Orders & payment truth/);
  assert.match(page, /Audit history/);
  assert.match(actions, /requireAdmin/);

  assert.doesNotMatch(actions, /activateProvider|setProviderSecret|saveCredential/i);
  assert.doesNotMatch(page, /Activate provider|Save secret|API key/i);
});
