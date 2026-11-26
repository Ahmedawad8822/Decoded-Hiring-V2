"use client";

import { authClient } from "@/lib/auth/client";
import { OfferLimitCta } from "@/components/products/offer-limit-cta";

/**
 * Pure viewer rule for the cached course sales page (unit-tested in
 * tests/course-sales.test.ts): signed-out visitors get the sign-up href
 * (which carries `?redirect=` back to the classroom course page) instead of
 * the bare classroom href; signed-in viewers — and CTAs that never pointed
 * at the classroom (contact/alternative) — keep the server-rendered href.
 * `null` means the session is still resolving, so keep the SSR href and
 * avoid a hydration mismatch.
 */
export function resolveCourseSalesCtaHref(
  signedIn: boolean | null,
  primaryHref: string,
  anonymousHref: string | null,
): string {
  if (signedIn === false && anonymousHref) return anonymousHref;
  return primaryHref;
}

/**
 * Live CTA island for the cached course sales page.
 *
 * The sales shell is ISR (no session, no per-request reads), so the seat
 * count and close state are fetched on mount from
 * /api/public/offer-availability — the same reads-only pattern as the
 * coaching/workshop pages. While loading (or when the lookup fails) it
 * renders exactly the server fallback CTA, so SSR markup and SEO stay
 * unchanged. Clicks are recorded as `offer_cta_clicked` business events with
 * route `/courses` and target `enroll`. The island also owns the seat/close
 * notices (via `OfferLimitCta`): the server shell renders none, so they can
 * never double up. `hideNotices` keeps the live state + tracking for the
 * repeated and sticky CTAs without repeating the hero notices.
 */
export function CourseSalesCta({
  offerSlug,
  primaryHref,
  primaryLabel,
  anonymousHref = null,
  hideNotices = false,
  alternativeLabel,
  alternativeUrl,
  contactHref = "/contact",
  contactLabel = "Contact us",
  surface = "hero-primary",
}: {
  offerSlug: string | null;
  primaryHref: string;
  primaryLabel: string;
  /** Sign-up href (with classroom redirect) for signed-out visitors. Only
   *  set when the primary href points at the classroom enrollment flow. */
  anonymousHref?: string | null;
  /** Hide the seat/close notices (repeated and sticky CTAs). */
  hideNotices?: boolean;
  alternativeLabel?: string | null;
  alternativeUrl?: string | null;
  contactHref?: string;
  contactLabel?: string;
  surface?: "hero-primary" | "hero-secondary" | "inline";
}) {
  const { data: session, isPending } = authClient.useSession();
  const href = resolveCourseSalesCtaHref(
    isPending ? null : Boolean(session?.user),
    primaryHref,
    anonymousHref,
  );
  if (!offerSlug) {
    return (
      <a className="hg-primary" href={href}>
        {primaryLabel}
      </a>
    );
  }
  return (
    <OfferLimitCta
      offerSlug={offerSlug}
      primaryHref={href}
      primaryLabel={primaryLabel}
      alternativeLabel={alternativeLabel}
      alternativeUrl={alternativeUrl}
      contactHref={contactHref}
      contactLabel={contactLabel}
      hideNotices={hideNotices}
      track={{ route: "/courses", surface }}
    />
  );
}
