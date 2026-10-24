import type { Metadata } from "next";
import Link from "next/link";
import { notFound, permanentRedirect } from "next/navigation";
import { resolveFieldNoteRedirect } from "@/features/slug-redirects/service";
import { getPublicFieldNoteBySlug } from "@/features/field-notes/service";
import { ContentBlock, estimateReadingTime } from "@/features/publishing/types";
import { ContentBlockRenderer } from "@/components/publishing/ContentBlockRenderer";
import { publicMetadata, JsonLd, breadcrumbSchema, buildContentJsonLd } from "@/lib/seo";
import { getServerSession } from "@/lib/auth";

interface PageProps {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ preview?: string }>;
}

export async function generateMetadata(props: PageProps): Promise<Metadata> {
  const { slug } = await props.params;
  const { preview } = await props.searchParams;

  const session = preview === "true" ? await getServerSession() : null;
  const note = await getPublicFieldNoteBySlug(slug, {
    preview: preview === "true",
    session,
  });

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
  const { preview } = await props.searchParams;

  const session = preview === "true" ? await getServerSession() : null;
  const note = await getPublicFieldNoteBySlug(slug, {
    preview: preview === "true",
    session,
  });

  if (!note) {
    const target = await resolveFieldNoteRedirect(slug);
    if (target) permanentRedirect(target);
    notFound();
  }

  let blocks: ContentBlock[] = [];
  try {
    blocks = JSON.parse(note.body) as ContentBlock[];
  } catch {
    blocks = [];
  }

  const minutes = estimateReadingTime(blocks);

  const breadcrumbs = [
    { name: "Home", path: "/" },
    { name: "Field Notes", path: "/field-notes" },
    { name: note.title, path: `/field-notes/${slug}` },
  ];

  const formattedDate = note.publishedAt
    ? new Date(note.publishedAt).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : "Draft";

  const isPreview = note.status !== "published";

  return (
    <div className="hg-managed-page">
      <JsonLd data={breadcrumbSchema(breadcrumbs)} />
      <JsonLd
        data={buildContentJsonLd({
          schemaType: "BlogPosting",
          title: note.title,
          description: note.excerpt || note.metaDescription || "",
          path: `/field-notes/${slug}`,
          author: note.author,
          datePublished: note.publishedAt ? new Date(note.publishedAt).toISOString() : undefined,
          dateModified: new Date(note.updatedAt).toISOString(),
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
          PREVIEW MODE · This field note is currently a {note.status.toUpperCase()} and is not publicly discoverable.
        </aside>
      )}

      <div className="wrap" style={{ paddingBlock: "24px 8px" }}>
        <nav className="crumbs" aria-label="Breadcrumb">
          <Link href="/">Home</Link>
          <span className="sep">/</span>
          <Link href="/field-notes">Field Notes</Link>
          <span className="sep">/</span>
          <span>{note.title}</span>
        </nav>
      </div>

      {/* Lightweight single-column reading measure — no TOC rail, no progress bar */}
      <div style={{ maxWidth: "720px", marginInline: "auto", padding: "0 var(--gutter) clamp(64px, 8vw, 120px)" }}>
        <header style={{ padding: "clamp(24px, 4vw, 48px) 0 32px" }}>
          <span className="t-eyebrow tone-blue">FIELD NOTE</span>
          <h1
            className="editorial-h2"
            style={{
              fontSize: "clamp(2rem, 1.3rem + 3vw, 3.2rem)",
              lineHeight: 1.1,
              marginTop: "16px",
            }}
          >
            {note.title}
          </h1>
          {note.excerpt && <p className="dek">{note.excerpt}</p>}
          <div className="meta-line">
            <b>{note.author}</b>
            <span>·</span>
            <time dateTime={note.publishedAt ? new Date(note.publishedAt).toISOString() : undefined}>
              {formattedDate}
            </time>
            <span>·</span>
            <span className="mono">{minutes} min read</span>
          </div>
        </header>

        {note.coverImage && (
          <figure style={{ margin: "0 0 32px" }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={note.coverImage}
              alt={note.title}
              style={{ width: "100%", height: "auto", borderRadius: "12px", display: "block" }}
            />
          </figure>
        )}

        <article className="article-body">
          <ContentBlockRenderer blocks={blocks} />
        </article>

        <footer
          style={{
            marginTop: "48px",
            paddingTop: "24px",
            borderTop: "1px solid var(--line)",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: "12px",
            flexWrap: "wrap",
          }}
        >
          <Link href="/field-notes" style={{ color: "var(--blue)", fontWeight: 600, textDecoration: "none" }}>
            ← All field notes
          </Link>
          <span style={{ fontSize: "13px", color: "var(--muted)" }}>By {note.author}</span>
        </footer>
      </div>
    </div>
  );
}
