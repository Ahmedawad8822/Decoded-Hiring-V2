import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";
import { resolveGuideRedirect } from "@/features/slug-redirects/service";
import { getPublicGuideBySlug } from "@/features/guides/service";
import { publicMetadata } from "@/lib/seo";
import { GuideArticle } from "./guide-article";

// Static / ISR: this route reads no request data (no searchParams, cookies or
// headers), so the published article is prerendered on first request and
// served from the incremental cache. Studio actions call
// revalidatePath("/guides/<slug>") on every publish, unpublish, archive,
// edit and slug rename, so content still reflects publishes immediately. The
// time-based revalidate is only a safety net for any write path that forgets
// to revalidate. Staff previews of unpublished content (?preview=true) are
// rewritten in next.config.ts to the dynamic /preview/guides/[slug]
// route and never touch this cached page.
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
  const guide = await getPublicGuideBySlug(slug);

  if (!guide) {
    return {};
  }

  const title = guide.metaTitle || `${guide.title} — Decoded Hiring Guide`;
  const description =
    guide.metaDescription || guide.excerpt || "Strategic recruitment guide from Ahmed Awad.";

  return publicMetadata({
    title,
    description,
    path: `/guides/${slug}`,
    type: "article",
  });
}

export default async function PublicGuideDetailPage(props: PageProps) {
  const { slug } = await props.params;
  const guide = await getPublicGuideBySlug(slug);

  if (!guide) {
    const target = await resolveGuideRedirect(slug);
    if (target) permanentRedirect(target);
    notFound();
  }

  return <GuideArticle guide={guide} slug={slug} />;
}
