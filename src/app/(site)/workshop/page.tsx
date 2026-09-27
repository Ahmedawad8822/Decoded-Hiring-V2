import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import Image from "next/image";

import { WorkshopProgramme } from "@/components/products/workshop-programme";
import { PublicScheduler } from "@/components/products/public-scheduler";
import { TrackedOfferLink } from "@/components/products/tracked-offer-link";
import { WorkshopSystemMap } from "@/components/products/workshop-system-map";
import { LeadForm } from "@/features/leads/lead-form";
import { publicMetadata } from "@/lib/seo";
import { PUBLIC_OFFER_SLUGS } from "@/features/offers/catalog";
import { resolveOfferPublicPresentation } from "@/features/offers/presentation";
import { getOfferBySlugForKind } from "@/features/offers/service";
import { resolvePublicSchedulingModel } from "@/features/scheduling/public-scheduling";

export const dynamic = "force-dynamic";

export const metadata = publicMetadata({
  title: "AI-Powered Recruitment Workshop | Ahmed Awad",
  description:
    "A four-day practical recruitment workshop that turns activity into an evidence-to-recommendation operating system.",
  path: "/workshop",
});

export default async function WorkshopPage() {
  const offer = await getOfferBySlugForKind(PUBLIC_OFFER_SLUGS.workshop, "WORKSHOP");
  const offerPresentation = offer
    ? resolveOfferPublicPresentation(offer, {
        freeHref: "#workshop-brief",
        freeLabel: "Request a workshop conversation",
        contactHref: "#workshop-brief",
        contactLabel: "Request a workshop conversation",
      })
    : null;
  const scheduling = await resolvePublicSchedulingModel({
    offerSlug: PUBLIC_OFFER_SLUGS.workshop,
    kind: "WORKSHOP",
  });

  return (
    <article className="hg-page is-active">
      <section className="hg-section hg-product-hero hg-studio-mint hg-with-portrait">
        <div className="hg-product-hero-copy">
          <p className="hg-kicker">AI-Powered Recruitment Workshop</p>
          <h1 className="hg-product-title">
            Turn recruitment activity into an operating system.
          </h1>
          <p className="hg-body">
            A four-day practical workshop for teams and open cohorts.
            Participants leave with a shared language, reusable tools and a
            30-day implementation plan.
          </p>
          <div className="hg-product-meta">
            <span>4 practical days</span>
            <span>20 modules</span>
            <span>Private team or open cohort</span>
            <span>Live delivery</span>
            {offerPresentation?.priceLabel && <span>{offerPresentation.priceLabel}</span>}
          </div>
          <div className="hg-actions">
            {offer && !offerPresentation?.ctaHref ? (
              <span className="hg-primary" aria-disabled="true">
                Currently unavailable
              </span>
            ) : (
              <TrackedOfferLink
                className="hg-primary"
                offerSlug={PUBLIC_OFFER_SLUGS.workshop}
                route="/workshop"
                surface="hero-primary"
                target={scheduling.enabled ? "schedule" : "lead"}
                href={
                  scheduling.enabled
                    ? "#workshop-schedule"
                    : offerPresentation?.ctaHref ?? "#workshop-brief"
                }
              >
                {scheduling.enabled
                  ? "Choose a time"
                  : offerPresentation?.ctaLabel ?? "Bring this to my team"}{" "}
                <ArrowUpRight aria-hidden="true" />
              </TrackedOfferLink>
            )}
            <TrackedOfferLink
              className="hg-secondary"
              offerSlug={PUBLIC_OFFER_SLUGS.workshop}
              route="/workshop"
              surface="hero-secondary"
              target="lead"
              href="#workshop-brief"
            >
              Join the open-cohort list
            </TrackedOfferLink>
          </div>
        </div>
        <figure className="hg-product-portrait hg-product-portrait--workshop">
          <Image
            src="/images/ahmed-workshop-conversation.png"
            alt="Ahmed Awad in a focused workshop conversation"
            width={1122}
            height={1402}
            priority
            sizes="(max-width: 800px) 100vw, 42vw"
          />
        </figure>
      </section>

      <section className="hg-section hg-aha">
        <p className="hg-kicker">Buyer and participant case</p>
        <h2 className="hg-title">
          A workshop should change Monday morning—not just fill four days.
        </h2>
        <div className="hg-aha-grid">
          <div className="hg-aha-step">
            <b>A · AUTHORITY</b>
            <h3>Built from real hiring systems</h3>
            <p>
              Agency pace, in-house context and regional leadership are
              translated into a coherent operating method.
            </p>
          </div>
          <div className="hg-aha-step">
            <b>H · HIDDEN INSIGHT</b>
            <h3>Tool training is too narrow</h3>
            <p>
              AI creates leverage only when discovery, evidence and decision
              quality are already designed.
            </p>
          </div>
          <div className="hg-aha-step">
            <b>A · ACTION</b>
            <h3>Work on your context</h3>
            <p>
              The team builds its own discovery, mapping, assessment and
              implementation artefacts during the workshop.
            </p>
          </div>
        </div>
      </section>

      <section className="hg-section hg-proof-system">
        <p className="hg-kicker">Evidence-to-Recommendation OS</p>
        <h2 className="hg-title">One visible system from need to hire.</h2>
        <WorkshopSystemMap />
      </section>

      <section className="hg-section hg-programme">
        <p className="hg-kicker">Four days / twenty modules</p>
        <h2 className="hg-title">
          The programme moves from clarity to implementation.
        </h2>
        <WorkshopProgramme />
      </section>

      {scheduling.enabled && (
        <section
          className="hg-section hg-scheduling-stage"
          id="workshop-schedule"
        >
          <div className="hg-scheduling-intro">
            <p className="hg-kicker">Open scheduling route</p>
            <h2 className="hg-title">Choose a configured conversation slot.</h2>
            <p className="hg-body">
              Team enquiries stay lead-first. This scheduler appears only when
              the linked workshop Offer is explicitly configured for free,
              automatic booking.
            </p>
          </div>
          <PublicScheduler
            model={scheduling}
            fallbackHref="#workshop-brief"
            fallbackLabel="Request a workshop conversation instead"
          />
        </section>
      )}

      <section className="hg-section hg-form-stage" id="workshop-brief">
        <p className="hg-kicker">Start with your problem</p>
        <h2 className="hg-title">
          Tell me where your hiring system is breaking.
        </h2>
        <LeadForm
          kind="workshop"
          sourceRoute="/workshop"
          submitLabel="Request a workshop conversation"
        />
        <p className="hg-route-note">
          Ahmed reviews the context and coordinates the most useful format for
          your team.
        </p>
        <p className="hg-route-note">
          Prefer a direct note?{" "}
          <Link href="/contact?reason=workshop">Get in touch</Link>.
        </p>
      </section>
    </article>
  );
}
