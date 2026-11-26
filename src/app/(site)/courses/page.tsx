import type { Metadata } from "next";
import Link from "next/link";
import { getPublicCourses } from "@/features/courses/sales";
import {
  getPublishedLessonCounts,
} from "@/features/courses/service";
import { getOffersForCourses } from "@/features/offers/service";
import { resolveCourseListAccessLabel } from "@/features/offers/presentation";
import { publicMetadata, JsonLd, breadcrumbSchema } from "@/lib/seo";

export async function generateMetadata(): Promise<Metadata> {
  return publicMetadata({
    title: "Courses | Decoded Hiring",
    description:
      "Practical recruitment courses from Ahmed Awad. Browse the catalog and start learning.",
    path: "/courses",
    type: "website",
  });
}

// Static: prerendered from the course table and refreshed by
// revalidatePath("/courses") on every Studio course/offer change (plus the
// sitemap). No session is read here, so the page stays publicly cacheable.
// Production builds run against an empty D1, so the build-time prerender of
// this list is empty. A short revalidate lets the post-deploy prewarm (and
// the first visitor) refresh it from production data; Studio actions still
// revalidate it immediately on change.
export const revalidate = 60;

export default async function CoursesIndexPage() {
  const courses = await getPublicCourses();
  const [lessonCounts, offers] = await Promise.all([
    getPublishedLessonCounts(courses.map((course) => course.id)),
    getOffersForCourses(courses.map((course) => course.id)),
  ]);

  const breadcrumbs = [
    { name: "Home", path: "/" },
    { name: "Courses", path: "/courses" },
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
            Courses
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
          LEARN WITH DECODED HIRING
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
          Courses
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
          Practical courses that turn recruitment thinking into repeatable
          systems.
        </p>
      </header>

      <main
        id="main"
        style={{
          padding: "0 var(--gutter) clamp(64px, 8vw, 120px)",
          maxWidth: "1120px",
          marginInline: "auto",
        }}
      >
        {courses.length === 0 ? (
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
              No courses published yet. Check back soon.
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
            {courses.map((course) => {
              const count = lessonCounts[course.id] ?? 0;
              const offer = offers.get(course.id);
              const accessLabel = resolveCourseListAccessLabel(
                offer ?? null,
                course.accessMode,
              );
              return (
                <article
                  key={course.id}
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
                        COURSE
                      </span>
                      <span style={{ fontSize: "12px", color: "var(--muted)" }}>
                        {accessLabel}
                      </span>
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
                        href={`/courses/${course.slug}`}
                        style={{ color: "var(--ink)", textDecoration: "none" }}
                      >
                        {course.title}
                      </Link>
                    </h2>
                    {course.description && (
                      <p
                        style={{
                          fontSize: "14px",
                          lineHeight: 1.6,
                          color: "var(--muted-strong)",
                          margin: 0,
                        }}
                      >
                        {course.description}
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
                    <span>{count === 1 ? "1 lesson" : `${count} lessons`}</span>
                    <Link
                      href={`/courses/${course.slug}`}
                      style={{
                        color: "var(--blue)",
                        fontWeight: 600,
                        textDecoration: "none",
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "4px",
                      }}
                    >
                      View course →
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
