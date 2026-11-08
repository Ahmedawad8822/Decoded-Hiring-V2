// ============================================================================
// PUBLIC BOOKING SLOTS (GET /api/public/booking-slots?offer=<slug>)
// ----------------------------------------------------------------------------
// The /coaching and /workshop pages are cached shells; the live part (open
// slots, holds, calendar free/busy) is fetched here by the client scheduler.
// Slot logic is NOT duplicated: this delegates to resolvePublicSchedulingModel.
//
// Reads only. Nothing is written to D1 per GET, so there is deliberately no
// per-IP counter (a counter would turn every read into a write). The work per
// request is bounded by MAX_PUBLIC_SLOTS and the progressive probe window.
// Holds and slot acquisition stay in the submit server action.
// ============================================================================

import { z } from "zod";

import { PUBLIC_OFFER_SLUGS } from "@/features/offers/catalog";
import {
  resolvePublicSchedulingModel,
  type PublicSchedulingDisabledReason,
  type PublicSchedulingKind,
  type PublicSchedulingSlot,
} from "./public-scheduling";

const OFFER_KINDS: Record<string, PublicSchedulingKind> = {
  [PUBLIC_OFFER_SLUGS.coaching]: "COACHING",
  [PUBLIC_OFFER_SLUGS.workshop]: "WORKSHOP",
};

const querySchema = z.object({
  offer: z
    .string()
    .trim()
    .min(1)
    .max(160)
    .refine((value) => Object.hasOwn(OFFER_KINDS, value)),
});

export type PublicBookingSlotsResponse =
  | {
      enabled: true;
      offerSlug: string;
      bookingTypeId: string;
      slots: PublicSchedulingSlot[];
      rangeEnd: string;
    }
  | { enabled: false; reason: PublicSchedulingDisabledReason };

const NO_STORE = { "Cache-Control": "no-store" } as const;

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

export async function handlePublicBookingSlotsRequest(
  request: Request,
  options: { now?: Date } = {},
): Promise<Response> {
  const parsed = querySchema.safeParse({
    offer: new URL(request.url).searchParams.get("offer"),
  });
  if (!parsed.success) {
    return json({ error: "Unknown or missing offer." }, 400);
  }

  try {
    const model = await resolvePublicSchedulingModel({
      offerSlug: parsed.data.offer,
      kind: OFFER_KINDS[parsed.data.offer],
      now: options.now,
    });
    const body: PublicBookingSlotsResponse = model.enabled
      ? {
          enabled: true,
          offerSlug: model.offerSlug,
          bookingTypeId: model.bookingTypeId,
          slots: model.slots,
          rangeEnd: model.rangeEnd,
        }
      : { enabled: false, reason: model.reason };
    return json(body);
  } catch {
    return json({ error: "Availability could not be loaded." }, 500);
  }
}
