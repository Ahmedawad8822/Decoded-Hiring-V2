import { ArrowUpRight } from "lucide-react";
import Image from "next/image";

import { LeadForm } from "@/features/leads/lead-form";
import { publicMetadata } from "@/lib/seo";
import { PUBLIC_OFFER_SLUGS } from "@/features/offers/catalog";
import { resolveOfferPublicPresentation } from "@/features/offers/presentation";
import { getOfferBySlugForKind } from "@/features/offers/service";

export const dynamic = "force-dynamic";

export const metadata = publicMetadata({
  title: "AI Recruiter OS | Ahmed Awad",
  description:
    "Join the waitlist for an advanced programme about AI agents and accountable recruitment workflows.",
  path: "/ai-recruiter-os",
});

export default async function AiRecruiterOsPage() {
  const offer = await getOfferBySlugForKind(
    PUBLIC_OFFER_SLUGS.aiRecruiterOs,
    "PRODUCT",
  );
  const offerPresentation = offer
    ? resolveOfferPublicPresentation(offer, {
        freeHref: "#ai-os-waitlist",
        freeLabel: "Join the waitlist",
        contactHref: "#ai-os-waitlist",
        contactLabel: "Join the waitlist",
      })
    : null;
  const isUnavailable = Boolean(offer && !offerPresentation?.ctaHref);

  return (
    <article className="hg-page is-active">
      <section className="hg-section hg-os-waitlist">
        <div className="hg-os-waitlist-copy">
          <h1 className="hg-product-title">AI Recruiter OS</h1>
          <p className="hg-body">
            Build AI agents and accountable workflows that strengthen
            recruitment judgment across the entire hiring process.
          </p>
          <div className="hg-actions">
            {isUnavailable ? (
              <span className="hg-primary" aria-disabled="true">
                Currently unavailable
              </span>
            ) : (
              <a
                className="hg-primary"
                href={offerPresentation?.ctaHref ?? "#ai-os-waitlist"}
              >
                {offerPresentation?.ctaLabel ?? "Join the waitlist"}{" "}
                <ArrowUpRight aria-hidden="true" />
              </a>
            )}
          </div>
        </div>
        <figure className="hg-product-portrait hg-product-portrait--os">
          <Image
            src="/images/ai-recruiter-os-portrait-v2.jpg"
            alt="Ahmed Awad against a soft blue, mint and ivory studio background"
            width={1280}
            height={852}
            priority
            sizes="(max-width: 800px) 100vw, 44vw"
          />
        </figure>
      </section>
      <section className="hg-section hg-form-stage" id="ai-os-waitlist">
        <p className="hg-kicker">Research waitlist</p>
        <h2 className="hg-title">
          Which workflow should AI make more accountable?
        </h2>
        <p className="hg-body">
          Share one workflow and your current AI level. This is research for a
          future programme—not a launch promise.
        </p>
        <LeadForm
          kind="ai_os"
          sourceRoute="/ai-recruiter-os"
          submitLabel="Join the research waitlist"
        />
      </section>
    </article>
  );
}
