import type { Offer } from "@/lib/db";

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
  const amount = offer.amountMinor / 100;
  try {
    return new Intl.NumberFormat("en", {
      style: "currency",
      currency: offer.currency,
      maximumFractionDigits: amount % 1 === 0 ? 0 : 2,
    }).format(amount);
  } catch {
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
      priceLabel,
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
