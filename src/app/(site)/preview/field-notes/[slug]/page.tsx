import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";
import { resolveFieldNoteRedirect } from "@/features/slug-redirects/service";
import { getPublicFieldNoteBySlug } from "@/features/field-notes/service";
import { getServerSession } from "@/lib/auth";
import { FieldNoteArticle } from "@/app/(site)/field-notes/[slug]/field-note-article";

// Staff preview of a field note in any status. Reached via the rewrite in
// next.config.ts from /field-notes/<slug>?preview=true (the browser URL does not
// change). Dynamic by design: it reads the session cookie, and
// getPublicFieldNoteBySlug only returns non-published content to an authenticated
// admin, so everyone else gets the same 404 as before. Never cached, never
// indexed.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

interface PageProps {
  params: Promise<{ slug: string }>;
}

export default async function PreviewFieldNotePage(props: PageProps) {
  const { slug } = await props.params;

  const session = await getServerSession();
  const note = await getPublicFieldNoteBySlug(slug, { preview: true, session });

  if (!note) {
    const target = await resolveFieldNoteRedirect(slug);
    if (target) permanentRedirect(target);
    notFound();
  }

  return <FieldNoteArticle note={note} slug={slug} />;
}
