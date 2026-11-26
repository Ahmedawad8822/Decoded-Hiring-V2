// ============================================================================
// PUBLIC OFFER AVAILABILITY (GET /api/public/offer-availability?offer=<slug>)
// ----------------------------------------------------------------------------
// Cached public pages (coaching, workshop, mission-01, ai-recruiter-os) read
// only configuration at render time. The live seat count and close state are
// fetched here by a client island, the same pattern as the client-loaded
// slots on /coaching and /workshop.
//
// Reads only. Nothing is written per GET, so no rate-limit counter (a counter
// would turn every read into a write). One indexed COUNT per linked entity.
// =============================================================================

import { z } from "zod";

import { getOfferBySlug } from "./service";
import { getAvailabilityForOffer, type OfferAvailabilityState } from "./availability";

const querySchema = z.object({
  offer: z.string().trim().min(1).max(160),
});

export type PublicOfferAvailabilityResponse =
  | {
      found: true;
      offerSlug: string;
      kind: string;
      seatLimit: number | null;
      seatsTaken: number;
      seatsLeft: number | null;
      closesAt: string | null;
      state: OfferAvailabilityState;
      alternativeCtaLabel: string | null;
      alternativeCtaUrl: string | null;
    }
  | { found: false };

const NO_STORE = { "Cache-Control": "no-store" } as const;

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

export async function handlePublicOfferAvailabilityRequest(
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
    const offer = await getOfferBySlug(parsed.data.offer);
    if (!offer) return json({ found: false } satisfies PublicOfferAvailabilityResponse);
    const availability = await getAvailabilityForOffer(
      offer,
      options.now ?? new Date(),
    );
    const body: PublicOfferAvailabilityResponse = {
      found: true,
      offerSlug: offer.slug,
      kind: offer.kind,
      seatLimit: availability.seatLimit,
      seatsTaken: availability.seatsTaken,
      seatsLeft: availability.seatsLeft,
      closesAt: availability.closesAt ? availability.closesAt.toISOString() : null,
      state: availability.state,
      alternativeCtaLabel: offer.alternativeCtaLabel,
      alternativeCtaUrl: offer.alternativeCtaUrl,
    };
    return json(body);
  } catch {
    return json({ error: "Availability could not be loaded." }, 500);
  }
}
