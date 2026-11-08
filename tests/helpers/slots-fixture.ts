import { bookingAvailabilityWindows, bookings, getDb, slotHolds } from "@/lib/db";
import { createOffer } from "@/features/offers/service";
import { createBookingType } from "@/features/scheduling/policy";
import { UnconfiguredCommerceSchedulingProviders } from "@/features/scheduling/providers";
import type { CreateBookingTypeInput } from "@/features/scheduling/schemas";
import type { FreeBusyEntry } from "@/features/scheduling/providers";
import { generateCandidateSlots } from "./slots-reference/availability";

const DAY_MS = 86_400_000;

/** Real D1 rows; no service/DB mocks. Also shared by the reproducible benchmark. */
export async function seedSlotsFixture(options: {
  now?: Date;
  policy?: Partial<CreateBookingTypeInput>;
  windows?: Array<{ weekday: number; startMinute: number; endMinute: number }>;
  conflicts?: boolean;
} = {}) {
  const now = options.now ?? new Date("2026-10-20T08:00:00.000Z");
  const suffix = crypto.randomUUID().slice(0, 8);
  const bookingType = await createBookingType({
    slug: `bench-slots-${suffix}`, title: "Slot CPU fixture",
    durationMinutes: 30, bufferBeforeMinutes: 10, bufferAfterMinutes: 10,
    minimumNoticeMinutes: 60, bookingHorizonDays: 60,
    timezone: "Africa/Cairo", confirmationPolicy: "AUTO_CONFIRM",
    accessMode: "FREE", meetingMethod: "TO_BE_CONFIRMED", attendeeLimit: 1,
    ...options.policy,
  });
  const db = await getDb();
  const windows = (options.windows ?? [1, 2, 3, 4, 5].flatMap((weekday) => [
    { weekday, startMinute: 540, endMinute: 780 },
    { weekday, startMinute: 840, endMinute: 1080 },
  ])).map((w, i) => ({ ...w, id: `window-${suffix}-${i}`, bookingTypeId: bookingType.id, createdAt: now }));
  for (let i = 0; i < windows.length; i += 10) {
    await db.insert(bookingAvailabilityWindows).values(windows.slice(i, i + 10));
  }
  const offer = await createOffer({
    kind: "COACHING", bookingTypeId: bookingType.id, title: "Slot CPU fixture",
    slug: `bench-offer-${suffix}`, accessMode: "FREE",
  });
  const rangeEnd = new Date(now.getTime() + 60 * DAY_MS);
  const candidateParams = { bookingType, windows, now, rangeStart: now, rangeEnd };
  const candidates = generateCandidateSlots(candidateParams);
  const busy: FreeBusyEntry[] = [];
  if (options.conflicts !== false) {
    for (let i = 0; i < candidates.length; i++) {
      const slot = candidates[i];
      // Include consumed, live, expired-at-now and released leases. A confirmed
      // booking on a released lease independently exercises booking exclusion.
      if (i % 11 === 0 || i % 13 === 0) {
        const id = `hold-${suffix}-${i}`;
        const status = i % 11 === 0 ? (i % 2 ? "CONSUMED" : "RELEASED") : i % 3 === 0 ? "CONSUMED" : "HELD";
        await db.insert(slotHolds).values({
          ...slot, id, bookingTypeId: bookingType.id, ownerToken: `test-${id}`,
          // Legacy conflict semantics use canonical keys, even when persisted
          // lease/booking intervals extend into neighboring candidates.
          endAt: new Date(slot.endAt.getTime() + (i % 3 ? 0 : 10 * 60_000)),
          acquisitionKey: id, status,
          expiresAt: new Date(now.getTime() + (i % 2 ? DAY_MS : 0)),
          createdAt: now, updatedAt: now,
        });
        if (i % 11 === 0) await db.insert(bookings).values({
          ...slot, id: `booking-${suffix}-${i}`, bookingTypeId: bookingType.id,
          endAt: new Date(slot.endAt.getTime() + 5 * 60_000),
          holdId: id, holdAcquisitionKey: id, requestKey: id,
          requesterName: "Test fixture", requesterEmail: "fixture@example.invalid",
          timezone: bookingType.timezone, status: "CONFIRMED", createdAt: now, updatedAt: now,
        });
      }
      if (i % 7 === 0) {
        busy.push({ startAt: slot.startAt, endAt: slot.endAt, busy: true });
        // Nested, overlapping, unsorted intervals exercise the interval index.
        busy.unshift({ startAt: new Date(slot.startAt.getTime() + 60_000), endAt: slot.endAt, busy: true });
      }
      if (i % 17 === 0) busy.push({ startAt: slot.startAt, endAt: slot.endAt, busy: false });
    }
  }
  const providers = {
    ...UnconfiguredCommerceSchedulingProviders,
    calendar: {
      ...UnconfiguredCommerceSchedulingProviders.calendar,
      getStatus: async () => ({ kind: "calendar" as const, provider: "fixture", configured: true, capabilities: ["free_busy"] }),
      getFreeBusy: async () => busy,
    },
  };
  return {
    bookingType, windows, candidates, busy, candidateParams, providers,
    params: { offerSlug: offer.slug, kind: "COACHING" as const, now, rangeDays: 60, providers },
  };
}
