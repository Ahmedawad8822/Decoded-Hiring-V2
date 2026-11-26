import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";
import { resolvePageRedirect } from "@/features/slug-redirects/service";
import { getPublicPageBySlug } from "@/features/pages/service";
import { getServerSession } from "@/lib/auth";
import { StandardPageArticle } from "@/app/(site)/[slug]/standard-page-article";

// Staff preview of a standard page in any status. Reached via the rewrite in
// next.config.ts from /<slug>?preview=true (the browser URL does not
// change). Dynamic by design: it reads the session cookie, and
// getPublicPageBySlug only returns non-published content to an authenticated
// admin, so everyone else gets the same 404 as before. Never cached, never
// indexed.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

interface PageProps {
  params: Promise<{ slug: string }>;
}

export default async function PreviewStandardPage(props: PageProps) {
  const { slug } = await props.params;

  const session = await getServerSession();
  const page = await getPublicPageBySlug(slug, { preview: true, session });

  if (!page) {
    const target = await resolvePageRedirect(slug);
    if (target) permanentRedirect(target);
    notFound();
  }

  return <StandardPageArticle page={page} slug={slug} />;
}
