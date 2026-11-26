import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";
import { resolvePageRedirect } from "@/features/slug-redirects/service";
import { getPublicPageBySlug } from "@/features/pages/service";
import { publicMetadata } from "@/lib/seo";
import { StandardPageArticle } from "./standard-page-article";

// Static / ISR: this route reads no request data (no searchParams, cookies or
// headers), so the published page is prerendered on first request and served
// from the incremental cache. Studio actions call revalidatePath("/<slug>")
// on every lifecycle change, so publishes reflect immediately. The time-based
// revalidate is only a safety net. Staff previews of unpublished content
// (?preview=true) are rewritten in next.config.ts to the dynamic
// /preview/pages/[slug] route and never touch this cached page.
//
// Route precedence: static sibling routes (e.g. /about, /guides, /contact)
// always win over this dynamic segment — a reserved slug can never become a
// page (enforced in validation), so this route only serves governed slugs.
export const revalidate = 3600;

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
  const page = await getPublicPageBySlug(slug);

  if (!page) {
    return {};
  }

  const title = page.metaTitle || `${page.title} — Decoded Hiring`;
  const description =
    page.metaDescription || page.summary || "Information from Decoded Hiring.";

  const meta = publicMetadata({
    title,
    description,
    path: `/${slug}`,
    type: "article",
  });

  // noindex pages stay publicly readable but are excluded from indexing
  // (and from the sitemap).
  if (page.noindex) {
    return {
      ...meta,
      robots: {
        index: false,
        follow: true,
        googleBot: {
          index: false,
          follow: true,
          "max-image-preview": "large",
        },
      },
    };
  }

  return meta;
}

export default async function PublicStandardPage(props: PageProps) {
  const { slug } = await props.params;
  const page = await getPublicPageBySlug(slug);

  if (!page) {
    const target = await resolvePageRedirect(slug);
    if (target) permanentRedirect(target);
    notFound();
  }

  return <StandardPageArticle page={page} slug={slug} />;
}
