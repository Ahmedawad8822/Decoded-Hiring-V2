import {
  createAvailabilityWindow,
  createBookingType,
  getBookingTypeBySlug,
  getBookingTypeWindows,
  updateBookingType,
} from "../src/features/scheduling";
import {
  createOffer,
  getOfferBySlug,
  updateOffer,
} from "../src/features/offers/service";
import { PUBLIC_OFFER_SLUGS } from "../src/features/offers/catalog";

const E2E_BOOKING_TYPE_SLUG = "e2e-public-coaching";

export async function seedMission08E2E(): Promise<void> {
  let bookingType = await getBookingTypeBySlug(E2E_BOOKING_TYPE_SLUG);
  if (!bookingType) {
    bookingType = await createBookingType({
      slug: E2E_BOOKING_TYPE_SLUG,
      title: "E2E Public Coaching",
      description: "Local-only deterministic public scheduler fixture.",
      durationMinutes: 60,
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
      minimumNoticeMinutes: 0,
      bookingHorizonDays: 21,
      timezone: "Africa/Cairo",
      confirmationPolicy: "AUTO_CONFIRM",
      accessMode: "FREE",
      meetingMethod: "TO_BE_CONFIRMED",
      attendeeLimit: 1,
    });
  } else {
    bookingType = await updateBookingType({
      id: bookingType.id,
      title: "E2E Public Coaching",
      description: "Local-only deterministic public scheduler fixture.",
      durationMinutes: 60,
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
      minimumNoticeMinutes: 0,
      bookingHorizonDays: 21,
      timezone: "Africa/Cairo",
      confirmationPolicy: "AUTO_CONFIRM",
      accessMode: "FREE",
      meetingMethod: "TO_BE_CONFIRMED",
      attendeeLimit: 1,
      active: true,
    });
  }

  const windows = await getBookingTypeWindows(bookingType.id);
  const covered = new Set(windows.map((row) => row.weekday));
  for (let weekday = 0; weekday < 7; weekday += 1) {
    if (covered.has(weekday)) continue;
    await createAvailabilityWindow({
      bookingTypeId: bookingType.id,
      weekday,
      startMinute: 6 * 60,
      endMinute: 23 * 60,
    });
  }

  const existingOffer = await getOfferBySlug(PUBLIC_OFFER_SLUGS.coaching);
  if (!existingOffer) {
    await createOffer({
      kind: "COACHING",
      bookingTypeId: bookingType.id,
      title: "Recruitment Decision Coaching",
      slug: PUBLIC_OFFER_SLUGS.coaching,
      accessMode: "FREE",
      currency: null,
      amountMinor: null,
      alternativeCtaLabel: null,
      alternativeCtaUrl: null,
      active: true,
    });
  } else {
    await updateOffer({
      id: existingOffer.id,
      kind: "COACHING",
      courseId: null,
      bookingTypeId: bookingType.id,
      title: "Recruitment Decision Coaching",
      slug: PUBLIC_OFFER_SLUGS.coaching,
      accessMode: "FREE",
      currency: null,
      amountMinor: null,
      alternativeCtaLabel: null,
      alternativeCtaUrl: null,
      active: true,
    });
  }
}
