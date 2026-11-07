import Link from "next/link";
import { notFound, permanentRedirect } from "next/navigation";
import { resolveCourseRedirect } from "@/features/slug-redirects/service";
import { getServerSession } from "@/lib/auth";
import {
  getLearnerCourseBySlug,
  getPublishedCourseBySlug,
} from "@/features/courses/service";
import { getCachedCourseContent } from "@/features/courses/content-cache";
import { getEnrollment } from "@/features/enrollments/service";
import { hasLearnerAccess } from "@/features/enrollments/access";
import { getEnrollmentProgress } from "@/features/progress/service";
import { EnrollButton } from "@/components/learner/enroll-button";
import { getEffectiveCourseAccessPolicy } from "@/features/offers/service";
import { resolveOfferPublicPresentation } from "@/features/offers/presentation";

export async function generateMetadata(props: {
  params: Promise<{ courseSlug: string }>;
}) {
  const { courseSlug } = await props.params;
  const course = await getPublishedCourseBySlug(courseSlug);
  return {
    title: course ? `${course.title} | Decoded Hiring` : "Course | Decoded Hiring",
  };
}

function legacyAccessNote(accessMode: string): string | null {
  if (accessMode === "PAID_ONE_TIME")
    return "This course requires a one-time payment. Online checkout is not available yet — please contact us and we will arrange access.";
  if (accessMode === "MANUAL_INVOICE")
    return "This course is enrolled by manual invoice. Please contact us to arrange access.";
  if (accessMode === "PAYMENT_DISABLED")
    return "Enrollment is currently disabled for this course.";
  return null;
}

function offerAccessNote(accessMode: string, available: boolean): string {
  if (!available) return "This course is not currently accepting new enrollments.";
  if (accessMode === "PAID_ONE_TIME")
    return "This course is paid. Online checkout is not active yet, so use the configured alternative path below.";
  if (accessMode === "MANUAL_INVOICE")
    return "Access is arranged manually by invoice. Use the option below to request access.";
  if (accessMode === "COMING_SOON")
    return "Enrollment is not open yet. Use the option below if you want to be notified or register interest.";
  if (accessMode === "PAYMENT_DISABLED")
    return "Online enrollment is currently unavailable. Use the configured alternative path below.";
  return "Enrollment is currently unavailable.";
}

export default async function CourseOverviewPage(props: {
  params: Promise<{ courseSlug: string }>;
}) {
  const { courseSlug } = await props.params;
  // Archived courses stay visible to already-entitled learners (correction D).
  const session = await getServerSession();
  const course = await getLearnerCourseBySlug(courseSlug, session?.user?.id);
  if (!course) {
    const target = await resolveCourseRedirect(courseSlug);
    if (target) permanentRedirect(target);
    notFound();
  }

  const enrollment = session?.user ? await getEnrollment(session.user.id, course.id) : null;
  const access = await getEffectiveCourseAccessPolicy(course);
  const offerPresentation = access.offer
    ? resolveOfferPublicPresentation(access.offer, {
        freeHref: `/learn/courses/${course.slug}`,
        freeLabel: "Start learning — free",
        contactHref: "/contact",
      })
    : null;
  // Cancelled enrollments see the page as strangers: no progress card, no
  // resume link — just the enroll CTA (re-enroll reactivates, correction C).
  const activeEnrollment = hasLearnerAccess(enrollment) ? enrollment : null;
  const { curriculum, publishedLessons } = await getCachedCourseContent(course.id);
  const progress = activeEnrollment ? await getEnrollmentProgress(activeEnrollment, publishedLessons) : null;
  const completedSet = new Set(progress?.completedLessonIds ?? []);

  const resumeHref =
    activeEnrollment && progress?.resumeLesson
      ? `/learn/courses/${course.slug}/lessons/${progress.resumeLesson.slug}`
      : null;

  return (
    <main className="sec-app" id="main" style={{ padding: "clamp(24px,4vw,48px) 0" }}>
      <div className="wrap" style={{ maxWidth: 880 }}>
        <p className="a-micro" style={{ marginBottom: 6 }}>
          <Link href="/learn/courses" style={{ color: "inherit" }}>MY COURSES</Link> · COURSE OVERVIEW
        </p>
        <h1 className="a-h1" style={{ marginBottom: 6 }}>{course.title}</h1>
        {course.description && (
          <p className="muted" style={{ marginBottom: 24 }}>{course.description}</p>
        )}

        {activeEnrollment && progress ? (
          <div className="continue-card" style={{ marginBottom: 28 }}>
            <div className="cc-top">
              <div>
                <h3>{progress.completed ? "Course complete" : "Continue where you left off"}</h3>
                {!progress.completed && progress.resumeLesson && (
                  <p className="cc-lesson"><em>{progress.resumeLesson.title}</em></p>
                )}
                {progress.completed && (
                  <p className="cc-lesson">All required lessons done — review anything below.</p>
                )}
              </div>
              <span className="cc-count mono">
                {progress.completedRequired} / {progress.totalRequired}
              </span>
            </div>
            <div className="progress-line">
              <span className="track"><i style={{ width: `${progress.percent}%` }}></i></span>
              <span className="num">{progress.percent}%</span>
            </div>
            {resumeHref && (
              <div style={{ marginTop: 12 }}>
                <Link className="btn primary" href={resumeHref} style={{ textDecoration: "none" }}>
                  Resume lesson →
                </Link>
              </div>
            )}
          </div>
        ) : course.accessMode === "FREE" ? (
          <div className="continue-card" style={{ marginBottom: 28 }}>
            <div className="cc-top">
              <div>
                <h3>Start learning — free</h3>
                <p className="cc-lesson">Instant enrollment. No checkout, no card.</p>
              </div>
            </div>
            <div style={{ marginTop: 12 }}>
              <EnrollButton courseId={course.id} courseSlug={course.slug} />
            </div>
          </div>
        ) : (
          <div className="continue-card" style={{ marginBottom: 28 }}>
            <div className="cc-top">
              <div>
                <h3>
                  {access.available && access.mode === "COMING_SOON"
                    ? "Enrollment coming soon"
                    : access.available
                      ? "Enrollment on request"
                      : "Enrollment unavailable"}
                </h3>
                <p className="cc-lesson">
                  {access.source === "OFFER"
                    ? offerAccessNote(access.mode, access.available)
                    : legacyAccessNote(access.mode)}
                </p>
              </div>
              <span className="cc-count mono">
                {offerPresentation?.badge ?? access.mode}
              </span>
            </div>
            {(offerPresentation?.ctaHref || access.source === "LEGACY_COURSE") && (
              <div style={{ marginTop: 12 }}>
                <a
                  className="btn secondary"
                  href={offerPresentation?.ctaHref ?? "/contact"}
                  style={{ textDecoration: "none" }}
                >
                  {offerPresentation?.ctaLabel ?? "Contact us"} →
                </a>
              </div>
            )}
          </div>
        )}

        <section aria-labelledby="co-h">
          <h2 className="a-h2" id="co-h" style={{ marginBottom: 16 }}>Curriculum</h2>
          <div className="curriculum" style={{ maxHeight: "none", position: "static" }}>
            {curriculum.map((entry) => (
              <div key={entry.section.id}>
                <p className="cu-sec" style={{ paddingTop: 16 }}>
                  {entry.section.title}
                </p>
                {entry.publishedLessons.length === 0 && (
                  <p className="muted" style={{ fontSize: 12.5, padding: "4px 0" }}>
                    Lessons coming soon.
                  </p>
                )}
                {entry.publishedLessons.map((lesson) => {
                  const done = completedSet.has(lesson.id);
                  const isCurrent = progress?.resumeLesson?.id === lesson.id;
                  const href = activeEnrollment
                    ? `/learn/courses/${course.slug}/lessons/${lesson.slug}`
                    : `/learn/courses/${course.slug}`;
                  return (
                    <Link
                      key={lesson.id}
                      className={`cu-lesson${done ? " done" : ""}${isCurrent ? " current" : ""}`}
                      href={href}
                      aria-current={isCurrent ? true : undefined}
                    >
                      <span className="tick">{done ? "✓" : ""}</span>
                      {lesson.title}
                      {!lesson.required && <span className="opt">OPTIONAL</span>}
                    </Link>
                  );
                })}
              </div>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}
