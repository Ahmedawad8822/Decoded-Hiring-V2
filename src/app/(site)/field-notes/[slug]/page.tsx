import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";
import { resolveFieldNoteRedirect } from "@/features/slug-redirects/service";
import { getPublicFieldNoteBySlug } from "@/features/field-notes/service";
import { publicMetadata } from "@/lib/seo";
import { FieldNoteArticle } from "./field-note-article";

// Static / ISR: this route reads no request data (no searchParams, cookies or
// headers), so the published article is prerendered on first request and
// served from the incremental cache. Studio actions call
// revalidatePath("/field-notes/<slug>") on every publish, unpublish, archive,
// edit and slug rename, so content still reflects publishes immediately. The
// time-based revalidate is only a safety net for any write path that forgets
// to revalidate. Staff previews of unpublished content (?preview=true) are
// rewritten in next.config.ts to the dynamic /preview/field-notes/[slug]
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
  const note = await getPublicFieldNoteBySlug(slug);

  if (!note) {
    return {};
  }

  const title = note.metaTitle || `${note.title} — Decoded Hiring Field Note`;
  const description =
    note.metaDescription || note.excerpt || "A timely hiring observation from Ahmed Awad.";

  return publicMetadata({
    title,
    description,
    path: `/field-notes/${slug}`,
    type: "article",
  });
}

export default async function PublicFieldNoteDetailPage(props: PageProps) {
  const { slug } = await props.params;
  const note = await getPublicFieldNoteBySlug(slug);

  if (!note) {
    const target = await resolveFieldNoteRedirect(slug);
    if (target) permanentRedirect(target);
    notFound();
  }

  return <FieldNoteArticle note={note} slug={slug} />;
}
