import Link from "next/link";
import { ContentBlockRenderer } from "@/components/publishing/ContentBlockRenderer";
import { ContentBlock, estimateReadingTime, isSafeMediaUrl } from "@/features/publishing/types";
import { JsonLd, breadcrumbSchema, buildContentJsonLd } from "@/lib/seo";
import type { Page } from "@/lib/db";

/**
 * Shared article view for the public (static/ISR) standard page route and the
 * dynamic staff preview route. Pure rendering: no searchParams, cookies or
 * data reads.
 */
export function StandardPageArticle({ page, slug }: { page: Page; slug: string }) {
  let blocks: ContentBlock[] = [];
  try {
    blocks = JSON.parse(page.body) as ContentBlock[];
  } catch {
    blocks = [];
  }

  const minutes = estimateReadingTime(blocks);

  const breadcrumbs = [
    { name: "Home", path: "/" },
    { name: page.title, path: `/${slug}` },
  ];

  const isPreview = page.status !== "published";

  return (
    <div className="hg-managed-page">
      <JsonLd data={breadcrumbSchema(breadcrumbs)} />
      <JsonLd
        data={buildContentJsonLd({
          schemaType: "Article",
          title: page.title,
          description: page.summary || page.metaDescription || "",
          path: `/${slug}`,
          author: "Decoded Editorial",
          datePublished: page.publishedAt ? new Date(page.publishedAt).toISOString() : undefined,
          dateModified: new Date(page.updatedAt).toISOString(),
        })}
      />

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
          PREVIEW MODE · This page is currently {page.status.toUpperCase()} and is not publicly discoverable.
        </aside>
      )}

      <div className="wrap" style={{ paddingBlock: "24px 8px" }}>
        <nav className="crumbs" aria-label="Breadcrumb">
          <Link href="/">Home</Link>
          <span className="sep">/</span>
          <span>{page.title}</span>
        </nav>
      </div>

      <div style={{ maxWidth: "720px", marginInline: "auto", padding: "0 var(--gutter) clamp(64px, 8vw, 120px)" }}>
        <header style={{ padding: "clamp(24px, 4vw, 48px) 0 32px" }}>
          <h1
            className="editorial-h2"
            style={{
              fontSize: "clamp(2rem, 1.3rem + 3vw, 3.2rem)",
              lineHeight: 1.1,
              marginTop: "16px",
            }}
          >
            {page.title}
          </h1>
          {page.summary && <p className="dek">{page.summary}</p>}
          <div className="meta-line">
            <span className="mono">{minutes} min read</span>
          </div>
        </header>

        {isSafeMediaUrl(page.coverImage) && (
          <figure style={{ margin: "0 0 32px" }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={page.coverImage ?? undefined}
              alt={page.title}
              style={{ width: "100%", height: "auto", borderRadius: "12px", display: "block" }}
            />
          </figure>
        )}

        <article className="article-body">
          <ContentBlockRenderer blocks={blocks} />
        </article>
      </div>
    </div>
  );
}
