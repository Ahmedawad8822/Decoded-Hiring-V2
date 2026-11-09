import Link from "next/link";
import { notFound, permanentRedirect, redirect } from "next/navigation";
import { resolveCourseRedirect } from "@/features/slug-redirects/service";
import { getServerSession } from "@/lib/auth";
import { getCourseCompletionState } from "@/features/progress/completion";
import { getAccessibleEnrollments } from "@/features/enrollments/service";
import { getLessonResourcesForLessons, getPublishedCourses } from "@/features/courses/service";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "Course complete | Decoded Hiring",
  robots: { index: false, follow: false },
};

export default async function CourseCompletionPage({ params }: {
  params: Promise<{ courseSlug: string }>;
}) {
  const session = await getServerSession();
  if (!session?.user) redirect("/login?redirect=/learn");
  const { courseSlug } = await params;
  const state = await getCourseCompletionState(session.user.id, courseSlug);
  if (state.kind === "not_found") {
    const target = await resolveCourseRedirect(courseSlug);
    if (target) permanentRedirect(`${target}/complete`);
    notFound();
  }
  const { course } = state;
  const courseHref = `/learn/courses/${course.slug}`;
  if (state.kind === "incomplete") redirect(courseHref);
  if (state.kind === "enrollment_required") {
    return (
      <main className="sec-app learner-page" id="main">
        <div className="wrap learner-column">
          <h1 className="a-h1">Enrollment required</h1>
          <p className="muted-strong learner-intro">Enroll in {course.title} to unlock the course content and completion.</p>
          <Link className="btn primary learner-mt-16" href={courseHref}>Go to course →</Link>
        </div>
      </main>
    );
  }
  const { enrollment, progress } = state;
  const [memberships, published, resources] = await Promise.all([
    getAccessibleEnrollments(session.user.id),
    getPublishedCourses(),
    getLessonResourcesForLessons(progress.publishedLessons.map((lesson) => lesson.id)),
  ]);
  const enrolledIds = new Set(memberships.map((entry) => entry.courseId));
  const suggestions = published.filter((entry) => !enrolledIds.has(entry.id)).slice(0, 2);
  const optionalDone = progress.completedLessonIds.length - progress.completedRequired;
  const resourceCount = [...resources.values()].reduce((count, entries) => count + entries.length, 0);

  return (
    <main className="sec-app learner-page" id="main">
      <div className="wrap learner-column">
        <header className="completion-hero">
          <span className="completion-badge" aria-hidden="true">✓</span>
          <p className="a-micro">COURSE COMPLETE</p>
          <h1 className="a-h1">You did it.</h1>
          <p className="completion-title">{course.title}</p>
          {enrollment.completedAt && (
            <p className="muted">Completed on <time dateTime={enrollment.completedAt.toISOString()}>
              {enrollment.completedAt.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })}
            </time></p>
          )}
        </header>
        <dl className="completion-stats">
          <div><dt>Required lessons done</dt><dd>{progress.completedRequired} / {progress.totalRequired}</dd></div>
          {progress.totalPublished > progress.totalRequired && (
            <div><dt>Optional lessons done</dt><dd>{optionalDone} / {progress.totalPublished - progress.totalRequired}</dd></div>
          )}
          <div><dt>Downloadable resources</dt><dd>{resourceCount}</dd></div>
        </dl>
        <Link className="btn secondary" href={courseHref}>Review course</Link>
        <section className="learner-section" aria-labelledby="next-h">
          <h2 className="a-h2" id="next-h">What&apos;s next</h2>
          {suggestions.length > 0 ? (
            <div className="course-cards learner-mt-18">
              {suggestions.map((entry) => (
                <Link className="course-card" key={entry.id} href={`/learn/courses/${entry.slug}`}>
                  <div className="cc-body"><h3>{entry.title}</h3>{entry.description && <p className="cc-meta">{entry.description}</p>}</div>
                </Link>
              ))}
            </div>
          ) : <Link className="btn primary learner-mt-16" href="/coaching">Book a coaching session</Link>}
        </section>
      </div>
    </main>
  );
}
