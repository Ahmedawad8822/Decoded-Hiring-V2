"use server";

import { z } from "zod";

import { recordBusinessEventBestEffort } from "@/features/analytics/service";

import {
  acquireSlotHold,
  releaseSlotHold,
  SchedulingDomainError,
} from "@/features/scheduling";
import {
  createBookingRequest,
  recoverAutoConfirmBooking,
  recoverBookingByRequestKey,
} from "@/features/scheduling/bookings";
import {
  consumePublicBookingAdmission,
  resolvePublicBookableSlot,
  type PublicSchedulingKind,
} from "@/features/scheduling/public-scheduling";

const publicBookingSchema = z.object({
  offerSlug: z.string().trim().min(1).max(160),
  offerKind: z.enum(["COACHING", "WORKSHOP"]),
  bookingTypeId: z.string().trim().min(1),
  startAt: z.string().datetime({ offset: true }),
  requestKey: z.string().uuid(),
  acquisitionKey: z.string().uuid(),
  requesterName: z.string().trim().min(2).max(160),
  requesterEmail: z.string().trim().email().toLowerCase().max(320),
  requesterPhone: z.preprocess(
    (value) =>
      typeof value === "string" && value.trim() === "" ? null : value,
    z
      .string()
      .trim()
      .regex(/^\+[1-9][0-9]{7,14}$/)
      .nullable(),
  ),
  notes: z.preprocess(
    (value) =>
      typeof value === "string" && value.trim() === "" ? null : value,
    z.string().trim().max(1200).nullable(),
  ),
  privacyAcknowledged: z.boolean(),
  website: z.string().max(0),
});

export type PublicBookingActionState =
  | undefined
  | {
      ok: true;
      bookingId: string;
      startAt: string;
      endAt: string;
      timezone: string;
      message: string;
    }
  | {
      ok: false;
      code:
        | "VALIDATION"
        | "UNAVAILABLE"
        | "SLOT_UNAVAILABLE"
        | "RATE_LIMITED"
        | "CONFLICT"
        | "UNEXPECTED";
      message: string;
      fieldErrors?: Record<string, string[] | undefined>;
    };

function formBoolean(value: FormDataEntryValue | null): boolean {
  return value === "true" || value === "on";
}

function publicRoute(kind: "COACHING" | "WORKSHOP"): "/coaching" | "/workshop" {
  return kind === "COACHING" ? "/coaching" : "/workshop";
}

function safeSuccess(booking: {
  id: string;
  bookingTypeId: string;
  requesterEmail: string;
  startAt: Date;
  endAt: Date;
  timezone: string;
  status: string;
}): PublicBookingActionState {
  if (booking.status !== "CONFIRMED") {
    return {
      ok: false,
      code: "CONFLICT",
      message:
        "This booking request exists but is not confirmed yet. Please use the enquiry form so Ahmed can help resolve it.",
    };
  }
  return {
    ok: true,
    bookingId: booking.id,
    startAt: booking.startAt.toISOString(),
    endAt: booking.endAt.toISOString(),
    timezone: booking.timezone,
    message:
      "Your time is reserved. Meeting details will be coordinated separately while external calendar and email providers remain dormant.",
  };
}

async function recoverExistingPublicBooking(
  booking: {
    id: string;
    requestKey: string;
    bookingTypeId: string;
    requesterName: string;
    requesterEmail: string;
    requesterPhone: string | null;
    notes: string | null;
    holdAcquisitionKey: string;
    startAt: Date;
    endAt: Date;
    timezone: string;
    status: string;
    version: number;
  },
  input: {
    requestKey: string;
    bookingTypeId: string;
    requesterName: string;
    requesterEmail: string;
    requesterPhone: string | null;
    notes: string | null;
    acquisitionKey: string;
    startAt: string;
  },
): Promise<PublicBookingActionState> {
  if (!existingMatchesInput(booking, input)) {
    return {
      ok: false,
      code: "CONFLICT",
      message:
        "This booking request identity is already bound to a different attempt.",
    };
  }

  if (booking.status === "REQUESTED") {
    try {
      const recovered = await recoverAutoConfirmBooking(
        booking.id,
        booking.version,
        new Date(),
      );
      return safeSuccess(recovered);
    } catch {
      return {
        ok: false,
        code: "CONFLICT",
        message:
          "This booking request exists but could not be safely auto-confirmed. Please use the enquiry form so Ahmed can help resolve it.",
      };
    }
  }

  return safeSuccess(booking);
}

function existingMatchesInput(
  booking: {
    requestKey: string;
    bookingTypeId: string;
    requesterName: string;
    requesterEmail: string;
    requesterPhone: string | null;
    notes: string | null;
    holdAcquisitionKey: string;
    startAt: Date;
  },
  input: {
    requestKey: string;
    bookingTypeId: string;
    requesterName: string;
    requesterEmail: string;
    requesterPhone: string | null;
    notes: string | null;
    acquisitionKey: string;
    startAt: string;
  },
): boolean {
  return (
    booking.requestKey === input.requestKey &&
    booking.bookingTypeId === input.bookingTypeId &&
    booking.requesterName === input.requesterName &&
    booking.requesterEmail === input.requesterEmail &&
    (booking.requesterPhone ?? null) === (input.requesterPhone ?? null) &&
    (booking.notes ?? null) === (input.notes ?? null) &&
    booking.holdAcquisitionKey === input.acquisitionKey &&
    booking.startAt.toISOString() === new Date(input.startAt).toISOString()
  );
}

export async function submitPublicBooking(
  _previous: PublicBookingActionState,
  formData: FormData,
): Promise<PublicBookingActionState> {
  const parsed = publicBookingSchema.safeParse({
    offerSlug: formData.get("offerSlug"),
    offerKind: formData.get("offerKind"),
    bookingTypeId: formData.get("bookingTypeId"),
    startAt: formData.get("startAt"),
    requestKey: formData.get("requestKey"),
    acquisitionKey: formData.get("acquisitionKey"),
    requesterName: formData.get("requesterName"),
    requesterEmail: formData.get("requesterEmail"),
    requesterPhone: formData.get("requesterPhone"),
    notes: formData.get("notes"),
    privacyAcknowledged: formBoolean(formData.get("privacyAcknowledged")),
    website: formData.get("website") ?? "",
  });

  if (!parsed.success) {
    return {
      ok: false,
      code: "VALIDATION",
      message: "Some booking details need attention.",
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }
  if (!parsed.data.privacyAcknowledged) {
    return {
      ok: false,
      code: "VALIDATION",
      message: "Please acknowledge the privacy note before booking.",
      fieldErrors: {
        privacyAcknowledged: ["Privacy acknowledgement is required."],
      },
    };
  }

  const existing = await recoverBookingByRequestKey(parsed.data.requestKey);
  if (existing) {
    return recoverExistingPublicBooking(existing, parsed.data);
  }

  const now = new Date();
  const requestedStartAt = new Date(parsed.data.startAt);
  const bookable = await resolvePublicBookableSlot({
    offerSlug: parsed.data.offerSlug,
    kind: parsed.data.offerKind as PublicSchedulingKind,
    startAt: requestedStartAt,
    now,
  });

  if (
    !bookable ||
    bookable.model.bookingTypeId !== parsed.data.bookingTypeId
  ) {
    return {
      ok: false,
      code: "SLOT_UNAVAILABLE",
      message:
        "That time is no longer available. Refresh the page and choose another slot.",
    };
  }

  await recordBusinessEventBestEffort({
    dedupeKey: `public-booking:${parsed.data.requestKey}:started`,
    eventName: "booking_started",
    subjectType: "BOOKING_TYPE",
    subjectId: bookable.model.bookingTypeId,
    bookingTypeId: bookable.model.bookingTypeId,
    route: publicRoute(parsed.data.offerKind),
    surface: "public-scheduler",
    metadata: {
      offer_kind: parsed.data.offerKind,
      offer_slug: parsed.data.offerSlug,
      access_mode: "FREE",
    },
    occurredAt: now,
  });

    // Only a server-validated Offer/BookingType/slot attempt may consume public
  // booking capacity. Admission is atomic and happens before another lease is
  // acquired, so concurrent rotating-email bursts cannot exceed the cap.
  const admitted = await consumePublicBookingAdmission({
    bookingTypeId: bookable.model.bookingTypeId,
    requesterEmail: parsed.data.requesterEmail,
    now,
  });
  if (!admitted) {
    return {
      ok: false,
      code: "RATE_LIMITED",
      message:
        "This scheduling route has received too many booking attempts in a short window. Please try again later or use the enquiry form.",
    };
  }

  const acquisition = await acquireSlotHold({
    bookingTypeId: bookable.model.bookingTypeId,
    startAt: requestedStartAt,
    now,
    ttlMinutes: 5,
    acquisitionKey: parsed.data.acquisitionKey,
  });

  if (!acquisition.success) {
    return {
      ok: false,
      code: "SLOT_UNAVAILABLE",
      message:
        "Someone else reached that slot first. Refresh the page and choose another time.",
    };
  }

  await recordBusinessEventBestEffort({
    dedupeKey: `public-slot:${parsed.data.acquisitionKey}:held`,
    eventName: "slot_held",
    subjectType: "BOOKING_TYPE",
    subjectId: bookable.model.bookingTypeId,
    bookingTypeId: bookable.model.bookingTypeId,
    route: publicRoute(parsed.data.offerKind),
    surface: "public-scheduler",
    metadata: {
      offer_kind: parsed.data.offerKind,
      offer_slug: parsed.data.offerSlug,
    },
    occurredAt: now,
  });

  try {
    const booking = await createBookingRequest({
      bookingTypeId: bookable.model.bookingTypeId,
      holdId: acquisition.hold.id,
      holdAcquisitionKey: acquisition.acquisitionKey,
      requestKey: parsed.data.requestKey,
      requesterName: parsed.data.requesterName,
      requesterEmail: parsed.data.requesterEmail,
      requesterPhone: parsed.data.requesterPhone,
      notes: parsed.data.notes,
      now,
    });

    return recoverExistingPublicBooking(booking, parsed.data);
  } catch (error: unknown) {
    const recovered = await recoverBookingByRequestKey(parsed.data.requestKey);
    if (recovered) {
      return recoverExistingPublicBooking(recovered, parsed.data);
    }

    try {
      await releaseSlotHold(
        bookable.model.bookingTypeId,
        requestedStartAt,
        acquisition.ownerToken,
        new Date(),
      );
    } catch {
      // Best-effort cleanup only. The lease has a short TTL and ownership CAS.
    }

    if (error instanceof SchedulingDomainError) {
      if (
        error.code === "EXPIRED" ||
        error.code === "CONCURRENT_MODIFICATION" ||
        error.code === "HOLD_GENERATION_MISMATCH" ||
        error.code === "WRONG_STATE"
      ) {
        return {
          ok: false,
          code: "SLOT_UNAVAILABLE",
          message:
            "That time changed while you were booking it. Refresh and choose another slot.",
        };
      }
      if (
        error.code === "BOOKING_UNAVAILABLE" ||
        error.code === "BOOKING_TYPE_NOT_FOUND"
      ) {
        return {
          ok: false,
          code: "UNAVAILABLE",
          message:
            "Online scheduling is not available for this offer right now. Please use the enquiry form instead.",
        };
      }
    }

    return {
      ok: false,
      code: "UNEXPECTED",
      message:
        "The booking could not be completed safely. Please try again or use the enquiry form.",
    };
  }
}
