import type { Metadata } from "next";
import Link from "next/link";
import { getPublishedFieldNotes } from "@/features/field-notes/service";
import { ContentBlock, estimateReadingTime } from "@/features/publishing/types";
import { publicMetadata, JsonLd, breadcrumbSchema } from "@/lib/seo";

export async function generateMetadata(): Promise<Metadata> {
  return publicMetadata({
    title: "Field Notes | Decoded Hiring",
    description:
      "Short, timely hiring observations from Ahmed Awad — what changed, what it means, and what to do about it.",
    path: "/field-notes",
    type: "website",
  });
}

function parseBlocks(body: string): ContentBlock[] {
  try {
    return JSON.parse(body) as ContentBlock[];
  } catch {
    return [];
  }
}

export default async function FieldNotesIndexPage() {
  const notes = await getPublishedFieldNotes();

  const breadcrumbs = [
    { name: "Home", path: "/" },
    { name: "Field Notes", path: "/field-notes" },
  ];

  return (
    <div className="hg-managed-page">
      <JsonLd data={breadcrumbSchema(breadcrumbs)} />

      <nav className="hg-breadcrumbs" aria-label="Breadcrumbs" style={{ padding: "20px var(--gutter) 0" }}>
        <ol style={{ display: "flex", gap: "8px", listStyle: "none", padding: 0, margin: 0, fontSize: "13px" }}>
          <li>
            <Link href="/" style={{ color: "var(--muted)" }}>
              Home
            </Link>
          </li>
          <li style={{ color: "var(--line)" }}>/</li>
          <li aria-current="page" style={{ color: "var(--ink)", fontWeight: 500 }}>
            Field Notes
          </li>
        </ol>
      </nav>

      <header
        style={{
          padding: "clamp(40px, 6vw, 72px) var(--gutter) 40px",
          maxWidth: "1120px",
          marginInline: "auto",
        }}
      >
        <span
          style={{
            fontSize: "11px",
            fontWeight: 600,
            letterSpacing: "0.12em",
            textTransform: "uppercase",
            color: "var(--blue)",
            display: "block",
            marginBottom: "12px",
          }}
        >
          TIMELY · TACTICAL · OBSERVATION-LED
        </span>
        <h1
          style={{
            fontFamily: "var(--font-display, Georgia, serif)",
            fontSize: "clamp(2.5rem, 1.5rem + 3.5vw, 4.2rem)",
            lineHeight: 1.08,
            letterSpacing: "-0.02em",
            fontWeight: 400,
            margin: "0 0 16px",
          }}
        >
          Field Notes
        </h1>
        <p
          style={{
            fontSize: "clamp(1.1rem, 1rem + 0.5vw, 1.35rem)",
            lineHeight: 1.55,
            color: "var(--muted-strong)",
            maxWidth: "680px",
            margin: 0,
          }}
        >
          Things noticed in hiring lately — what they mean, and what to do about them.
        </p>
      </header>

      <main
        id="main"
        style={{
          padding: "0 var(--gutter) clamp(64px, 8vw, 120px)",
          maxWidth: "860px",
          marginInline: "auto",
        }}
      >
        {notes.length === 0 ? (
          <div
            style={{
              padding: "48px 32px",
              border: "1px solid var(--line)",
              borderRadius: "16px",
              background: "var(--paper-bright)",
              textAlign: "center",
            }}
          >
            <p style={{ fontSize: "18px", fontWeight: 600, margin: "0 0 8px" }}>
              No field notes published yet.
            </p>
            <p style={{ color: "var(--muted-strong)", margin: 0 }}>
              Observations are on the way — check back soon, or explore the{" "}
              <Link href="/guides" style={{ color: "var(--blue)" }}>
                in-depth guides
              </Link>{" "}
              meanwhile.
            </p>
          </div>
        ) : (
          <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "0" }}>
            {notes.map((note) => {
              const blocks = parseBlocks(note.body);
              const minutes = estimateReadingTime(blocks);
              const publishedDate = note.publishedAt
                ? new Date(note.publishedAt).toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                    year: "numeric",
                  })
                : "Recently published";
              return (
                <li
                  key={note.id}
                  style={{
                    padding: "28px 0",
                    borderTop: "1px solid var(--line)",
                    display: "grid",
                    gap: "10px",
                  }}
                >
                  <div style={{ display: "flex", gap: "12px", alignItems: "baseline", flexWrap: "wrap" }}>
                    <time
                      dateTime={note.publishedAt ? new Date(note.publishedAt).toISOString() : undefined}
                      style={{ fontSize: "12.5px", color: "var(--muted)", fontWeight: 600, letterSpacing: "0.04em", textTransform: "uppercase" }}
                    >
                      {publishedDate}
                    </time>
                    <span style={{ fontSize: "12.5px", color: "var(--muted)" }}>· {minutes} min read</span>
                  </div>
                  <h2
                    style={{
                      fontFamily: "var(--font-display, Georgia, serif)",
                      fontSize: "clamp(1.4rem, 1.2rem + 1vw, 1.9rem)",
                      lineHeight: 1.25,
                      fontWeight: 500,
                      margin: 0,
                    }}
                  >
                    <Link href={`/field-notes/${note.slug}`} style={{ color: "var(--ink)", textDecoration: "none" }}>
                      {note.title}
                    </Link>
                  </h2>
                  {note.excerpt && (
                    <p style={{ fontSize: "15px", lineHeight: 1.6, color: "var(--muted-strong)", margin: 0, maxWidth: "640px" }}>
                      {note.excerpt}
                    </p>
                  )}
                  <Link
                    href={`/field-notes/${note.slug}`}
                    style={{ color: "var(--blue)", fontWeight: 600, textDecoration: "none", fontSize: "14px" }}
                  >
                    Read note →
                  </Link>
                </li>
              );
            })}
          </ol>
        )}
      </main>
    </div>
  );
}
