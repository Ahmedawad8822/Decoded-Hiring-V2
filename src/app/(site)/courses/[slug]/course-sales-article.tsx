import Link from "next/link";
import { isSafeMediaUrl } from "@/features/publishing/types";
import { JsonLd, breadcrumbSchema, buildCourseJsonLd } from "@/lib/seo";
import type { Course } from "@/lib/db";
import type {
  PublicSalesLesson,
  PublicSalesSection,
} from "@/features/courses/sales";
import { CourseSalesCta } from "./course-sales-cta";

export type CourseSalesCtaState =
  | { kind: "closed"; title: string; note: string }
  | { kind: "free"; title: string; note: string }
  | { kind: "offer"; title: string; note: string }
  | { kind: "legacy"; title: string; note: string };

export type CourseSalesView = {
  slug: string;
  classroomHref: string;
  signupHref: string;
  cta: CourseSalesCtaState;
  primaryHref: string;
  primaryLabel: string;
  offerSlug: string | null;
  alternativeLabel: string | null;
  alternativeUrl: string | null;
  priceLabel: string | null;
  priceBadge: string | null;
  seatsNote: string | null;
  closesNote: string | null;
  lessonCount: number;
  lessonLabel: string;
  totalTimeLabel: string | null;
  previewCount: number;
  outcomes: string[];
  faq: Array<{ q: string; a: string }>;
};

function lessonMetaLabel(lesson: PublicSalesLesson): string {
  const kind = lesson.kind === "video" ? "Video" : "Reading";
  const duration =
    lesson.durationMinutes !== null &&
    Number.isInteger(lesson.durationMinutes) &&
    lesson.durationMinutes >= 1 &&
    lesson.durationMinutes <= 600
      ? ` · ${lesson.durationMinutes} min`
      : "";
  const quiz = lesson.hasQuiz ? " · Quiz" : "";
  return `${kind}${duration}${quiz}`;
}

/**
 * Shared sales view for the public course page. Pure rendering: no
 * searchParams, cookies, session or data reads, so the ISR shell stays
 * cacheable. Viewer-specific state (signed in? enrolled?) lives in the
 * classroom page the CTAs link to.
 */
export function CourseSalesArticle({
  course,
  view,
  curriculum,
}: {
  course: Course;
  view: CourseSalesView;
  curriculum: PublicSalesSection[];
}) {
  const breadcrumbs = [
    { name: "Home", path: "/" },
    { name: "Courses", path: "/courses" },
    { name: course.title, path: `/courses/${view.slug}` },
  ];
  const description =
    course.description || "A practical course from Decoded Hiring.";

  return (
    <div className="hg-managed-page">
      <JsonLd data={breadcrumbSchema(breadcrumbs)} />
      <JsonLd
        data={buildCourseJsonLd({
          title: course.title,
          description,
          path: `/courses/${view.slug}`,
          datePublished: course.publishedAt
            ? new Date(course.publishedAt).toISOString()
            : undefined,
          dateModified: new Date(course.updatedAt).toISOString(),
        })}
      />

      <div className="wrap" style={{ paddingBlock: "24px 8px" }}>
        <nav className="crumbs" aria-label="Breadcrumb">
          <Link href="/">Home</Link>
          <span className="sep">/</span>
          <Link href="/courses">Courses</Link>
          <span className="sep">/</span>
          <span>{course.title}</span>
        </nav>
      </div>

      <div
        style={{
          maxWidth: "720px",
          marginInline: "auto",
          padding: "0 var(--gutter) clamp(64px, 8vw, 120px)",
        }}
      >
        <header style={{ padding: "clamp(24px, 4vw, 48px) 0 32px" }}>
          <span className="t-eyebrow tone-blue">COURSE</span>
          <h1
            className="editorial-h2"
            style={{
              fontSize: "clamp(2rem, 1.3rem + 3vw, 3.2rem)",
              lineHeight: 1.1,
              marginTop: "16px",
            }}
          >
            {course.title}
          </h1>
          {course.description && <p className="dek">{course.description}</p>}
          <div className="meta-line">
            <span className="mono">{view.lessonLabel}</span>
            {view.totalTimeLabel && (
              <>
                <span>·</span>
                <span>{view.totalTimeLabel}</span>
              </>
            )}
            <span>·</span>
            <span>
              {view.previewCount === 1
                ? "1 free preview"
                : `${view.previewCount} free previews`}
            </span>
            {view.priceLabel && (
              <>
                <span>·</span>
                <span>{view.priceLabel}</span>
              </>
            )}
          </div>
        </header>

        {isSafeMediaUrl(course.coverImage) && (
          <figure style={{ margin: "0 0 32px" }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={course.coverImage ?? undefined}
              alt={course.title}
              style={{
                width: "100%",
                height: "auto",
                borderRadius: "12px",
                display: "block",
              }}
            />
          </figure>
        )}

        <section
          aria-labelledby="cta-h"
          style={{
            border: "1px solid var(--line)",
            borderRadius: "16px",
            background: "var(--paper-bright)",
            padding: "28px 32px",
            marginBottom: "40px",
          }}
        >
          <h2 id="cta-h" style={{ margin: "0 0 8px", fontSize: "20px" }}>
            {view.cta.title}
          </h2>
          <p style={{ margin: "0 0 20px", color: "var(--muted-strong)" }}>
            {view.cta.note}
          </p>
          {view.seatsNote && (
            <p className="hg-route-note" role="status">
              {view.seatsNote}
            </p>
          )}
          {view.closesNote && (
            <p className="hg-route-note">{view.closesNote}</p>
          )}
          {view.offerSlug ? (
            <CourseSalesCta
              offerSlug={view.offerSlug}
              primaryHref={view.primaryHref}
              primaryLabel={view.primaryLabel}
              alternativeLabel={view.alternativeLabel}
              alternativeUrl={view.alternativeUrl}
            />
          ) : (
            <a className="hg-primary" href={view.primaryHref}>
              {view.primaryLabel}
            </a>
          )}
          <p
            style={{ margin: "16px 0 0", fontSize: "13px", color: "var(--muted)" }}
          >
            New here?{" "}
            <Link href={view.signupHref} style={{ fontWeight: 600 }}>
              Create an account
            </Link>{" "}
            to start in the classroom. Already enrolled?{" "}
            <Link href={view.classroomHref} style={{ fontWeight: 600 }}>
              Continue learning
            </Link>
            .
          </p>
        </section>

        {view.outcomes.length > 0 && (
          <section aria-labelledby="outcomes-h" style={{ marginBottom: "40px" }}>
            <h2 className="editorial-h2" id="outcomes-h">
              What you will learn
            </h2>
            <ul className="article-body">
              {view.outcomes.map((outcome, index) => (
                <li key={index}>{outcome}</li>
              ))}
            </ul>
          </section>
        )}

        {course.audience && (
          <section aria-labelledby="audience-h" style={{ marginBottom: "40px" }}>
            <h2 className="editorial-h2" id="audience-h">
              Who it is for
            </h2>
            <p style={{ whiteSpace: "pre-line" }}>{course.audience}</p>
          </section>
        )}

        <section aria-labelledby="curriculum-h" style={{ marginBottom: "40px" }}>
          <h2 className="editorial-h2" id="curriculum-h">
            Curriculum
          </h2>
          {curriculum.length === 0 && (
            <p style={{ color: "var(--muted-strong)" }}>
              Lessons coming soon.
            </p>
          )}
          {curriculum.map((section) => (
            <div key={section.id} style={{ marginBottom: "24px" }}>
              <h3 style={{ fontSize: "17px", margin: "0 0 12px" }}>
                {section.title}
              </h3>
              {section.lessons.length === 0 ? (
                <p style={{ color: "var(--muted-strong)", fontSize: "14px" }}>
                  Lessons coming soon.
                </p>
              ) : (
                <ol style={{ listStyle: "none", padding: 0, margin: 0 }}>
                  {section.lessons.map((lesson) => (
                    <li
                      key={lesson.id}
                      style={{
                        display: "flex",
                        alignItems: "baseline",
                        gap: "12px",
                        padding: "10px 0",
                        borderTop: "1px solid var(--line)",
                        fontSize: "15px",
                      }}
                    >
                      <span style={{ flex: 1 }}>{lesson.title}</span>
                      <span
                        style={{
                          fontSize: "12px",
                          color: "var(--muted)",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {lessonMetaLabel(lesson)}
                      </span>
                      {lesson.isPreview && (
                        <span
                          style={{
                            fontSize: "11px",
                            fontWeight: 600,
                            color: "var(--blue)",
                            whiteSpace: "nowrap",
                          }}
                        >
                          Preview
                        </span>
                      )}
                      {!lesson.required && (
                        <span
                          style={{
                            fontSize: "11px",
                            color: "var(--muted)",
                            whiteSpace: "nowrap",
                          }}
                        >
                          OPTIONAL
                        </span>
                      )}
                    </li>
                  ))}
                </ol>
              )}
            </div>
          ))}
        </section>

        {(course.instructorName || course.instructorBio) && (
          <section
            aria-labelledby="instructor-h"
            style={{ marginBottom: "40px" }}
          >
            <h2 className="editorial-h2" id="instructor-h">
              Instructor
            </h2>
            {course.instructorName && (
              <h3 style={{ fontSize: "17px" }}>{course.instructorName}</h3>
            )}
            {course.instructorBio && (
              <p style={{ whiteSpace: "pre-line" }}>{course.instructorBio}</p>
            )}
          </section>
        )}

        {course.certificateEnabled && (
          <section
            aria-labelledby="certificate-h"
            style={{ marginBottom: "40px" }}
          >
            <h2 className="editorial-h2" id="certificate-h">
              Proof of completion
            </h2>
            <p>Earn a certificate when you finish every required lesson.</p>
          </section>
        )}

        {view.faq.length > 0 && (
          <section aria-labelledby="faq-h" style={{ marginBottom: "40px" }}>
            <h2 className="editorial-h2" id="faq-h">
              Frequently asked questions
            </h2>
            {view.faq.map((item, index) => (
              <details key={index}>
                <summary>{item.q}</summary>
                <p style={{ whiteSpace: "pre-line" }}>{item.a}</p>
              </details>
            ))}
          </section>
        )}

        <section
          aria-label="Start learning"
          style={{
            border: "1px solid var(--line)",
            borderRadius: "16px",
            background: "var(--paper-bright)",
            padding: "28px 32px",
            marginBottom: "24px",
          }}
        >
          <h2 style={{ margin: "0 0 8px", fontSize: "20px" }}>
            {view.cta.title}
          </h2>
          <a className="hg-primary" href={view.primaryHref}>
            {view.primaryLabel}
          </a>
        </section>

        <footer
          style={{
            marginTop: "24px",
            paddingTop: "24px",
            borderTop: "1px solid var(--line)",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: "12px",
            flexWrap: "wrap",
          }}
        >
          <Link
            href="/courses"
            style={{
              color: "var(--blue)",
              fontWeight: 600,
              textDecoration: "none",
            }}
          >
            ← All courses
          </Link>
          <Link
            href={view.classroomHref}
            style={{ fontSize: "13px", color: "var(--muted)" }}
          >
            Go to the classroom
          </Link>
        </footer>
      </div>

      <div
        className="course-sales-sticky"
        role="region"
        aria-label="Course enrollment"
      >
        <a className="hg-primary" href={view.primaryHref}>
          {view.primaryLabel}
        </a>
      </div>
    </div>
  );
}
