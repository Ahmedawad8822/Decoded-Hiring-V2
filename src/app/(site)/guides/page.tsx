import type { Metadata } from "next";
import Link from "next/link";
import { getPublishedGuides } from "@/features/guides/service";
import { publicMetadata, JsonLd, breadcrumbSchema } from "@/lib/seo";

export async function generateMetadata(): Promise<Metadata> {
  return publicMetadata({
    title: "Guides & Strategic Playbooks | Decoded Hiring",
    description:
      "In-depth recruitment strategies, hiring architecture, and practical operational playbooks from Ahmed Awad.",
    path: "/guides",
    type: "website",
  });
}

export default async function GuidesIndexPage() {
  const guides = await getPublishedGuides();

  const breadcrumbs = [
    { name: "Home", path: "/" },
    { name: "Guides", path: "/guides" },
  ];

  return (
    <div className="hg-managed-page">
      <JsonLd data={breadcrumbSchema(breadcrumbs)} />

      {/* Breadcrumb strip */}
      <nav className="hg-breadcrumbs" aria-label="Breadcrumbs" style={{ padding: "20px var(--gutter) 0" }}>
        <ol style={{ display: "flex", gap: "8px", listStyle: "none", padding: 0, margin: 0, fontSize: "13px" }}>
          <li>
            <Link href="/" style={{ color: "var(--muted)" }}>
              Home
            </Link>
          </li>
          <li style={{ color: "var(--line)" }}>/</li>
          <li aria-current="page" style={{ color: "var(--ink)", fontWeight: 500 }}>
            Guides
          </li>
        </ol>
      </nav>

      {/* Hero */}
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
          EDITORIAL &amp; PLAYBOOKS
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
          Guides
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
          Frameworks, operating models and diagnostic guides for recruitment leaders and TA teams.
        </p>
      </header>

      {/* Guides Grid */}
      <main
        id="main"
        style={{
          padding: "0 var(--gutter) clamp(64px, 8vw, 120px)",
          maxWidth: "1120px",
          marginInline: "auto",
        }}
      >
        {guides.length === 0 ? (
          <div
            style={{
              padding: "48px 32px",
              border: "1px solid var(--line)",
              borderRadius: "16px",
              background: "var(--paper-bright)",
              textAlign: "center",
            }}
          >
            <p style={{ color: "var(--muted-strong)", margin: 0 }}>
              No guides published yet. Check back soon.
            </p>
          </div>
        ) : (
          <div
            style={{
              display: "grid",
              gap: "24px",
              gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 300px), 1fr))",
            }}
          >
            {guides.map((guide) => {
              const publishedDate = guide.publishedAt
                ? new Date(guide.publishedAt).toLocaleDateString("en-US", {
                    month: "short",
                    year: "numeric",
                  })
                : "Recently published";

              return (
                <article
                  key={guide.id}
                  style={{
                    border: "1px solid var(--line)",
                    borderRadius: "16px",
                    background: "var(--paper-bright)",
                    padding: "28px 32px",
                    display: "flex",
                    flexDirection: "column",
                    justifyContent: "space-between",
                    gap: "20px",
                    transition: "border-color 0.2s ease",
                  }}
                >
                  <div style={{ display: "grid", gap: "12px" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                      <span
                        style={{
                          fontSize: "11px",
                          fontWeight: 600,
                          letterSpacing: "0.08em",
                          textTransform: "uppercase",
                          color: "var(--blue)",
                        }}
                      >
                        {guide.category || "STRATEGY"}
                      </span>
                      <time
                        dateTime={guide.publishedAt ? new Date(guide.publishedAt).toISOString() : undefined}
                        style={{ fontSize: "12px", color: "var(--muted)" }}
                      >
                        {publishedDate}
                      </time>
                    </div>
                    <h2
                      style={{
                        fontFamily: "var(--font-display, Georgia, serif)",
                        fontSize: "22px",
                        lineHeight: 1.25,
                        fontWeight: 500,
                        margin: 0,
                      }}
                    >
                      <Link
                        href={`/guides/${guide.slug}`}
                        style={{ color: "var(--ink)", textDecoration: "none" }}
                      >
                        {guide.title}
                      </Link>
                    </h2>
                    {guide.excerpt && (
                      <p
                        style={{
                          fontSize: "14px",
                          lineHeight: 1.6,
                          color: "var(--muted-strong)",
                          margin: 0,
                        }}
                      >
                        {guide.excerpt}
                      </p>
                    )}
                  </div>

                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      paddingTop: "16px",
                      borderTop: "1px solid var(--line)",
                      fontSize: "13px",
                      color: "var(--muted)",
                    }}
                  >
                    <span>By {guide.author}</span>
                    <Link
                      href={`/guides/${guide.slug}`}
                      style={{
                        color: "var(--blue)",
                        fontWeight: 600,
                        textDecoration: "none",
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "4px",
                      }}
                    >
                      Read guide →
                    </Link>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}
