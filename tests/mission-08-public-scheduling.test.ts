/**
 * MISSION 08.6 — Public coaching/workshop scheduling UX
 */

import "./helpers/env";

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
  offers,
  orchestrationEffects,
  orchestrationHistory,
  orderHistory,
  orders,
  paymentEvents,
  publicRateLimits,
  slotHolds,
} from "@/lib/db";
import { createOffer } from "@/features/offers/service";
import {
  acquireSlotHold,
  createAvailabilityWindow,
  createBookingType,
  UnconfiguredMailboxProvider,
  UnconfiguredMeetingProvider,
  UnconfiguredPaymentGateway,
  type CalendarProvider,
  type CommerceSchedulingProviders,
} from "@/features/scheduling";
import {
  resolvePublicSchedulingModel,
  type PublicSchedulingKind,
} from "@/features/scheduling/public-scheduling";
import { submitPublicBooking } from "@/features/scheduling/public-actions";
import { consumePublicFixedWindowLimit } from "@/features/public-intake/rate-limit";

const FIXED_NOW = new Date("2026-10-27T12:00:00.000Z");
let seq = 0;

function slug(prefix: string): string {
  return prefix + "-" + seq++;
}

async function setupOffer(params: {
  kind?: PublicSchedulingKind;
  accessMode?: "FREE" | "PAID_SESSION" | "MANUAL_INVOICE" | "PAYMENT_DISABLED";
  confirmationPolicy?: "AUTO_CONFIRM" | "AHMED_APPROVAL" | "REQUEST_ONLY";
  realtime?: boolean;
}) {
  const now = params.realtime ? new Date() : FIXED_NOW;
  const weekday = now.getUTCDay();
  const bookingType = await createBookingType({
    slug: slug("public-booking"),
    title: "Public Booking",
    description: "Public scheduling regression",
    durationMinutes: 60,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    minimumNoticeMinutes: 0,
    bookingHorizonDays: 30,
    timezone: "UTC",
    confirmationPolicy: params.confirmationPolicy ?? "AUTO_CONFIRM",
    accessMode:
      params.accessMode === "PAID_SESSION"
        ? "PAID_SESSION"
        : params.accessMode === "MANUAL_INVOICE"
          ? "MANUAL_INVOICE"
          : params.accessMode === "PAYMENT_DISABLED"
            ? "PAYMENT_DISABLED"
            : "FREE",
    meetingMethod: "TO_BE_CONFIRMED",
    attendeeLimit: 1,
  });
  await createAvailabilityWindow({
    bookingTypeId: bookingType.id,
    weekday,
    startMinute: 0,
    endMinute: 1440,
  });

  const accessMode = params.accessMode ?? "FREE";
  const offer = await createOffer({
    kind: params.kind ?? "COACHING",
    bookingTypeId: bookingType.id,
    title: "Public Offer",
    slug: slug("public-offer"),
    accessMode,
    currency: accessMode === "PAID_SESSION" ? "USD" : null,
    amountMinor: accessMode === "PAID_SESSION" ? 10000 : null,
    alternativeCtaLabel:
      accessMode === "PAYMENT_DISABLED" ? "Contact Ahmed" : null,
    alternativeCtaUrl:
      accessMode === "PAYMENT_DISABLED" ? "/contact" : null,
  });

  return { bookingType, offer, now };
}

function bookingForm(params: {
  offerSlug: string;
  bookingTypeId: string;
  startAt: string;
  requestKey?: string;
  acquisitionKey?: string;
  email?: string;
  name?: string;
}) {
  const form = new FormData();
  form.set("offerSlug", params.offerSlug);
  form.set("offerKind", "COACHING");
  form.set("bookingTypeId", params.bookingTypeId);
  form.set("startAt", params.startAt);
  form.set("requestKey", params.requestKey ?? crypto.randomUUID());
  form.set("acquisitionKey", params.acquisitionKey ?? crypto.randomUUID());
  form.set("requesterName", params.name ?? "Public Booker");
  form.set("requesterEmail", params.email ?? "public-booker@example.com");
  form.set("requesterPhone", "");
  form.set("notes", "Need clarity on one hiring decision.");
  form.set("privacyAcknowledged", "on");
  form.set("website", "");
  return form;
}

test.before(async () => {
  await migrateLocalDb();
  const db = await getDb();
  await db.delete(orchestrationHistory).run();
  await db.delete(orchestrationEffects).run();
  await db.delete(paymentEvents).run();
  await db.delete(orderHistory).run();
  await db.delete(orders).run();
  await db.delete(publicRateLimits).run();
  await db.delete(bookingHistory).run();
  await db.delete(bookings).run();
  await db.delete(offers).run();
  await db.delete(slotHolds).run();
  await db.delete(bookingAvailabilityWindows).run();
  await db.delete(bookingTypes).run();
});

test.after(async () => {
  await disposeCloudflareBindings();
});

test("PUBLIC 08.6: FREE + AUTO_CONFIRM exposes a truthful scheduler", async () => {
  const setup = await setupOffer({});
  const model = await resolvePublicSchedulingModel({
    offerSlug: setup.offer.slug,
    kind: "COACHING",
    now: FIXED_NOW,
    rangeDays: 7,
  });

  assert.equal(model.enabled, true);
  if (!model.enabled) return;
  assert.equal(model.bookingTypeId, setup.bookingType.id);
  assert.equal(model.accessMode, "FREE");
  assert.equal(model.confirmationPolicy, "AUTO_CONFIRM");
  assert.ok(model.slots.length > 0);
});

test("PUBLIC 08.6: public slot projection is bounded for pathological availability", async () => {
  const bookingType = await createBookingType({
    slug: slug("dense-public-booking"),
    title: "Dense Public Booking",
    description: "Projection bound regression",
    durationMinutes: 1,
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
    weekday: FIXED_NOW.getUTCDay(),
    startMinute: 0,
    endMinute: 1440,
  });
  const offer = await createOffer({
    kind: "COACHING",
    bookingTypeId: bookingType.id,
    title: "Dense Public Offer",
    slug: slug("dense-public-offer"),
    accessMode: "FREE",
  });

  const model = await resolvePublicSchedulingModel({
    offerSlug: offer.slug,
    kind: "COACHING",
    now: FIXED_NOW,
    rangeDays: 7,
  });
  assert.equal(model.enabled, true);
  if (!model.enabled) return;
  assert.equal(model.slots.length, 60);
});

test("PUBLIC 08.6: paid/manual Offer never renders self-service scheduling", async () => {
  const paid = await setupOffer({ accessMode: "PAID_SESSION" });
  const model = await resolvePublicSchedulingModel({
    offerSlug: paid.offer.slug,
    kind: "COACHING",
    now: FIXED_NOW,
  });
  assert.deepEqual(model, { enabled: false, reason: "PAID_OR_MANUAL" });
});

test("PUBLIC 08.6: approval/request-only policies stay lead-first", async () => {
  const approval = await setupOffer({ confirmationPolicy: "AHMED_APPROVAL" });
  const requestOnly = await setupOffer({ confirmationPolicy: "REQUEST_ONLY" });

  const [approvalModel, requestModel] = await Promise.all([
    resolvePublicSchedulingModel({
      offerSlug: approval.offer.slug,
      kind: "COACHING",
      now: FIXED_NOW,
    }),
    resolvePublicSchedulingModel({
      offerSlug: requestOnly.offer.slug,
      kind: "COACHING",
      now: FIXED_NOW,
    }),
  ]);

  assert.deepEqual(approvalModel, {
    enabled: false,
    reason: "APPROVAL_REQUIRED",
  });
  assert.deepEqual(requestModel, { enabled: false, reason: "REQUEST_ONLY" });
});

test("PUBLIC 08.6: unexpired holds disappear from public availability", async () => {
  const setup = await setupOffer({});
  const before = await resolvePublicSchedulingModel({
    offerSlug: setup.offer.slug,
    kind: "COACHING",
    now: FIXED_NOW,
    rangeDays: 7,
  });
  assert.equal(before.enabled, true);
  if (!before.enabled) return;
  const chosen = before.slots[0];
  assert.ok(chosen);

  const hold = await acquireSlotHold({
    bookingTypeId: setup.bookingType.id,
    startAt: new Date(chosen.startAt),
    now: FIXED_NOW,
    ttlMinutes: 10,
  });
  assert.equal(hold.success, true);

  const after = await resolvePublicSchedulingModel({
    offerSlug: setup.offer.slug,
    kind: "COACHING",
    now: FIXED_NOW,
    rangeDays: 7,
  });
  assert.equal(after.enabled, true);
  if (!after.enabled) return;
  assert.equal(after.slots.some((slot) => slot.startAt === chosen.startAt), false);
});

test("PUBLIC 08.6: configured calendar busy input filters overlapping slots", async () => {
  const setup = await setupOffer({});
  const baseline = await resolvePublicSchedulingModel({
    offerSlug: setup.offer.slug,
    kind: "COACHING",
    now: FIXED_NOW,
    rangeDays: 7,
  });
  assert.equal(baseline.enabled, true);
  if (!baseline.enabled) return;
  const chosen = baseline.slots[0];
  assert.ok(chosen);

  const calendar: CalendarProvider = {
    getStatus: async () => ({
      kind: "calendar",
      provider: "test-calendar",
      configured: true,
      capabilities: ["free_busy"],
    }),
    getFreeBusy: async () => [
      {
        startAt: new Date(chosen.startAt),
        endAt: new Date(chosen.endAt),
        busy: true,
      },
    ],
    createEvent: async () => {
      throw new Error("not used");
    },
    updateEvent: async () => {
      throw new Error("not used");
    },
    cancelEvent: async () => {
      throw new Error("not used");
    },
  };
  const providers: CommerceSchedulingProviders = {
    payment: UnconfiguredPaymentGateway,
    calendar,
    mailbox: UnconfiguredMailboxProvider,
    meeting: UnconfiguredMeetingProvider,
  };

  const filtered = await resolvePublicSchedulingModel({
    offerSlug: setup.offer.slug,
    kind: "COACHING",
    now: FIXED_NOW,
    rangeDays: 7,
    providers,
  });
  assert.equal(filtered.enabled, true);
  if (!filtered.enabled) return;
  assert.equal(
    filtered.slots.some((slot) => slot.startAt === chosen.startAt),
    false,
  );
});

test("PUBLIC 08.6: configured calendar outage fails scheduling closed without crashing", async () => {
  const setup = await setupOffer({});
  const calendar: CalendarProvider = {
    getStatus: async () => ({
      kind: "calendar",
      provider: "test-calendar",
      configured: true,
      capabilities: ["free_busy"],
    }),
    getFreeBusy: async () => {
      throw new Error("provider unavailable");
    },
    createEvent: async () => {
      throw new Error("not used");
    },
    updateEvent: async () => {
      throw new Error("not used");
    },
    cancelEvent: async () => {
      throw new Error("not used");
    },
  };
  const providers: CommerceSchedulingProviders = {
    payment: UnconfiguredPaymentGateway,
    calendar,
    mailbox: UnconfiguredMailboxProvider,
    meeting: UnconfiguredMeetingProvider,
  };

  const model = await resolvePublicSchedulingModel({
    offerSlug: setup.offer.slug,
    kind: "COACHING",
    now: FIXED_NOW,
    rangeDays: 7,
    providers,
  });

  assert.deepEqual(model, {
    enabled: false,
    reason: "PROVIDER_UNAVAILABLE",
  });
});

test("PUBLIC 08.6: booking action auto-confirms without exposing lease secrets", async () => {
  const setup = await setupOffer({ realtime: true });
  const model = await resolvePublicSchedulingModel({
    offerSlug: setup.offer.slug,
    kind: "COACHING",
  });
  assert.equal(model.enabled, true);
  if (!model.enabled) return;
  const slot = model.slots[0];
  assert.ok(slot);

  const state = await submitPublicBooking(
    undefined,
    bookingForm({
      offerSlug: setup.offer.slug,
      bookingTypeId: setup.bookingType.id,
      startAt: slot.startAt,
    }),
  );

  assert.equal(state?.ok, true);
  if (!state?.ok) return;
  assert.equal(state.timezone, "UTC");
  assert.equal("ownerToken" in state, false);

  const db = await getDb();
  const stored = await db
    .select()
    .from(bookings)
    .where(eq(bookings.id, state.bookingId))
    .get();
  assert.equal(stored?.status, "CONFIRMED");
});

test("PUBLIC 08.6: lost-response retry returns the same confirmed booking", async () => {
  const setup = await setupOffer({ realtime: true });
  const model = await resolvePublicSchedulingModel({
    offerSlug: setup.offer.slug,
    kind: "COACHING",
  });
  assert.equal(model.enabled, true);
  if (!model.enabled) return;
  const slot = model.slots[0];
  const requestKey = crypto.randomUUID();
  const acquisitionKey = crypto.randomUUID();
  const firstForm = bookingForm({
    offerSlug: setup.offer.slug,
    bookingTypeId: setup.bookingType.id,
    startAt: slot.startAt,
    requestKey,
    acquisitionKey,
  });
  const secondForm = bookingForm({
    offerSlug: setup.offer.slug,
    bookingTypeId: setup.bookingType.id,
    startAt: slot.startAt,
    requestKey,
    acquisitionKey,
  });

  const first = await submitPublicBooking(undefined, firstForm);
  const retry = await submitPublicBooking(undefined, secondForm);
  assert.equal(first?.ok, true);
  assert.equal(retry?.ok, true);
  if (!first?.ok || !retry?.ok) return;
  assert.equal(retry.bookingId, first.bookingId);
});

test("PUBLIC 08.6: requestKey retry cannot silently adopt edited requester intent", async () => {
  const setup = await setupOffer({ realtime: true });
  const model = await resolvePublicSchedulingModel({
    offerSlug: setup.offer.slug,
    kind: "COACHING",
  });
  assert.equal(model.enabled, true);
  if (!model.enabled) return;
  const slot = model.slots[0];
  const requestKey = crypto.randomUUID();
  const acquisitionKey = crypto.randomUUID();

  const first = await submitPublicBooking(
    undefined,
    bookingForm({
      offerSlug: setup.offer.slug,
      bookingTypeId: setup.bookingType.id,
      startAt: slot.startAt,
      requestKey,
      acquisitionKey,
      name: "Original Booker",
    }),
  );
  assert.equal(first?.ok, true);

  const edited = await submitPublicBooking(
    undefined,
    bookingForm({
      offerSlug: setup.offer.slug,
      bookingTypeId: setup.bookingType.id,
      startAt: slot.startAt,
      requestKey,
      acquisitionKey,
      name: "Edited Booker",
    }),
  );

  assert.equal(edited?.ok, false);
  if (!edited || edited.ok) return;
  assert.equal(edited.code, "CONFLICT");
});

test("PUBLIC 08.6: concurrent same identity with edited requester intent returns conflict for the loser", async () => {
  const setup = await setupOffer({ realtime: true });
  const model = await resolvePublicSchedulingModel({
    offerSlug: setup.offer.slug,
    kind: "COACHING",
  });
  assert.equal(model.enabled, true);
  if (!model.enabled) return;
  const slot = model.slots[0];
  assert.ok(slot);

  const requestKey = crypto.randomUUID();
  const acquisitionKey = crypto.randomUUID();

  const [original, edited] = await Promise.all([
    submitPublicBooking(
      undefined,
      bookingForm({
        offerSlug: setup.offer.slug,
        bookingTypeId: setup.bookingType.id,
        startAt: slot.startAt,
        requestKey,
        acquisitionKey,
        name: "Original Concurrent Booker",
      }),
    ),
    submitPublicBooking(
      undefined,
      bookingForm({
        offerSlug: setup.offer.slug,
        bookingTypeId: setup.bookingType.id,
        startAt: slot.startAt,
        requestKey,
        acquisitionKey,
        name: "Edited Concurrent Booker",
      }),
    ),
  ]);

  const states = [original, edited];
  const successes = states.filter((state) => state?.ok);
  const conflicts = states.filter(
    (state) => state && !state.ok && state.code === "CONFLICT",
  );

  assert.equal(successes.length, 1);
  assert.equal(conflicts.length, 1);

  const db = await getDb();
  const stored = await db
    .select()
    .from(bookings)
    .where(eq(bookings.requestKey, requestKey))
    .get();
  assert.ok(stored);
  assert.ok(
    stored.requesterName === "Original Concurrent Booker" ||
      stored.requesterName === "Edited Concurrent Booker",
  );
});

test("PUBLIC 08.6: concurrent attempts at one slot produce one winner", async () => {
  const setup = await setupOffer({ realtime: true });
  const model = await resolvePublicSchedulingModel({
    offerSlug: setup.offer.slug,
    kind: "COACHING",
  });
  assert.equal(model.enabled, true);
  if (!model.enabled) return;
  const slot = model.slots[0];

  const [a, b] = await Promise.all([
    submitPublicBooking(
      undefined,
      bookingForm({
        offerSlug: setup.offer.slug,
        bookingTypeId: setup.bookingType.id,
        startAt: slot.startAt,
        email: "race-a@example.com",
      }),
    ),
    submitPublicBooking(
      undefined,
      bookingForm({
        offerSlug: setup.offer.slug,
        bookingTypeId: setup.bookingType.id,
        startAt: slot.startAt,
        email: "race-b@example.com",
      }),
    ),
  ]);

  const winners = [a, b].filter((state) => state?.ok);
  const losers = [a, b].filter((state) => state && !state.ok);
  assert.equal(winners.length, 1);
  assert.equal(losers.length, 1);
});

test("PUBLIC 08.6: booking velocity guard stops repeated bookings before another lease", async () => {
  const setup = await setupOffer({ realtime: true });
  const email = "velocity@example.com";

  for (let index = 0; index < 3; index += 1) {
    const model = await resolvePublicSchedulingModel({
      offerSlug: setup.offer.slug,
      kind: "COACHING",
    });
    assert.equal(model.enabled, true);
    if (!model.enabled) return;
    const slot = model.slots[0];
    assert.ok(slot);

    const state = await submitPublicBooking(
      undefined,
      bookingForm({
        offerSlug: setup.offer.slug,
        bookingTypeId: setup.bookingType.id,
        startAt: slot.startAt,
        email,
      }),
    );
    assert.equal(state?.ok, true);
  }

  const after = await resolvePublicSchedulingModel({
    offerSlug: setup.offer.slug,
    kind: "COACHING",
  });
  assert.equal(after.enabled, true);
  if (!after.enabled) return;
  const nextSlot = after.slots[0];
  assert.ok(nextSlot);

  const blocked = await submitPublicBooking(
    undefined,
    bookingForm({
      offerSlug: setup.offer.slug,
      bookingTypeId: setup.bookingType.id,
      startAt: nextSlot.startAt,
      email,
    }),
  );
  assert.equal(blocked?.ok, false);
  if (!blocked || blocked.ok) return;
  assert.equal(blocked.code, "RATE_LIMITED");
});

test("PUBLIC 08.6: anchored fixed window cannot be doubled across a wall-clock boundary", async () => {
  const scopeKey = `boundary-${crypto.randomUUID()}`;
  const first = new Date("2026-10-27T11:59:59.900Z");

  for (let index = 0; index < 8; index += 1) {
    const admitted = await consumePublicFixedWindowLimit({
      scopeKey,
      now: first,
      windowMinutes: 15,
      maxCount: 8,
    });
    assert.equal(admitted, true);
  }

  // The old wall-aligned implementation reset here at 12:00:00, allowing a
  // second full burst within milliseconds. A scope-anchored window must not.
  const justAfterClockBoundary = await consumePublicFixedWindowLimit({
    scopeKey,
    now: new Date("2026-10-27T12:00:00.100Z"),
    windowMinutes: 15,
    maxCount: 8,
  });
  assert.equal(justAfterClockBoundary, false);

  // Once the full 15-minute interval from the first admitted request expires,
  // the same scope receives a fresh budget.
  const afterWindow = await consumePublicFixedWindowLimit({
    scopeKey,
    now: new Date("2026-10-27T12:14:59.900Z"),
    windowMinutes: 15,
    maxCount: 8,
  });
  assert.equal(afterWindow, true);
});

test("PUBLIC 08.6: rotating emails cannot bypass booking-type burst protection", async () => {
  const setup = await setupOffer({ realtime: true });

  for (let index = 0; index < 8; index += 1) {
    const model = await resolvePublicSchedulingModel({
      offerSlug: setup.offer.slug,
      kind: "COACHING",
    });
    assert.equal(model.enabled, true);
    if (!model.enabled) return;
    const slot = model.slots[0];
    assert.ok(slot);

    const state = await submitPublicBooking(
      undefined,
      bookingForm({
        offerSlug: setup.offer.slug,
        bookingTypeId: setup.bookingType.id,
        startAt: slot.startAt,
        email: `burst-${index}@example.com`,
      }),
    );
    assert.equal(state?.ok, true);
  }

  const after = await resolvePublicSchedulingModel({
    offerSlug: setup.offer.slug,
    kind: "COACHING",
  });
  assert.equal(after.enabled, true);
  if (!after.enabled) return;
  const nextSlot = after.slots[0];
  assert.ok(nextSlot);

  const blocked = await submitPublicBooking(
    undefined,
    bookingForm({
      offerSlug: setup.offer.slug,
      bookingTypeId: setup.bookingType.id,
      startAt: nextSlot.startAt,
      email: "burst-rotated@example.com",
    }),
  );
  assert.equal(blocked?.ok, false);
  if (!blocked || blocked.ok) return;
  assert.equal(blocked.code, "RATE_LIMITED");
});

test("PUBLIC 08.6: parallel rotating-email burst cannot exceed atomic booking-type cap", async () => {
  const setup = await setupOffer({ realtime: true });
  const model = await resolvePublicSchedulingModel({
    offerSlug: setup.offer.slug,
    kind: "COACHING",
  });
  assert.equal(model.enabled, true);
  if (!model.enabled) return;

  const slots = model.slots.slice(0, 12);
  assert.equal(slots.length, 12);

  const states = await Promise.all(
    slots.map((slot, index) =>
      submitPublicBooking(
        undefined,
        bookingForm({
          offerSlug: setup.offer.slug,
          bookingTypeId: setup.bookingType.id,
          startAt: slot.startAt,
          email: `parallel-burst-${index}@example.com`,
        }),
      ),
    ),
  );

  const successes = states.filter((state) => state?.ok);
  const limited = states.filter(
    (state) => state && !state.ok && state.code === "RATE_LIMITED",
  );

  assert.equal(successes.length, 8);
  assert.equal(limited.length, 4);

  const db = await getDb();
  const rows = await db
    .select()
    .from(bookings)
    .where(eq(bookings.bookingTypeId, setup.bookingType.id))
    .all();
  assert.equal(rows.length, 8);
});

test("PUBLIC 08.6: honeypot submission is rejected without creating a booking", async () => {
  const setup = await setupOffer({ realtime: true });
  const model = await resolvePublicSchedulingModel({
    offerSlug: setup.offer.slug,
    kind: "COACHING",
  });
  assert.equal(model.enabled, true);
  if (!model.enabled) return;
  const slot = model.slots[0];
  const form = bookingForm({
    offerSlug: setup.offer.slug,
    bookingTypeId: setup.bookingType.id,
    startAt: slot.startAt,
    email: "bot@example.com",
  });
  form.set("website", "https://spam.example");

  const db = await getDb();
  const before = await db.select().from(bookings).all();
  const state = await submitPublicBooking(undefined, form);
  const after = await db.select().from(bookings).all();

  assert.equal(state?.ok, false);
  assert.equal(after.length, before.length);
});

test("PUBLIC 08.6: tampered bookingTypeId fails closed", async () => {
  const setup = await setupOffer({ realtime: true });
  const model = await resolvePublicSchedulingModel({
    offerSlug: setup.offer.slug,
    kind: "COACHING",
  });
  assert.equal(model.enabled, true);
  if (!model.enabled) return;
  const slot = model.slots[0];

  const state = await submitPublicBooking(
    undefined,
    bookingForm({
      offerSlug: setup.offer.slug,
      bookingTypeId: "bt_tampered",
      startAt: slot.startAt,
    }),
  );
  assert.equal(state?.ok, false);
  if (state?.ok || !state) return;
  assert.equal(state.code, "SLOT_UNAVAILABLE");
});

test("PUBLIC 08.6: honeypot remains submitted but visually hidden from real users", () => {
  const css = readFileSync(
    join(process.cwd(), "src", "app", "(site)", "site.css"),
    "utf8",
  );
  const scheduler = readFileSync(
    join(process.cwd(), "src", "components", "products", "public-scheduler.tsx"),
    "utf8",
  );

  assert.ok(scheduler.includes('className="hg-honeypot"'));
  assert.ok(css.includes(".hg-honeypot {"));
  assert.ok(css.includes("clip-path: inset(50%)"));
  assert.ok(css.includes("width: 1px"));
});

test("PUBLIC 08.6: public pages keep scheduler conditional and lead fallback present", () => {
  const coaching = readFileSync(
    join(process.cwd(), "src", "app", "(site)", "coaching", "page.tsx"),
    "utf8",
  );
  const workshop = readFileSync(
    join(process.cwd(), "src", "app", "(site)", "workshop", "page.tsx"),
    "utf8",
  );

  for (const source of [coaching, workshop]) {
    assert.ok(source.includes("scheduling.enabled"));
    assert.ok(source.includes("<PublicScheduler"));
    assert.ok(source.includes("<LeadForm"));
  }
  assert.equal(
    coaching.includes("<span>Google Meet</span>"),
    false,
    "public coaching must not promise a dormant meeting provider",
  );
});
