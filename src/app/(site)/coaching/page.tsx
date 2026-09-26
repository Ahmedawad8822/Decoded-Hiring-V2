import { ArrowDownRight, MoveUpRight, Route, ScanSearch } from "lucide-react";
import Image from "next/image";

import { CoachingDiagnostic } from "@/components/products/coaching-diagnostic";
import { LeadForm } from "@/features/leads/lead-form";
import { publicMetadata } from "@/lib/seo";
import { PUBLIC_OFFER_SLUGS } from "@/features/offers/catalog";
import { resolveOfferPublicPresentation } from "@/features/offers/presentation";
import { getOfferBySlug } from "@/features/offers/service";

export const dynamic = "force-dynamic";\n\nexport const metadata = publicMetadata({
  title: "Recruitment Decision Coaching | Ahmed Awad",
  description:
    "A private 60-minute decision room for a live recruitment, leadership or workflow challenge.",
  path: "/coaching",
});

export default async function CoachingPage() {
  const offer = await getOfferBySlug(PUBLIC_OFFER_SLUGS.coaching);
  const offerPresentation = offer
    ? resolveOfferPublicPresentation(offer, {
        freeHref: "#hg-coaching-brief",
        freeLabel: "Open a decision brief",
        contactHref: "#hg-coaching-brief",
        contactLabel: "Open a decision brief",
      })
    : null;

  return (
    <article className="hg-page is-active">
      <section className="hg-section hg-product-hero hg-with-portrait hg-coaching-hero">
        <div className="hg-product-hero-copy">
          <p className="hg-kicker">Private decision room · 60 minutes</p>
          <h1 className="hg-product-title">
            Untangle the hiring decision keeping you stuck.
          </h1>
          <p className="hg-body">
            Bring one live case—not a polished presentation. Ahmed helps you
            separate signal from noise, expose the decision beneath the symptoms
            and leave with a practical next move.
          </p>
          <div className="hg-product-meta">
            <span>One live case</span>
            <span>Google Meet</span>
            <span>Decision map included</span>
            {offerPresentation?.priceLabel && <span>{offerPresentation.priceLabel}</span>}
          </div>
          <div className="hg-actions">
            {offer && !offerPresentation?.ctaHref ? (
              <span className="hg-primary" aria-disabled="true">
                Currently unavailable
              </span>
            ) : (
              <a
                className="hg-primary"
                href={offerPresentation?.ctaHref ?? "#hg-coaching-brief"}
              >
                {offerPresentation?.ctaLabel ?? "Open a decision brief"}{" "}
                <ArrowDownRight aria-hidden="true" />
              </a>
            )}
          </div>
        </div>
        <figure className="hg-product-portrait hg-product-portrait--coaching">
          <Image
            src="/images/ahmed-coaching-conversation-cinematic.jpg"
            alt="Ahmed Awad listening during a focused coaching conversation"
            width={1280}
            height={853}
            priority
            sizes="(max-width: 800px) 100vw, 42vw"
          />
        </figure>
      </section>

      <section className="hg-section hg-coaching-diagnostic">
        <div className="hg-coaching-diagnostic-head">
          <div>
            <p className="hg-kicker">Find the decision beneath the symptom</p>
            <h2 className="hg-title">
              Where is the hiring system creating friction?
            </h2>
          </div>
          <p>
            Choose the closest situation. The board reveals how the conversation
            moves from a visible symptom to a decision you can act on.
          </p>
        </div>
        <CoachingDiagnostic />
      </section>

      <section className="hg-section hg-coaching-workbench">
        <div className="hg-coaching-workbench-copy">
          <p className="hg-kicker">A working room, not a motivational call</p>
          <h2 className="hg-title">
            By minute 60, the mess should fit on one board.
          </h2>
          <p className="hg-body">
            We do not try to solve your entire career or recruitment function.
            We make one consequential decision clearer, testable and owned.
          </p>
          <div className="hg-coaching-principle">
            <ScanSearch aria-hidden="true" />
            <span>
              <b>12 years of context, used carefully.</b> Agency speed, in-house
              complexity and regional TA leadership inform the questions—not a
              recycled playbook.
            </span>
          </div>
        </div>

        <div
          className="hg-workboard"
          aria-label="Example coaching decision board"
        >
          <div className="hg-workboard-head">
            <span>LIVE CASE / WORKING CANVAS</span>
            <MoveUpRight aria-hidden="true" />
          </div>
          <div className="hg-workboard-note hg-note-one">
            <b>01 · DECISION</b>
            <strong>What must become clear?</strong>
            <p>One sentence. One owner. One useful boundary.</p>
          </div>
          <div className="hg-workboard-note hg-note-two">
            <b>02 · EVIDENCE</b>
            <strong>What do we know?</strong>
            <p>Separate signals, assumptions and missing proof.</p>
          </div>
          <div className="hg-workboard-note hg-note-three">
            <b>03 · OPTIONS</b>
            <strong>What could we do?</strong>
            <p>Compare trade-offs instead of collecting advice.</p>
          </div>
          <div className="hg-workboard-note hg-note-four">
            <b>04 · MOVE</b>
            <strong>What happens next?</strong>
            <p>Action, owner, measure and check-in.</p>
          </div>
          <svg
            className="hg-workboard-line"
            viewBox="0 0 560 380"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <path d="M145 105 C260 42 318 52 408 112 S430 266 302 292 S116 262 155 182" />
          </svg>
          <div className="hg-workboard-center">
            <Route aria-hidden="true" />
            <span>
              Decision
              <br />
              map
            </span>
          </div>
        </div>
      </section>

      <section className="hg-section hg-coaching-brief" id="hg-coaching-brief">
        <div className="hg-coaching-brief-copy">
          <p className="hg-kicker">Start before the meeting starts</p>
          <h2 className="hg-title">Send the case, not your life story.</h2>
          <p className="hg-body">
            A useful brief gives Ahmed enough context to understand the decision
            and reply with the next useful step.
          </p>
          <div className="hg-brief-prompts">
            <span>What is happening now?</span>
            <span>What decision feels blocked?</span>
            <span>What would useful clarity change?</span>
          </div>
        </div>
        <div className="hg-case-sheet">
          <div className="hg-case-sheet-head">
            <span>DECISION BRIEF</span>
            <b>01 / PRIVATE CASE</b>
          </div>
          <LeadForm
            className="hg-case-sheet-grid"
            kind="coaching"
            sourceRoute="/coaching"
            submitLabel="Send my decision brief"
          />
          <p className="hg-route-note">
            Your brief is used to understand the situation and respond with the
            most useful next step.
          </p>
        </div>
      </section>
    </article>
  );
}
