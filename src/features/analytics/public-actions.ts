"use server";

import { z } from "zod";

import { getPublicOfferBySlug } from "@/features/offers/service";
import {
  PUBLIC_IP_LIMITS,
  consumePublicFixedWindowLimit,
  consumePublicIpLimit,
  getRequestClientIpHash,
} from "@/features/public-intake/rate-limit";
import { recordBusinessEventBestEffort } from "./service";
import { PUBLIC_ANALYTICS_BUDGET } from "./types";

/** Per-IP bucket first, then the shared budget; false => drop the event. */
async function admitPublicAnalytics(now: Date): Promise<boolean> {
  const ipHash = await getRequestClientIpHash();
  if (ipHash) {
    const ipAllowed = await consumePublicIpLimit({
      ipHash,
      limit: PUBLIC_IP_LIMITS.analytics,
      now,
    });
    if (!ipAllowed) return false;
  }
  return consumePublicFixedWindowLimit({
    scopeKey: PUBLIC_ANALYTICS_BUDGET.scopeKey,
    now,
    windowMinutes: PUBLIC_ANALYTICS_BUDGET.windowMinutes,
    maxCount: PUBLIC_ANALYTICS_BUDGET.maxCount,
  });
}

const offerCtaSchema = z.object({
  eventKey: z.string().uuid(),
  offerSlug: z.string().trim().min(1).max(160),
  route: z.enum(["/coaching", "/workshop", "/courses"]),
  target: z.enum(["schedule", "lead", "contact", "checkout", "enroll"]),
  surface: z.enum(["hero-primary", "hero-secondary", "inline"]),
});

export async function recordPublicOfferCta(input: unknown): Promise<void> {
  const parsed = offerCtaSchema.parse(input);
  const offer = await getPublicOfferBySlug(parsed.offerSlug);
  if (!offer) return;

  const routeMatchesKind =
    (parsed.route === "/coaching" && offer.kind === "COACHING") ||
    (parsed.route === "/workshop" && offer.kind === "WORKSHOP") ||
    (parsed.route === "/courses" && offer.kind === "COURSE");
  if (!routeMatchesKind) return;

  const now = new Date();
  if (!(await admitPublicAnalytics(now))) return;

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


const landingPageSchema = z.object({
  eventKey: z.string().uuid(),
  landingPageId: z.string().trim().min(1).max(80),
  slug: z.string().trim().min(1).max(160),
});

/**
 * View event for /go/[slug], tagged with the landing page id. Best-effort
 * and rate-limited like every other public event: an over-limit view is
 * dropped silently. The page must be live; anything else is ignored so
 * previews and ended campaigns never pollute the funnel.
 */
export async function recordLandingPageView(input: unknown): Promise<void> {
  const parsed = landingPageSchema.parse(input);
  const { getAdminLandingPageBySlug } = await import("../landing-pages/service");
  const { getLandingScheduleState } = await import("../landing-pages/types");
  const page = await getAdminLandingPageBySlug(parsed.slug);
  if (
    !page ||
    page.id !== parsed.landingPageId ||
    page.trashedAt !== null ||
    page.status !== "published" ||
    getLandingScheduleState(page) !== "live"
  ) {
    return;
  }

  const now = new Date();
  if (!(await admitPublicAnalytics(now))) return;

  await recordBusinessEventBestEffort({
    dedupeKey: `landing-view:${parsed.eventKey}`,
    eventName: "landing_page_viewed",
    subjectType: "PUBLIC",
    subjectId: page.id,
    route: `/go/${page.slug}`,
    surface: "landing-page",
    metadata: { target_kind: page.targetKind },
    occurredAt: now,
  });
}

const landingCtaSchema = landingPageSchema.extend({
  surface: z.enum(["hero", "cta_band", "target_summary", "sticky"]),
});

/** CTA click on a landing page, tagged with the landing page id. */
export async function recordLandingPageCta(input: unknown): Promise<void> {
  const parsed = landingCtaSchema.parse(input);
  const { getAdminLandingPageBySlug } = await import("../landing-pages/service");
  const { getLandingScheduleState } = await import("../landing-pages/types");
  const page = await getAdminLandingPageBySlug(parsed.slug);
  if (
    !page ||
    page.id !== parsed.landingPageId ||
    page.trashedAt !== null ||
    page.status !== "published" ||
    getLandingScheduleState(page) !== "live"
  ) {
    return;
  }

  const now = new Date();
  if (!(await admitPublicAnalytics(now))) return;

  await recordBusinessEventBestEffort({
    dedupeKey: `landing-cta:${parsed.eventKey}`,
    eventName: "landing_page_cta_clicked",
    subjectType: "PUBLIC",
    subjectId: page.id,
    offerId: page.targetKind === "offer" ? page.targetOfferId : null,
    route: `/go/${page.slug}`,
    surface: parsed.surface,
    metadata: { target_kind: page.targetKind, cta_surface: parsed.surface },
    occurredAt: now,
  });
}

const publicBookingStartedSchema = z.object({
  eventKey: z.string().uuid(),
  offerSlug: z.string().trim().min(1).max(160),
  offerKind: z.enum(["COACHING", "WORKSHOP"]),
  bookingTypeId: z.string().trim().min(1).max(180),
});

export async function recordPublicBookingStarted(input: unknown): Promise<void> {
  const parsed = publicBookingStartedSchema.parse(input);
  const offer = await getPublicOfferBySlug(parsed.offerSlug);
  if (
    !offer ||
    offer.kind !== parsed.offerKind ||
    offer.bookingTypeId !== parsed.bookingTypeId
  ) {
    return;
  }

  const now = new Date();
  if (!(await admitPublicAnalytics(now))) return;

  await recordBusinessEventBestEffort({
    dedupeKey: `public-booking:${parsed.eventKey}:started`,
    eventName: "booking_started",
    subjectType: "BOOKING_TYPE",
    subjectId: parsed.bookingTypeId,
    offerId: offer.id,
    bookingTypeId: parsed.bookingTypeId,
    route: parsed.offerKind === "COACHING" ? "/coaching" : "/workshop",
    surface: "public-scheduler",
    metadata: {
      offer_kind: parsed.offerKind,
      access_mode: offer.accessMode,
    },
    occurredAt: now,
  });
}
