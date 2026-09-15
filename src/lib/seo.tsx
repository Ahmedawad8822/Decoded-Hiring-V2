import type { Metadata } from "next";

export const siteName = "Decoded Hiring";
export const siteDescription =
  "Recruitment strategy, practical learning and human-led AI systems from Ahmed Awad.";

export function getSiteUrl() {
  return new URL(
    process.env.NEXT_PUBLIC_SITE_URL ?? "https://decodedhiring.com",
  );
}

export function publicMetadata({
  title,
  description,
  path,
  type = "website",
}: {
  title: string;
  description: string;
  path: string;
  type?: "website" | "article";
}): Metadata {
  const canonical = new URL(path, getSiteUrl()).toString();

  return {
    title,
    description,
    alternates: { canonical },
    openGraph: {
      title,
      description,
      url: canonical,
      siteName,
      type,
      locale: "en_US",
      images: [{ url: "/api/og", width: 1200, height: 630 }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: ["/api/og"],
    },
  };
}

export function JsonLd({ data }: { data: Record<string, unknown> }) {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{
        __html: JSON.stringify(data).replace(/</g, "\\u003c"),
      }}
    />
  );
}

export function breadcrumbSchema(items: Array<{ name: string; path: string }>) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: item.name,
      item: new URL(item.path, getSiteUrl()).toString(),
    })),
  };
}

// ============================================================================
// Shared structured-data builder (Mission 05 extraction)
// ----------------------------------------------------------------------------
// Guides use schema type "Article"; Field Notes use "BlogPosting".
// Both share title/description/canonical/author/dates. Guides deliberately
// retain their existing inline Article payload (no refactor risk); new
// Field Notes pages build through this helper.
// ============================================================================

export function buildContentJsonLd({
  schemaType,
  title,
  description,
  path,
  author,
  datePublished,
  dateModified,
}: {
  schemaType: "Article" | "BlogPosting";
  title: string;
  description: string;
  path: string;
  author: string;
  datePublished?: string;
  dateModified: string;
}): Record<string, unknown> {
  const base = getSiteUrl().toString().replace(/\/$/, "");
  return {
    "@context": "https://schema.org",
    "@type": schemaType,
    headline: title,
    description,
    datePublished,
    dateModified,
    author: {
      "@type": "Person",
      name: author,
      url: `${base}/about`,
    },
    publisher: {
      "@type": "Organization",
      name: siteName,
      url: `${base}/`,
    },
    mainEntityOfPage: {
      "@type": "WebPage",
      "@id": `${base}${path}`,
    },
  };
}
