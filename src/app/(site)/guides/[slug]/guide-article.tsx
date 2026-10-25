import Link from "next/link";
import { GuideBlock } from "@/features/guides/types";
import { GuideBlockRenderer } from "@/app/guides/guide-renderer";
import { JsonLd, breadcrumbSchema, getSiteUrl } from "@/lib/seo";
import type { Guide } from "@/lib/db";

/**
 * Shared article view for the public (static/ISR) route and the dynamic staff
 * preview route. Pure rendering: no searchParams, cookies or data reads.
 */
export function GuideArticle({ guide, slug }: { guide: Guide; slug: string }) {
  // Parse structured blocks
  let blocks: GuideBlock[] = [];
  try {
    blocks = JSON.parse(guide.body) as GuideBlock[];
  } catch {
    blocks = [];
  }

  // Extract headings for Table of Contents
  const headings = blocks
    .filter((b): b is Extract<GuideBlock, { type: "heading" }> => b.type === "heading" && b.level === 2)
    .map((h) => ({
      id: h.anchor || h.text.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
      text: h.text,
    }));

  const breadcrumbs = [
    { name: "Home", path: "/" },
    { name: "Guides", path: "/guides" },
    { name: guide.title, path: `/guides/${slug}` },
  ];

  const formattedDate = guide.publishedAt
    ? new Date(guide.publishedAt).toLocaleDateString("en-US", {
        month: "short",
        year: "numeric",
      })
    : "Draft";

  const isPreview = guide.status !== "published";

  return (
    <div className="hg-managed-page">
      <JsonLd data={breadcrumbSchema(breadcrumbs)} />
      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@type": "Article",
          headline: guide.title,
          description: guide.excerpt || guide.metaDescription || "",
          datePublished: guide.publishedAt ? new Date(guide.publishedAt).toISOString() : undefined,
          dateModified: new Date(guide.updatedAt).toISOString(),
          author: {
            "@type": "Person",
            name: guide.author,
            url: new URL("/about", getSiteUrl()).toString(),
          },
          publisher: {
            "@type": "Organization",
            name: "Decoded Hiring",
            url: getSiteUrl().toString(),
          },
          mainEntityOfPage: {
            "@type": "WebPage",
            "@id": new URL(`/guides/${slug}`, getSiteUrl()).toString(),
          },
        }}
      />

      {/* Preview indicator banner (for authenticated staff) */}
      {isPreview && (
        <aside
          role="status"
          style={{
            background: "#fff3cd",
            borderBottom: "1px solid #ffeeba",
            color: "#856404",
            padding: "10px 20px",
            textAlign: "center",
            fontSize: "13px",
            fontWeight: 600,
          }}
        >
          PREVIEW MODE · This guide is currently a {guide.status.toUpperCase()} and is not publicly discoverable.
        </aside>
      )}

      {/* Breadcrumbs */}
      <div className="wrap" style={{ paddingBlock: "24px 8px" }}>
        <nav className="crumbs" aria-label="Breadcrumb">
          <Link href="/">Home</Link>
          <span className="sep">/</span>
          <Link href="/guides">Guides</Link>
          <span className="sep">/</span>
          <span>{guide.title}</span>
        </nav>
      </div>

      {/* 2-Column Stabilized Article Layout */}
      <div className="article-layout">
        {/* Sticky TOC rail on desktop */}
        {headings.length > 0 && (
          <aside className="toc-rail" aria-label="Inside this page">
            <p className="toc-title">INSIDE THIS PAGE</p>
            <ol>
              {headings.map((h) => (
                <li key={h.id}>
                  <a href={`#${h.id}`}>{h.text}</a>
                </li>
              ))}
            </ol>
          </aside>
        )}

        {/* Main Column */}
        <div className="article-main">
          <header className="article-hero">
            <span className="t-eyebrow tone-blue">
              {guide.category ? guide.category.toUpperCase() : "PUT IT INTO PRACTICE"}
            </span>
            <h1
              className="editorial-h2"
              style={{
                fontSize: "clamp(2.4rem, 1.4rem + 4vw, 4rem)",
                lineHeight: 1.05,
                marginTop: "16px",
              }}
            >
              {guide.title}
            </h1>
            {guide.excerpt && <p className="dek">{guide.excerpt}</p>}
            <div className="meta-line">
              <b>{guide.author}</b>
              <span>·</span>
              <time
                dateTime={guide.publishedAt ? new Date(guide.publishedAt).toISOString() : undefined}
              >
                Updated {formattedDate}
              </time>
              <span>·</span>
              <span className="mono">10 min read</span>
              {guide.category && (
                <>
                  <span>·</span>
                  <span>Category: {guide.category}</span>
                </>
              )}
            </div>
          </header>

          {/* Collapsible TOC on Mobile */}
          {headings.length > 0 && (
            <details className="toc-collapsible">
              <summary>On this page</summary>
              <ol>
                {headings.map((h) => (
                  <li key={`mob-${h.id}`}>
                    <a href={`#${h.id}`}>{h.text}</a>
                  </li>
                ))}
              </ol>
            </details>
          )}

          {/* Article Body */}
          <article className="article-body">
            <GuideBlockRenderer blocks={blocks} />
          </article>
        </div>
      </div>
    </div>
  );
}
