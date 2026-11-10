import Link from "next/link";
import { getLearnerCertificate } from "@/features/certificates/service";
import { notFound, permanentRedirect } from "next/navigation";
import { resolveCourseRedirect } from "@/features/slug-redirects/service";
import { getServerSession } from "@/lib/auth";
import {
  getCourseCurriculum,
  getLearnerCourseBySlug,
  getPublishedCourseBySlug,
} from "@/features/courses/service";
import { getEnrollment } from "@/features/enrollments/service";
import { hasLearnerAccess } from "@/features/enrollments/access";
import { getEnrollmentProgress } from "@/features/progress/service";
import { EnrollButton } from "@/components/learner/enroll-button";
import { getEffectiveCourseAccessPolicy } from "@/features/offers/service";
import { resolveOfferPublicPresentation } from "@/features/offers/presentation";

import { formatMinutes, getCourseTimeStats, lessonMetaLabel, parseCourseLanding } from "@/features/courses/metadata";

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
  const curriculum = await getCourseCurriculum(course.id);
  const progress = activeEnrollment ? await getEnrollmentProgress(activeEnrollment) : null;
  const certificate = activeEnrollment && progress?.completed && session?.user
    ? await getLearnerCertificate(session.user.id, course.id) : null;
  const completedSet = new Set(progress?.completedLessonIds ?? []);
  const publishedLessons = curriculum.flatMap((entry) => entry.publishedLessons);
  const stats = getCourseTimeStats(publishedLessons, completedSet);
  const previewCount = course.status === "published" ? publishedLessons.filter((lesson) => lesson.isPreview).length : 0;
  const landing = parseCourseLanding(course);
  const enrollmentCta = access.available && access.mode === "FREE"
    ? <EnrollButton courseId={course.id} courseSlug={course.slug} />
    : (offerPresentation?.ctaHref || access.source === "LEGACY_COURSE")
      ? <a className="btn secondary learner-link" href={offerPresentation?.ctaHref ?? "/contact"}>{offerPresentation?.ctaLabel ?? "Contact us"} →</a>
      : null;

  const resumeHref =
    activeEnrollment && progress?.resumeLesson
      ? `/learn/courses/${course.slug}/lessons/${progress.resumeLesson.slug}`
      : null;

  return (
    <main className={`sec-app learner-page${!activeEnrollment && enrollmentCta ? " lrn-has-enroll-bar" : ""}`} id="main">
      <div className="wrap learner-column">
        <p className="a-micro learner-mb-6">
          <Link className="learner-inherit" href="/learn/courses">MY COURSES</Link> · COURSE OVERVIEW
        </p>
        <h1 className="a-h1 learner-mb-6">{course.title}</h1>
        {course.description && (
          <p className="muted learner-mb-24">{course.description}</p>
        )}

        <dl className="lrn-course-stats" aria-label="Course statistics">
          <div><dt>Lessons</dt><dd>{stats.lessonCount}</dd></div>
          {stats.totalMinutes !== null && <div><dt>Total time</dt><dd>{formatMinutes(stats.totalMinutes)}</dd></div>}
          <div><dt>Free previews</dt><dd>{previewCount}</dd></div>
        </dl>
        {landing.outcomes.length > 0 && (
          <section className="lrn-landing-section" aria-labelledby="outcomes-h">
            <h2 className="a-h2" id="outcomes-h">What you&apos;ll learn</h2>
            <ul>{landing.outcomes.map((outcome, index) => <li key={index}>{outcome}</li>)}</ul>
          </section>
        )}
        {course.audience && (
          <section className="lrn-landing-section" aria-labelledby="audience-h">
            <h2 className="a-h2" id="audience-h">Who it&apos;s for</h2>
            <p className="lrn-plain-text">{course.audience}</p>
          </section>
        )}

        {activeEnrollment && progress ? (
          <div className="continue-card learner-mb-28">
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
            {stats.minutesLeft !== null && stats.minutesLeft > 0 && <p className="learner-mb-16">{formatMinutes(stats.minutesLeft)} left</p>}
            <div className="progress-line">
              <span className="track"><i style={{ width: `${progress.percent}%` }}></i></span>
              <span className="num">{progress.percent}%</span>
            </div>
            {progress.completed && (
              <Link className="btn primary" href={`/learn/courses/${course.slug}/complete`}>See your completion</Link>
            )}
            {progress.completed && (certificate || course.certificateEnabled) && (
              <Link className="btn secondary" href={certificate ? `/certificates/${certificate.id}` : `/learn/courses/${course.slug}/complete`}>
                {certificate ? "Certificate" : "Get certificate"}
              </Link>
            )}
            {resumeHref && (
              <div className="learner-mt-12">
                <Link className="btn primary learner-link" href={resumeHref}>
                  Resume lesson →
                </Link>
              </div>
            )}
          </div>
        ) : access.available && access.mode === "FREE" ? (
          <div className="continue-card learner-mb-28">
            <div className="cc-top">
              <div>
                <h3>Start learning — free</h3>
                <p className="cc-lesson">Instant enrollment. No checkout, no card.</p>
              </div>
            </div>
            <div className="learner-mt-12">
              {enrollmentCta}
            </div>
          </div>
        ) : (
          <div className="continue-card learner-mb-28">
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
            {enrollmentCta && <div className="learner-mt-12">{enrollmentCta}</div>}
          </div>
        )}

        <section aria-labelledby="co-h">
          <h2 className="a-h2 learner-mb-16" id="co-h">Curriculum</h2>
          <div className="curriculum learner-overview-curriculum">
            {curriculum.map((entry) => (
              <div key={entry.section.id}>
                <p className="cu-sec learner-section-title">
                  {entry.section.title}
                </p>
                {entry.publishedLessons.length === 0 && (
                  <p className="muted learner-coming-soon">
                    Lessons coming soon.
                  </p>
                )}
                {entry.publishedLessons.map((lesson) => {
                  const done = completedSet.has(lesson.id);
                  const isCurrent = progress?.resumeLesson?.id === lesson.id;
                  const href = activeEnrollment || (course.status === "published" && lesson.isPreview)
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
                      <span className="lrn-lesson-info">
                        <span>{lesson.title}</span>
                        <span className="lrn-lesson-meta">{lessonMetaLabel(lesson)}</span>
                      </span>
                      {lesson.isPreview && course.status === "published" && <span className="lrn-preview-badge">Preview</span>}
                      {!lesson.required && <span className="opt">OPTIONAL</span>}
                    </Link>
                  );
                })}
              </div>
            ))}
          </div>
        </section>
        {(course.instructorName || course.instructorBio) && (
          <section className="lrn-landing-section" aria-labelledby="instructor-h">
            <h2 className="a-h2" id="instructor-h">Instructor</h2>
            {course.instructorName && <h3>{course.instructorName}</h3>}
            {course.instructorBio && <p className="lrn-plain-text">{course.instructorBio}</p>}
          </section>
        )}
        {landing.faq.length > 0 && (
          <section className="lrn-landing-section lrn-faq" aria-labelledby="faq-h">
            <h2 className="a-h2" id="faq-h">Frequently asked questions</h2>
            {landing.faq.map((item, index) => (
              <details key={index}><summary>{item.q}</summary><p className="lrn-plain-text">{item.a}</p></details>
            ))}
          </section>
        )}
        {!activeEnrollment && enrollmentCta && <div className="lrn-enroll-bar" role="region" aria-label="Course enrollment">{enrollmentCta}</div>}
      </div>
    </main>
  );
}
