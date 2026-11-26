import type { Offer } from "@/lib/db";
import type { OfferAvailability } from "./availability";

export type OfferPublicAction =
  | "FREE_ACCESS"
  | "MANUAL"
  | "ALTERNATIVE"
  | "CONTACT"
  | "UNAVAILABLE";

export type OfferPublicPresentation = {
  badge: string;
  priceLabel: string | null;
  ctaLabel: string | null;
  ctaHref: string | null;
  action: OfferPublicAction;
};

export function formatOfferPrice(offer: Pick<Offer, "currency" | "amountMinor">): string | null {
  if (!offer.currency || offer.amountMinor == null || offer.amountMinor <= 0) return null;
  try {
    const formatter = new Intl.NumberFormat("en", {
      style: "currency",
      currency: offer.currency,
    });
    const fractionDigits = formatter.resolvedOptions().maximumFractionDigits ?? 2;
    const amount = offer.amountMinor / 10 ** fractionDigits;
    return formatter.format(amount);
  } catch {
    const amount = offer.amountMinor / 100;
    return `${offer.currency} ${amount.toFixed(2)}`;
  }
}

/**
 * Resolve a truthful public CTA without assuming a payment provider exists.
 *
 * Paid modes deliberately DO NOT create a checkout action in 08.3. Until the
 * provider slice supplies an authoritative checkout capability, paid offers
 * use their configured alternative CTA or a contact fallback.
 */
export function resolveOfferPublicPresentation(
  offer: Offer,
  options: {
    freeHref: string;
    freeLabel?: string;
    contactHref?: string;
    contactLabel?: string;
  },
): OfferPublicPresentation {
  const contactHref = options.contactHref ?? "/contact";
  const contactLabel = options.contactLabel ?? "Contact us";
  const priceLabel = formatOfferPrice(offer);

  if (!offer.active) {
    return {
      badge: "UNAVAILABLE",
      priceLabel: null,
      ctaLabel: null,
      ctaHref: null,
      action: "UNAVAILABLE",
    };
  }

  if (offer.accessMode === "FREE") {
    return {
      badge: "FREE",
      priceLabel: null,
      ctaLabel: options.freeLabel ?? "Start free",
      ctaHref: options.freeHref,
      action: "FREE_ACCESS",
    };
  }

  if (offer.accessMode === "MANUAL_INVOICE") {
    return {
      badge: priceLabel ?? "MANUAL INVOICE",
      priceLabel,
      ctaLabel: offer.alternativeCtaLabel ?? "Request access",
      ctaHref: offer.alternativeCtaUrl ?? contactHref,
      action: offer.alternativeCtaUrl ? "ALTERNATIVE" : "MANUAL",
    };
  }

  if (offer.accessMode === "PAYMENT_DISABLED") {
    return {
      badge: "PAYMENT UNAVAILABLE",
      priceLabel,
      ctaLabel: offer.alternativeCtaLabel,
      ctaHref: offer.alternativeCtaUrl,
      action: "ALTERNATIVE",
    };
  }

  if (offer.accessMode === "COMING_SOON") {
    return {
      badge: "COMING SOON",
      priceLabel,
      ctaLabel: offer.alternativeCtaLabel,
      ctaHref: offer.alternativeCtaUrl,
      action: "ALTERNATIVE",
    };
  }

  // PAID_ONE_TIME / PAID_SESSION intentionally fail closed until the payment
  // adapter slice provides a real, verified checkout capability.
  return {
    badge: priceLabel ?? "PAID",
    priceLabel,
    ctaLabel: offer.alternativeCtaLabel ?? contactLabel,
    ctaHref: offer.alternativeCtaUrl ?? contactHref,
    action: offer.alternativeCtaUrl ? "ALTERNATIVE" : "CONTACT",
  };
}

/**
 * One-line access badge for the `/courses` list card. Mirrors the detail
 * page: inactive offers read as unavailable (the detail page says "not
 * currently accepting new enrollments"), paid modes show their price when
 * one is set, and raw access-mode enums never leak. `freeHref` is unused
 * here (only badge/priceLabel are read); the contact fallback matches the
 * detail page default.
 */
export function resolveCourseListAccessLabel(
  offer: Offer | null,
  fallbackAccessMode: string,
): string {
  if (offer && !offer.active) return "UNAVAILABLE";
  if (!offer) return fallbackAccessMode === "FREE" ? "FREE" : "ON REQUEST";
  const presentation = resolveOfferPublicPresentation(offer, {
    freeHref: "",
    contactHref: "/contact",
  });
  return presentation.priceLabel ?? presentation.badge;
}

/**
 * Offer-limit display rule: capped offers show "N places left" once scarcity
 * is material (20 or fewer left). Uncapped offers never show it. Zero or
 * negative counts never render (the sold-out state owns that message).
 */
export const SEATS_LEFT_NOTICE_THRESHOLD = 20;

export function formatSeatsLeftLabel(
  availability: Pick<OfferAvailability, "seatsLeft">,
): string | null {
  if (availability.seatsLeft == null) return null;
  if (availability.seatsLeft <= 0) return null;
  if (availability.seatsLeft > SEATS_LEFT_NOTICE_THRESHOLD) return null;
  if (availability.seatsLeft === 1) return "1 place left";
  return `${availability.seatsLeft} places left`;
}

/** "Closes on 12 Jan 2026". Pass a timezone to render in it, else UTC. */
export function formatClosesLabel(closesAt: Date, timeZone?: string): string {
  const label = new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    ...(timeZone ? { timeZone } : { timeZone: "UTC" }),
  }).format(closesAt);
  return `Closes on ${label}`;
}
