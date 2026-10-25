import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";
import { resolveGuideRedirect } from "@/features/slug-redirects/service";
import { getPublicGuideBySlug } from "@/features/guides/service";
import { getServerSession } from "@/lib/auth";
import { GuideArticle } from "@/app/(site)/guides/[slug]/guide-article";

// Staff preview of a guide in any status. Reached via the rewrite in
// next.config.ts from /guides/<slug>?preview=true (the browser URL does not
// change). Dynamic by design: it reads the session cookie, and
// getPublicGuideBySlug only returns non-published content to an authenticated
// admin, so everyone else gets the same 404 as before. Never cached, never
// indexed.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

interface PageProps {
  params: Promise<{ slug: string }>;
}

export default async function PreviewGuidePage(props: PageProps) {
  const { slug } = await props.params;

  const session = await getServerSession();
  const guide = await getPublicGuideBySlug(slug, { preview: true, session });

  if (!guide) {
    const target = await resolveGuideRedirect(slug);
    if (target) permanentRedirect(target);
    notFound();
  }

  return <GuideArticle guide={guide} slug={slug} />;
}
