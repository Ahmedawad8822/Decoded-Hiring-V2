"use client";

import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import { useEffect, useState } from "react";

import { recordPublicOfferCta } from "@/features/analytics/public-actions";
import {
  formatClosesLabel,
  formatSeatsLeftLabel,
} from "@/features/offers/presentation";
import type { PublicOfferAvailabilityResponse } from "@/features/offers/availability-handler";

type AvailabilitySnapshot =
  | { status: "loading" }
  | { status: "unavailable" }
  | {
      status: "loaded";
      seatsLeft: number | null;
      closesAt: string | null;
      state: "open" | "sold_out" | "closed";
    };

/**
 * Cached-page offer CTA with live limits.
 *
 * Server-rendered shells (ISR) cannot know the live seat count, so this
 * island fetches /api/public/offer-availability on mount — the same pattern
 * as the client-loaded slots on /coaching and /workshop. While loading (or
 * when the lookup fails) it renders exactly the server fallback CTA, so SSR
 * markup and SEO stay unchanged. When the offer is sold out or closed it
 * disables the primary CTA and shows the alternative (else contact) link.
 */
export function OfferLimitCta({
  offerSlug,
  scheduleHref,
  scheduleLabel = "Choose a time",
  primaryHref,
  primaryLabel,
  alternativeLabel,
  alternativeUrl,
  contactHref,
  contactLabel,
  icon = "down-right",
  track,
}: {
  offerSlug: string;
  scheduleHref?: string | null;
  scheduleLabel?: string;
  primaryHref: string;
  primaryLabel: string;
  alternativeLabel?: string | null;
  alternativeUrl?: string | null;
  contactHref: string;
  contactLabel: string;
  icon?: "down-right" | "up-right" | "none";
  track?: {
    route: "/coaching" | "/workshop" | "/courses";
    surface: "hero-primary" | "hero-secondary" | "inline";
  };
}) {
  const [snapshot, setSnapshot] = useState<AvailabilitySnapshot>({
    status: "loading",
  });

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/public/offer-availability?offer=${encodeURIComponent(offerSlug)}`, {
      cache: "no-store",
      signal: controller.signal,
      headers: { Accept: "application/json" },
    })
      .then(async (response) => {
        if (!response.ok) {
          setSnapshot({ status: "unavailable" });
          return;
        }
        const body =
          (await response.json()) as PublicOfferAvailabilityResponse;
        if (!body.found) {
          setSnapshot({ status: "unavailable" });
          return;
        }
        setSnapshot({
          status: "loaded",
          seatsLeft: body.seatsLeft,
          closesAt: body.closesAt,
          state: body.state,
        });
      })
      .catch(() => {
        if (!controller.signal.aborted) setSnapshot({ status: "unavailable" });
      });
    return () => controller.abort();
  }, [offerSlug]);

  function trackClick(target: "schedule" | "lead" | "contact" | "enroll") {
    if (!track) return;
    void recordPublicOfferCta({
      eventKey: crypto.randomUUID(),
      offerSlug,
      route: track.route,
      target,
      surface: track.surface,
    });
  }

  const ctaHref = scheduleHref ?? primaryHref;
  const ctaLabel = scheduleHref ? scheduleLabel : primaryLabel;
  // Course sales pages link into the classroom enrollment flow ("enroll");
  // coaching/workshop schedule or fall back to the lead brief ("lead").
  const ctaTarget = scheduleHref
    ? "schedule"
    : track?.route === "/courses"
      ? "enroll"
      : "lead";
  const Icon = icon === "up-right" ? ArrowUpRight : ArrowDownRight;

  if (snapshot.status === "loaded" && snapshot.state !== "open") {
    const soldOut = snapshot.state === "sold_out";
    return (
      <>
        <p className="hg-route-note" role="status">
          {soldOut
            ? "This offer has sold out."
            : "Booking for this offer has closed."}
        </p>
        <span className="hg-primary" aria-disabled="true">
          {soldOut ? "Sold out" : "Booking closed"}
        </span>
        <a
          className="hg-secondary"
          href={alternativeUrl ?? contactHref}
          onClick={() => trackClick("contact")}
        >
          {alternativeLabel ?? contactLabel}
        </a>
      </>
    );
  }

  const placesLeft =
    snapshot.status === "loaded"
      ? formatSeatsLeftLabel({ seatsLeft: snapshot.seatsLeft })
      : null;
  const closesOn =
    snapshot.status === "loaded" && snapshot.closesAt
      ? formatClosesLabel(
          new Date(snapshot.closesAt),
          Intl.DateTimeFormat().resolvedOptions().timeZone,
        )
      : null;

  return (
    <>
      {placesLeft && (
        <p className="hg-route-note" role="status">
          {placesLeft}
        </p>
      )}
      {closesOn && <p className="hg-route-note">{closesOn}</p>}
      <a
        className="hg-primary"
        href={ctaHref}
        onClick={() => trackClick(ctaTarget)}
      >
        {ctaLabel} {icon === "none" ? null : <Icon aria-hidden="true" />}
      </a>
    </>
  );
}
