import { ArrowUpRight, Check, LockKeyhole, Play } from "lucide-react";
import Image from "next/image";

import { publicMetadata } from "@/lib/seo";
import { PUBLIC_OFFER_SLUGS } from "@/features/offers/catalog";
import { resolveOfferPublicPresentation } from "@/features/offers/presentation";
import { getOfferBySlugForKind } from "@/features/offers/service";

export const dynamic = "force-dynamic";

export const metadata = publicMetadata({
  path: "/mission-01",
  title: "Mission 01: Super Recruiter | Ahmed Awad",
  description:
    "A private classroom for recruiters who want to build a complete, evidence-led recruitment operating mindset.",
});

export default async function MissionPage() {
  const offer = await getOfferBySlugForKind(
    PUBLIC_OFFER_SLUGS.mission01,
    "COURSE",
  );
  const offerPresentation = offer
    ? resolveOfferPublicPresentation(offer, {
        freeHref: "/login",
        freeLabel: "Create my free classroom",
        contactHref: "/contact?reason=mission-01",
        contactLabel: "Ask about Mission 01",
      })
    : null;

  const isUnavailable = Boolean(offer && !offerPresentation?.ctaHref);
  const accessBadge = offerPresentation?.badge ?? "100% FREE";

  return (
    <article className="hg-page is-active">
      <section className="hg-section hg-product-hero hg-blue hg-with-portrait hg-mission-hero">
        <div className="hg-product-hero-copy">
          <p className="hg-kicker">Private classroom · under three hours</p>
          <div className="hg-free-stamp">{accessBadge}</div>
          <h1 className="hg-product-title">
            Mission 01:
            <br />
            Super Recruiter
          </h1>
          <p className="hg-body">
            Stop treating recruitment as a chain of tasks. Learn to think from
            business need to evidence, recommendation and improvement.
          </p>
          <div className="hg-product-meta">
            <span>Arabic-led video</span>
            <span>English + Arabic subtitles</span>
            <span>Certificate at completion</span>
            <span>Account required</span>
          </div>
          <div className="hg-actions">
            {isUnavailable ? (
              <span className="hg-primary" aria-disabled="true">
                Currently unavailable
              </span>
            ) : (
              <a
                className="hg-primary"
                href={offerPresentation?.ctaHref ?? "/login"}
              >
                {offerPresentation?.ctaLabel ?? "Create my free classroom"}{" "}
                <ArrowUpRight aria-hidden="true" />
              </a>
            )}
            <a className="hg-secondary" href="#mission-route">
              Preview the first checkpoint
            </a>
          </div>
        </div>
        <figure className="hg-product-portrait hg-product-portrait--mission">
          <Image
            src="/images/mission-01-ahmed-v2-optimized.jpg"
            alt="Ahmed Awad welcoming learners into Mission 01"
            width={900}
            height={1124}
            priority
            sizes="(max-width: 800px) 100vw, 42vw"
          />
        </figure>
      </section>

      <section className="hg-section hg-mission-promise">
        <div>
          <Play aria-hidden="true" />
          <span>
            Short Arabic-led lessons
            <br />
            with English subtitles
          </span>
        </div>
        <div>
          <LockKeyhole aria-hidden="true" />
          <span>
            Your private classroom
            <br />
            remembers your progress
          </span>
        </div>
        <div>
          <Check aria-hidden="true" />
          <span>
            Complete the system
            <br />
            and unlock a certificate
          </span>
        </div>
      </section>

      <section className="hg-section hg-aha">
        <p className="hg-kicker">The AHA shift</p>
        <h2 className="hg-title">
          The work changes when you stop asking “what do I do next?”
        </h2>
        <div className="hg-aha-grid">
          <div className="hg-aha-step">
            <b>A · AUTHORITY</b>
            <h3>The complete system</h3>
            <p>
              Twelve years across agency, in-house and regional leadership
              distilled into one operating path.
            </p>
          </div>
          <div className="hg-aha-step">
            <b>H · HIDDEN INSIGHT</b>
            <h3>Activity is not progress</h3>
            <p>
              More sourcing, interviews or tools cannot repair a role that was
              never properly understood.
            </p>
          </div>
          <div className="hg-aha-step">
            <b>A · ACTION</b>
            <h3>Build while learning</h3>
            <p>
              Every mission produces an object you can use: a brief, target
              universe, scorecard, interview evidence and recommendation.
            </p>
          </div>
        </div>
      </section>

      <section className="hg-section hg-programme" id="mission-route">
        <p className="hg-kicker">Your route</p>
        <h2 className="hg-title">
          Five missions. One working recruitment system.
        </h2>
        <div className="hg-programme-list hg-mission-route-map">
          <div className="hg-programme-row">
            <b>01</b>
            <h3>Decode the role</h3>
            <p>
              Use the Five-Layer Discovery Framework to separate a vacancy
              request from the business problem behind it.
            </p>
          </div>
          <div className="hg-programme-row">
            <b>02</b>
            <h3>Read the market</h3>
            <p>
              Turn talent availability, hiring demand and company context into a
              realistic sourcing universe.
            </p>
          </div>
          <div className="hg-programme-row">
            <b>03</b>
            <h3>Build evidence</h3>
            <p>
              Create a competency scorecard before interviews turn into opinion
              contests.
            </p>
          </div>
          <div className="hg-programme-row">
            <b>04</b>
            <h3>Run the conversation</h3>
            <p>
              Apply ROCKET to uncover outcomes, competency evidence, risks,
              environment and terms.
            </p>
          </div>
          <div className="hg-programme-row">
            <b>05</b>
            <h3>Recommend with judgment</h3>
            <p>
              Use the Five-Point Quality Check to produce a recommendation
              people can challenge and trust.
            </p>
          </div>
        </div>
      </section>

      <section className="hg-section hg-fit">
        <p className="hg-kicker">The private classroom loop</p>
        <h2 className="hg-title">
          Learn. Apply. See progress. Invest in your own system.
        </h2>
        <div className="hg-fit-grid">
          <div className="hg-fit-column">
            <h3>What unlocks</h3>
            <ul>
              <li>Downloadable working files</li>
              <li>Progress saved across sessions</li>
              <li>Threaded classroom discussion</li>
              <li>Certificate after 100% content and 80% quiz score</li>
            </ul>
          </div>
          <div className="hg-fit-column">
            <h3>What stays honest</h3>
            <ul>
              <li>Unlimited quiz retries</li>
              <li>No fake urgency</li>
              <li>No surprise data collection</li>
              <li>YouTube is delivery infrastructure, not claimed DRM</li>
            </ul>
          </div>
        </div>
        <div className="hg-actions">
          {isUnavailable ? (
            <span className="hg-primary" aria-disabled="true">
              Currently unavailable
            </span>
          ) : (
            <a
              className="hg-primary"
              href={offerPresentation?.ctaHref ?? "/login"}
            >
              {offerPresentation?.ctaLabel ?? "Start Mission 01"}{" "}
              <ArrowUpRight aria-hidden="true" />
            </a>
          )}
        </div>
      </section>
    </article>
  );
}
