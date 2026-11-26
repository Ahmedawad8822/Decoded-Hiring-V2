import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { JsonLd, breadcrumbSchema, publicMetadata } from "@/lib/seo";
import {
  resolvePublicLandingPage,
  resolveTargetSummary,
  type LandingTargetSummary,
} from "@/features/landing-pages/service";
import type { LandingPage } from "@/lib/db";
import type { LandingPageSection } from "@/features/landing-pages/types";
import { LandingLeadBlock, LandingPageTracker, TrackedLandingCta } from "./landing-page-client";

// ============================================================================
// PUBLIC LANDING PAGE /go/[slug] (§4 PAGE-TYPE-SPECS)
// ----------------------------------------------------------------------------
// Static / ISR: the route reads no request data (no searchParams, cookies or
// headers), so a live campaign page is prerendered on first request and served
// from the incremental cache. UTMs are read CLIENT-SIDE (see
// landing-page-client.tsx) and only appended to CTA hrefs + lead fields, so
// the page itself stays cacheable. Studio actions revalidate /go/<slug> on
// every lifecycle transition.
//
// Schedule boundaries vs cache: revalidate = 60 bounds the stale window to
// at most 60 seconds at both ends. Before starts_at the render 404s; after
// ends_at the render switches server-side to the ended state (SEO-safe,
// unlike a client-only swap) until archiveEndedCampaigns moves the row to
// archived — a second, independent backstop.
// ============================================================================
export const revalidate = 60;

// No slugs are known at build time (the build machine's D1 is not the
// production D1); an empty list makes the route ISR instead of dynamic.
export function generateStaticParams() {
  return [];
}

interface PageProps {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata(props: PageProps): Promise<Metadata> {
  const { slug } = await props.params;
  const resolved = await resolvePublicLandingPage(slug);
  if (!resolved) return {};
  const { page } = resolved;
  const title = page.seoTitle || `${page.title} — Decoded Hiring`;
  const description =
    page.seoDescription || `A time-limited Decoded Hiring campaign: ${page.title}.`;
  const base = publicMetadata({ title, description, path: `/go/${slug}` });
  // noindex defaults to true: campaign pages stay out of search unless an
  // editor explicitly opts in.
  if (page.noindex) {
    return { ...base, robots: { index: false, follow: true } };
  }
  return base;
}

function parseSections(page: LandingPage): LandingPageSection[] {
  try {
    const parsed: unknown = JSON.parse(page.sections);
    return Array.isArray(parsed) ? (parsed as LandingPageSection[]) : [];
  } catch {
    return [];
  }
}

export default async function PublicLandingPage(props: PageProps) {
  const { slug } = await props.params;
  const resolved = await resolvePublicLandingPage(slug);
  if (!resolved) notFound();
  const { page, scheduleState } = resolved;
  const target = await resolveTargetSummary(page);
  const ctaHref = target?.href ?? "/contact";

  const breadcrumbs = [
    { name: "Home", path: "/" },
    { name: page.title, path: `/go/${slug}` },
  ];

  if (scheduleState === "ended") {
    return (
      <div className="hg-managed-page">
        <JsonLd data={breadcrumbSchema(breadcrumbs)} />
        <div className="wrap" style={{ paddingBlock: "64px", maxWidth: "640px" }}>
          <p className="hg-kicker">{page.campaignName}</p>
          <h1>This campaign has ended</h1>
          <p>
            {page.title} is no longer running, but the programme behind it is still here.
          </p>
          <p>
            <Link className="hg-primary" href={ctaHref}>
              Continue to {target?.title ?? "Decoded Hiring"}
            </Link>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="hg-managed-page">
      <JsonLd data={breadcrumbSchema(breadcrumbs)} />
      <LandingPageTracker pageId={page.id} slug={page.slug} />
      <LandingPageArticle page={page} target={target} ctaHref={ctaHref} />
    </div>
  );
}

function LandingPageArticle({
  page,
  target,
  ctaHref,
}: {
  page: LandingPage;
  target: LandingTargetSummary | null;
  ctaHref: string;
}) {
  const sections = parseSections(page);
  return (
    <article>
      <div className="wrap" style={{ paddingBlock: "48px 16px", maxWidth: "720px" }}>
        <p className="hg-kicker">{page.campaignName}</p>
        <h1 style={{ fontSize: "clamp(2rem, 1.2rem + 4vw, 3.4rem)", lineHeight: 1.05 }}>
          {page.title}
        </h1>
        <p style={{ marginTop: "16px" }}>
          <TrackedLandingCta pageId={page.id} slug={page.slug} href={ctaHref} surface="hero">
            {page.ctaLabel}
          </TrackedLandingCta>
        </p>
      </div>
      {sections.map((section) => (
        <LandingSection
          key={section.id}
          section={section}
          page={page}
          target={target}
          ctaHref={ctaHref}
        />
      ))}
    </article>
  );
}

function LandingSection({
  section,
  page,
  target,
  ctaHref,
}: {
  section: LandingPageSection;
  page: LandingPage;
  target: LandingTargetSummary | null;
  ctaHref: string;
}) {
  switch (section.type) {
    case "hero":
      return (
        <section className="wrap" style={{ paddingBlock: "24px", maxWidth: "720px" }}>
          {section.kicker && <p className="hg-kicker">{section.kicker}</p>}
          <h2>{section.heading}</h2>
          {section.subheading && <p>{section.subheading}</p>}
        </section>
      );
    case "problem":
      return (
        <section className="wrap" style={{ paddingBlock: "24px", maxWidth: "720px" }}>
          <h2>{section.heading}</h2>
          <ul>
            {section.points.map((point, index) => (
              <li key={index}>{point}</li>
            ))}
          </ul>
        </section>
      );
    case "benefits":
      return (
        <section className="wrap" style={{ paddingBlock: "24px", maxWidth: "720px" }}>
          <h2>{section.heading}</h2>
          <ul>
            {section.items.map((item, index) => (
              <li key={index}>
                <b>{item.title}</b> — {item.text}
              </li>
            ))}
          </ul>
        </section>
      );
    case "quote":
      return (
        <section className="wrap" style={{ paddingBlock: "24px", maxWidth: "720px" }}>
          <blockquote>
            <p>{section.text}</p>
            {section.attribution && <cite>— {section.attribution}</cite>}
          </blockquote>
        </section>
      );
    case "target_summary":
      if (!target) return null;
      return (
        <section className="wrap" style={{ paddingBlock: "24px", maxWidth: "720px" }}>
          {section.heading && <h2>{section.heading}</h2>}
          <h3>{target.title}</h3>
          {target.badge && <p><span>{target.badge}</span>{target.priceLabel ? ` · ${target.priceLabel}` : ""}</p>}
          {target.description && <p>{target.description}</p>}
          {target.outcomes.length > 0 && (
            <ul>
              {target.outcomes.map((outcome, index) => (
                <li key={index}>{outcome}</li>
              ))}
            </ul>
          )}
          <p>
            <TrackedLandingCta pageId={page.id} slug={page.slug} href={ctaHref} surface="target_summary">
              {page.ctaLabel}
            </TrackedLandingCta>
          </p>
        </section>
      );
    case "faq":
      return (
        <section className="wrap" style={{ paddingBlock: "24px", maxWidth: "720px" }}>
          {section.heading && <h2>{section.heading}</h2>}
          {section.items.map((item, index) => (
            <details key={index}>
              <summary>{item.q}</summary>
              <p>{item.a}</p>
            </details>
          ))}
        </section>
      );
    case "cta_band":
      return (
        <section className="wrap" style={{ paddingBlock: "32px", maxWidth: "720px" }}>
          <h2>{section.heading}</h2>
          {section.text && <p>{section.text}</p>}
          <p>
            <TrackedLandingCta pageId={page.id} slug={page.slug} href={ctaHref} surface="cta_band">
              {section.ctaLabel ?? page.ctaLabel}
            </TrackedLandingCta>
          </p>
        </section>
      );
    case "lead_form":
      return (
        <section className="wrap" style={{ paddingBlock: "24px", maxWidth: "720px" }}>
          <h2>{section.heading}</h2>
          {section.text && <p>{section.text}</p>}
          <Suspense fallback={<p>Loading the form…</p>}>
            <LandingLeadBlock slug={page.slug} />
          </Suspense>
        </section>
      );
  }
}
