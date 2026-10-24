import {
  ArrowUpRight,
  BadgeCheck,
  BrainCircuit,
  Database,
  FileCheck2,
  Map,
  ScanSearch,
  ShieldCheck,
} from "lucide-react";
import Image from "next/image";
import { Fragment } from "react";

import { HiringScenarioLab } from "@/components/home/hiring-scenario-lab";
import { MasterStrategyProcess } from "@/components/home/master-strategy-process";
import { TestimonialRail } from "@/components/home/testimonial-rail";
import { WorkshopDays } from "@/components/home/workshop-days";
import Link from "next/link";

import { defaultHomeSections, type HomeSection } from "./homepage-model";

function HomeBlock({
  section,
  hasStrategy,
}: {
  section: HomeSection;
  hasStrategy: boolean;
}) {
  const copy = section;
  switch (section.kind) {
    case "hero":
      return (
        <section className="hg-section hg-hero">
          <div className="hg-hero-copy">
            <p className="hg-kicker">
              {copy.kicker || <> 12 years inside the hiring system </>}
            </p>
            <h1 className="hg-display">
              {copy.title || (
                <>
                  Hiring shouldn’t be a <em>guessing game.</em>
                </>
              )}
            </h1>
            <p className="hg-body">
              {copy.body || (
                <>
                  I’m Ahmed Awad. I help recruiters and talent leaders turn
                  hiring from scattered activity into a system they can see,
                  question and improve.
                </>
              )}
            </p>
            <div className="hg-actions">
              <Link className="hg-primary" href={copy.href || "/login"}>
                {copy.buttonLabel || (
                  <>
                    Start Mission 01 <ArrowUpRight aria-hidden="true" />
                  </>
                )}
              </Link>
              <a
                className="hg-secondary"
                href={hasStrategy ? "#strategy" : "/programmes"}
              >
                Explore the system
              </a>
            </div>
          </div>
          <div
            className="hg-hero-aside"
            aria-label="Ahmed Awad portrait with system signals behind him"
          >
            <div className="hg-orbits" aria-hidden="true">
              <span className="hg-orbit" />
              <span className="hg-orbit" />
              <span className="hg-orbit" />
            </div>
            <div className="hg-portrait-wrap">
              <Image
                src={section.imageSrc || "/images/ahmed-awad-studio-source.webp"}
                alt="Studio portrait of Ahmed Awad"
                fill
                priority
                unoptimized={Boolean(section.imageSrc)}
                sizes="(max-width: 860px) 90vw, 42vw"
              />
            </div>
            <div className="hg-stamp">
              Agency → in-house → regional TA leadership
            </div>
          </div>
        </section>
      );
    case "proof":
      return (
        <div className="hg-proof-strip" aria-label="Experience snapshot">
          <div className="hg-proof-cell">
            <strong>12 years</strong>
            <span>across agency, in-house and leadership</span>
          </div>
          <div className="hg-proof-cell">
            <strong>Middle East</strong>
            <span>built for Egypt and the Gulf</span>
          </div>
          <div className="hg-proof-cell">
            <strong>Human + AI</strong>
            <span>technology with recruitment judgment</span>
          </div>
        </div>
      );
    case "principle":
      return <MasterStrategyProcess />;
    case "paths":
      return (
        <section className="hg-section hg-paths">
          <p className="hg-kicker">Choose your entry point</p>
          <h2 className="hg-title">One field. Three different problems.</h2>
          <div className="hg-path-grid">
            <div className="hg-path">
              <span>Build</span>
              <h3>I need stronger foundations.</h3>
              <p>
                Start with Mission 01 and build a complete recruitment operating
                mindset.
              </p>
              <Link className="hg-path-action" href="/login">
                Start Mission 01 <ArrowUpRight aria-hidden="true" />
              </Link>
            </div>
            <div className="hg-path">
              <span>Lead</span>
              <h3>My team needs a shared system.</h3>
              <p>
                Bring the AI-Powered Recruitment Workshop into a real team
                context.
              </p>
              <Link className="hg-path-action" href="/workshop">
                Explore the workshop <ArrowUpRight aria-hidden="true" />
              </Link>
            </div>
            <div className="hg-path">
              <span>Transform</span>
              <h3>I need to rethink the workflow.</h3>
              <p>
                Use a focused conversation today or help shape AI Recruiter OS
                for tomorrow.
              </p>
              <Link className="hg-path-action" href="/coaching">
                Tell me what you’re solving <ArrowUpRight aria-hidden="true" />
              </Link>
            </div>
          </div>
        </section>
      );
    case "lab":
      return <HiringScenarioLab />;
    case "mission":
      return (
        <section
          className="hg-section hg-product-band hg-mission"
          id="mission-01"
        >
          <div className="hg-mission-copy">
            <p className="hg-kicker">
              {copy.kicker || <> Mission 01 · Private classroom </>}
            </p>
            <div className="hg-free-statement" aria-label="100 percent free">
              <span>100%</span>
              <strong>FREE</strong>
            </div>
            <h2 className="hg-mission-name">
              {copy.title || <> Mission 01 · Super Recruiter </>}
            </h2>
            <p className="hg-body">
              {copy.body || (
                <>
                  <strong>Become a super recruiter.</strong> Change how you
                  think about hiring, then turn that thinking into a repeatable
                  system.
                </>
              )}
            </p>
            <div className="hg-free-note">
              <BadgeCheck aria-hidden="true" /> No payment. Create your account
              and enter the classroom.
            </div>
            <div className="hg-actions">
              <Link className="hg-primary" href={copy.href || "/login"}>
                {copy.buttonLabel || (
                  <>
                    Start learning free <ArrowUpRight aria-hidden="true" />
                  </>
                )}
              </Link>
            </div>
          </div>
          <div
            className="hg-product-visual hg-mission-route"
            aria-label="Five missions"
          >
            <div>
              <b>01</b>
              <span>Decode the role</span>
              <small>Role brief</small>
            </div>
            <div>
              <b>02</b>
              <span>Read the market</span>
              <small>Target universe</small>
            </div>
            <div>
              <b>03</b>
              <span>Build evidence</span>
              <small>Scorecard</small>
            </div>
            <div>
              <b>04</b>
              <span>Run the conversation</span>
              <small>ROCKET</small>
            </div>
            <div>
              <b>05</b>
              <span>Recommend with judgment</span>
              <small>Quality check</small>
            </div>
          </div>
        </section>
      );
    case "workshop":
      return (
        <section
          className="hg-section hg-product-band hg-workshop"
          id="workshop"
        >
          <div>
            <p className="hg-kicker">
              {copy.kicker || <> For teams and open cohorts </>}
            </p>
            <h2 className="hg-product-title">
              {copy.title || (
                <>
                  The
                  <br />
                  Workshop
                </>
              )}
            </h2>
            <p className="hg-body">
              {copy.body || (
                <>
                  Four practical days. Twenty modules. One
                  evidence-to-recommendation operating system adapted to your
                  hiring reality.
                </>
              )}
            </p>
            <div className="hg-actions">
              <Link className="hg-primary" href={copy.href || "/workshop"}>
                {copy.buttonLabel || (
                  <>
                    Bring it to your team <ArrowUpRight aria-hidden="true" />
                  </>
                )}
              </Link>
            </div>
          </div>
          <WorkshopDays />
        </section>
      );
    case "coaching":
      return (
        <section
          className="hg-section hg-product-band hg-coaching"
          id="coaching"
        >
          <div>
            <p className="hg-kicker">
              {copy.kicker || <> A focused working session </>}
            </p>
            <h2 className="hg-product-title">
              {copy.title || (
                <>
                  Bring the
                  <br />
                  problem.
                </>
              )}
            </h2>
            <p className="hg-body">
              {copy.body || (
                <>
                  A 60-minute Google Meet for one live hiring, career or
                  recruitment-system challenge. Request-only, manually reviewed.
                </>
              )}
            </p>
            <div className="hg-actions">
              <Link className="hg-primary" href={copy.href || "/coaching"}>
                {copy.buttonLabel || (
                  <>
                    Tell me what you’re solving{" "}
                    <ArrowUpRight aria-hidden="true" />
                  </>
                )}
              </Link>
            </div>
          </div>
          <div className="hg-product-visual hg-problem-prompts">
            <div className="hg-problem-card">
              <b>01</b>
              <span>Clarify</span>
              <strong>“The role is still unclear.”</strong>
              <ArrowUpRight aria-hidden="true" />
            </div>
            <div className="hg-problem-card">
              <b>02</b>
              <span>Interrogate</span>
              <strong>“The pipeline is active, but weak.”</strong>
              <ArrowUpRight aria-hidden="true" />
            </div>
            <div className="hg-problem-card">
              <b>03</b>
              <span>Redesign</span>
              <strong>
                “The team is busy, but the system is not improving.”
              </strong>
              <ArrowUpRight aria-hidden="true" />
            </div>
            <div className="hg-session-outcome">
              <b>60 min</b>
              <span>One live problem → one practical action path</span>
            </div>
          </div>
        </section>
      );
    case "os":
      return (
        <section
          className="hg-section hg-product-band hg-os"
          id="ai-recruiter-os"
        >
          <div>
            <p className="hg-kicker">{copy.kicker || <> In development </>}</p>
            <h2 className="hg-product-title">
              {copy.title || (
                <>
                  AI
                  <br />
                  Recruiter OS
                </>
              )}
            </h2>
            <p className="hg-body">
              {copy.body || (
                <>
                  The future advanced programme: build AI agents and workflows
                  that support recruitment judgment across the process. Join the
                  research waitlist.
                </>
              )}
            </p>
            <div className="hg-actions">
              <Link
                className="hg-primary"
                href={copy.href || "/ai-recruiter-os"}
              >
                {copy.buttonLabel || (
                  <>
                    Help shape the OS <ArrowUpRight aria-hidden="true" />
                  </>
                )}
              </Link>
            </div>
          </div>
          <div className="hg-product-visual hg-os-shell">
            <div className="hg-os-head">
              <span>Capability map</span>
              <small>Human-controlled · system-aware</small>
            </div>
            <div className="hg-os-map">
              <span className="hg-os-ring" aria-hidden="true" />
              <span className="hg-os-core">
                <BrainCircuit aria-hidden="true" /> AI Recruiter
                <br />
                OS
              </span>
              <span className="hg-os-skill" data-os-skill="discovery">
                <ScanSearch aria-hidden="true" />
                <span>Discovery agent</span>
              </span>
              <span className="hg-os-skill" data-os-skill="market">
                <Map aria-hidden="true" />
                <span>Market mapper</span>
              </span>
              <span className="hg-os-skill" data-os-skill="evidence">
                <FileCheck2 aria-hidden="true" />
                <span>Evidence copilot</span>
              </span>
              <span className="hg-os-skill" data-os-skill="quality">
                <ShieldCheck aria-hidden="true" />
                <span>Quality guardrail</span>
              </span>
              <span className="hg-os-skill" data-os-skill="memory">
                <Database aria-hidden="true" />
                <span>Workflow memory</span>
              </span>
            </div>
            <div className="hg-os-foot">
              <span>Context → Memory → Tools → Review</span>
              <b>Waitlist research</b>
            </div>
          </div>
        </section>
      );
    case "testimonials":
      return <TestimonialRail />;
    case "contact":
      return (
        <section className="hg-section hg-final" id="contact">
          <p className="hg-kicker">
            {copy.kicker || <> Your next useful move </>}
          </p>
          <h2 className="hg-title">
            {copy.title || (
              <>Build the skill. Fix the system. Start the conversation.</>
            )}
          </h2>
          <div className="hg-actions">
            <Link className="hg-primary" href={copy.href || "/login"}>
              {copy.buttonLabel || <>Start free</>}
            </Link>
            <Link className="hg-secondary" href="/workshop">
              Explore the workshop
            </Link>
            <Link className="hg-secondary" href="/contact">
              Get in touch
            </Link>
          </div>
        </section>
      );
    case "callout":
      return (
        <section className="hg-section hg-paths" id={section.key}>
          <p className="hg-kicker">{copy.kicker}</p>
          <h2 className="hg-title">{copy.title}</h2>
          <p className="hg-body">{copy.body}</p>
          <div className="hg-actions">
            <Link className="hg-primary" href={copy.href}>
              {copy.buttonLabel}
              <ArrowUpRight aria-hidden="true" />
            </Link>
          </div>
        </section>
      );
  }
}
export function ApprovedHomepage({
  sections = defaultHomeSections,
  managedProgrammes = [],
}: {
  sections?: HomeSection[];
  managedProgrammes?: {
    label: string;
    path: string;
    presentationId: string;
  }[];
}) {
  const visibleSections = sections.filter((section) => section.enabled);
  return (
    <article className="hg-page is-active">
      {visibleSections.map((section) => (
        <Fragment key={section.key}>
          {section.kind === "contact" && managedProgrammes.length ? (
            <section className="hg-section dh-home-programmes">
              <p className="hg-kicker">New from the Studio</p>
              <h2 className="hg-title">
                Choose the programme that fits the change.
              </h2>
              <div>
                {managedProgrammes.map((programme, index) => (
                  <Link key={programme.presentationId} href={programme.path}>
                    <span>{String(index + 1).padStart(2, "0")}</span>
                    <strong>{programme.label}</strong>
                    <ArrowUpRight aria-hidden="true" />
                  </Link>
                ))}
              </div>
            </section>
          ) : null}
          <HomeBlock
            section={section}
            hasStrategy={sections.some(
              (s) => s.kind === "principle" && s.enabled,
            )}
          />
        </Fragment>
      ))}
    </article>
  );
}
