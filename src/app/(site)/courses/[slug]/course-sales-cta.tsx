"use client";

import { OfferLimitCta } from "@/components/products/offer-limit-cta";

/**
 * Live CTA island for the cached course sales page.
 *
 * The sales shell is ISR (no session, no per-request reads), so the seat
 * count and close state are fetched on mount from
 * /api/public/offer-availability — the same reads-only pattern as the
 * coaching/workshop pages. While loading (or when the lookup fails) it
 * renders exactly the server fallback CTA, so SSR markup and SEO stay
 * unchanged. Clicks are recorded as `offer_cta_clicked` business events with
 * route `/courses` and target `enroll`.
 */
export function CourseSalesCta({
  offerSlug,
  primaryHref,
  primaryLabel,
  alternativeLabel,
  alternativeUrl,
  contactHref = "/contact",
  contactLabel = "Contact us",
  surface = "hero-primary",
}: {
  offerSlug: string;
  primaryHref: string;
  primaryLabel: string;
  alternativeLabel?: string | null;
  alternativeUrl?: string | null;
  contactHref?: string;
  contactLabel?: string;
  surface?: "hero-primary" | "hero-secondary" | "inline";
}) {
  return (
    <OfferLimitCta
      offerSlug={offerSlug}
      primaryHref={primaryHref}
      primaryLabel={primaryLabel}
      alternativeLabel={alternativeLabel}
      alternativeUrl={alternativeUrl}
      contactHref={contactHref}
      contactLabel={contactLabel}
      track={{ route: "/courses", surface }}
    />
  );
}
