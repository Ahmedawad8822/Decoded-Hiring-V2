"use server";

import { z } from "zod";

import { getPublicOfferBySlug } from "@/features/offers/service";
import { consumePublicFixedWindowLimit } from "@/features/public-intake/rate-limit";
import { recordBusinessEventBestEffort } from "./service";

const offerCtaSchema = z.object({
  eventKey: z.string().uuid(),
  offerSlug: z.string().trim().min(1).max(160),
  route: z.enum(["/coaching", "/workshop"]),
  target: z.enum(["schedule", "lead", "contact", "checkout"]),
  surface: z.enum(["hero-primary", "hero-secondary", "inline"]),
});

export async function recordPublicOfferCta(input: unknown): Promise<void> {
  const parsed = offerCtaSchema.parse(input);
  const offer = await getPublicOfferBySlug(parsed.offerSlug);
  if (!offer) return;

  const now = new Date();
  const admitted = await consumePublicFixedWindowLimit({
    scopeKey: `analytics:offer-cta:${parsed.route}`,
    now,
    windowMinutes: 15,
    maxCount: 500,
  });
  if (!admitted) return;

  await recordBusinessEventBestEffort({
    dedupeKey: `public-cta:${parsed.eventKey}`,
    eventName: "offer_cta_clicked",
    subjectType: "OFFER",
    subjectId: offer.id,
    offerId: offer.id,
    bookingTypeId: offer.bookingTypeId,
    route: parsed.route,
    surface: parsed.surface,
    metadata: {
      target: parsed.target,
      offer_kind: offer.kind,
      access_mode: offer.accessMode,
    },
    occurredAt: now,
  });
}
