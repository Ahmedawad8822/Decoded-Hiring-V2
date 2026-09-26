import Link from "next/link";
import { ArrowUpRight, Bot, Compass, MessageSquare, Users } from "lucide-react";
import { createElement } from "react";

import { Breadcrumbs } from "@/components/site/breadcrumbs";
import { breadcrumbSchema, JsonLd, publicMetadata } from "@/lib/seo";

export const metadata = publicMetadata({
  path: "/programmes",
  title: "Recruitment Programmes | Decoded Hiring",
  description:
    "Choose between the Mission 01 classroom, team workshop, focused coaching or the AI Recruiter OS research list.",
});

const programmes = [
  {
    marker: "Start here · recommended",
    title: "Mission 01: Super Recruiter",
    description:
      "Change how you think about recruitment, then turn that thinking into a repeatable system.",
    detail: "Private classroom · under three hours",
    href: "/mission-01" as const,
    cta: "Enter Mission 01",
    tone: "blue",
    icon: Compass,
    signal: "BUILD YOUR OPERATING MINDSET",
  },
  {
    marker: "For teams",
    title: "AI-Powered Recruitment Workshop",
    description:
      "Build one evidence-to-recommendation standard across a real talent acquisition team.",
    detail: "Four practical days · twenty modules",
    href: "/workshop" as const,
    cta: "Explore the workshop",
    tone: "mint",
    icon: Users,
    signal: "ALIGN A TEAM AROUND ONE SYSTEM",
  },
  {
    marker: "For one live problem",
    title: "Recruitment Strategy Coaching",
    description:
      "Work through a difficult recruitment, leadership or career decision in a focused session.",
    detail: "60-minute Google Meet · reviewed personally",
    href: "/coaching" as const,
    cta: "Bring the problem",
    tone: "coral",
    icon: MessageSquare,
    signal: "UNTANGLE ONE CONSEQUENTIAL DECISION",
  },
  {
    marker: "Research list",
    title: "AI Recruiter OS",
    description:
      "Help shape the future programme for recruiters building agents, memory and guardrails.",
    detail: "In development · waitlist only",
    href: "/ai-recruiter-os" as const,
    cta: "Join the research list",
    tone: "paper",
    icon: Bot,
    signal: "HELP DESIGN WHAT COMES NEXT",
  },
];

export default function ProgrammesPage() {
  return (
    <article className="hg-page is-active hg-authority-page">
      <JsonLd
        data={breadcrumbSchema([
          { name: "Home", path: "/" },
          { name: "Programmes", path: "/programmes" },
        ])}
      />
      <section className="hg-section hg-directory-hero hg-programmes-hero">
        <Breadcrumbs
          items={[{ label: "Home", href: "/" }, { label: "Programmes" }]}
        />
        <p className="hg-kicker">Choose your level of change</p>
        <h1 className="hg-display">
          One field. Four useful entry points.
        </h1>
        <p className="hg-body">
          Start with a focused mission, bring a live problem to a private
          session, build a team standard through the workshop or join the
          research list for AI Recruiter OS.
        </p>
        <div className="hg-programme-orbit" aria-hidden="true">
          <span>LEARN</span>
          <span>ALIGN</span>
          <span>DECIDE</span>
          <span>BUILD</span>
          <b>
            Choose by
            <br />
            the change
            <br />
            you need
          </b>
        </div>
      </section>
      <section className="hg-programme-directory" aria-label="Programmes">
        {programmes.map((programme, index) => (
          <article
            className={`hg-programme-card hg-programme-card--${programme.tone}`}
            key={programme.title}
          >
            <div className="hg-programme-index">
              <span>0{index + 1}</span>
              {createElement(programme.icon, { "aria-hidden": true })}
            </div>
            <div>
              <p className="hg-kicker">{programme.marker}</p>
              <h2>{programme.title}</h2>
              <p>{programme.description}</p>
              <strong className="hg-programme-signal">
                {programme.signal}
              </strong>
            </div>
            <div className="hg-programme-card-action">
              <small>{programme.detail}</small>
              <Link href={programme.href}>
                {programme.cta} <ArrowUpRight aria-hidden="true" />
              </Link>
            </div>
          </article>
        ))}
      </section>
    </article>
  );
}
