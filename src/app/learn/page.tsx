import Link from "next/link";
import { listLearnerCertificates } from "@/features/certificates/service";
import { redirect } from "next/navigation";
import { getServerSession } from "@/lib/auth";
import { getAccessibleEnrollments } from "@/features/enrollments/service";
import { getBatchedEnrollmentProgress, compareEnrollmentActivity } from "@/features/progress/service";
import { getPublishedCourses, getPublishedLessonCounts } from "@/features/courses/service";

export const metadata = {
  title: "Continue learning | Decoded Hiring",
  description: "Your classroom home — resume where you left off.",
};

export default async function LearnHomePage() {
  const session = await getServerSession();
  // The layout redirects anonymous visitors too, but layout and page render
  // concurrently, so the page must not assume a session exists.
  if (!session?.user) redirect("/login?redirect=/learn");
  const userId = session.user.id;

  // QUERY SHAPE (batched dashboard): 1 enrollments read + the domain-owned
  // batched progress path (course metadata, published curriculum, progress
  // rows including activity timestamps, current stored states — all ONE query
  // per table, bounded as the enrollment count grows). NO per-enrollment getEnrollmentProgress and NO
  // getCoursesByIds fan-out; cancelled enrollments are filtered BEFORE any
  // progress work so they never appear here and never reconcile.
  const memberships = await getAccessibleEnrollments(userId);
  const [batchedProgress, published, certificates] = await Promise.all([
    getBatchedEnrollmentProgress(memberships), getPublishedCourses(), listLearnerCertificates(userId),
  ]);
  const enrolledIds = new Set(memberships.map((enrollment) => enrollment.courseId));
  const explore = published.filter((course) => !enrolledIds.has(course.id)).slice(0, 2);
  const lessonCounts = await getPublishedLessonCounts(explore.map((course) => course.id));

  const cards = memberships
    .map((enrollment) => {
      const progress = batchedProgress.get(enrollment.id);
      if (!progress) return null;
      return { enrollment, progress, lessonCount: progress.totalPublished };
    })
    .filter((r) => r !== null);

  const inProgress = cards.filter((c) => !c.progress.completed).sort((a, b) => compareEnrollmentActivity(a.progress, b.progress));
  const completed = cards.filter((c) => c.progress.completed);
  // First in-progress course that has a lesson to resume (newest activity first).
  const spotlight = inProgress.find((c) => c.progress.resumeLessonId) ?? null;

  return (
    <main className="sec-app learner-page" id="main">
      <div className="wrap learner-column">
        <p className="a-micro learner-mb-6">WELCOME BACK, {(session.user.name || "LEARNER").toUpperCase()}</p>
        <h1 className="a-h1 learner-mb-28">Continue learning</h1>

        <section className="learner-section" aria-labelledby="certificates-h">
          <h2 className="a-h2" id="certificates-h">Certificates</h2>
          {certificates.length === 0 ? <p>No certificates yet.</p> : <ul>
            {certificates.map((certificate) => <li key={certificate.id}>
              <Link href={`/certificates/${certificate.id}`}>{certificate.courseTitle}</Link>
              {certificate.revokedAt && " · Revoked"}
            </li>)}
          </ul>}
        </section>
        {cards.length === 0 && (
          <div className="learner-empty">
            <b className="learner-empty-title">No enrollments yet</b>
            <p className="muted-strong learner-empty-intro">
              Browse the course catalog and enroll free — your classroom will remember your place.
            </p>
            <div className="learner-mt-16">
              <Link className="btn primary learner-link" href="/learn/courses">
                Browse courses →
              </Link>
            </div>
          </div>
        )}

        {spotlight && spotlight.progress.resumeLessonId && (
          <Link
            className="continue-card learner-inherit learner-link"
            href={`/learn/courses/${spotlight.progress.courseSlug}/lessons/${spotlight.progress.resumeLessonSlug}`}
          >
            <div className="cc-top">
              <div>
                <h3>{spotlight.progress.courseTitle}</h3>
                <p className="cc-lesson">
                  Next up · <em>{spotlight.progress.resumeLessonTitle}</em>
                </p>
              </div>
              <span className="cc-count mono">
                {spotlight.progress.completedRequired} / {spotlight.progress.totalRequired} LESSONS
              </span>
            </div>
            <div>
              <div className="cc-bar"><i style={{ width: `${spotlight.progress.percent}%` }}></i></div>
              <div className="learner-spotlight-footer">
                <span className="cc-count">Progress counts required lessons only</span>
                <span className="btn primary small">Resume lesson →</span>
              </div>
            </div>
          </Link>
        )}

        {inProgress.length > 0 && (
          <section className="learner-section" aria-labelledby="mc-h">
            <div className="learner-section-heading">
              <h2 className="a-h2" id="mc-h">My courses</h2>
              <Link href="/learn/courses" className="a-micro learner-catalog-link">
                All courses →
              </Link>
            </div>
            <div className="course-cards learner-course-list">
              {inProgress.map((c) => (
                <Link
                  key={c.enrollment.id}
                  className="course-card learner-course-row"
                  href={`/learn/courses/${c.progress.courseSlug}`}
                >
                  <div className="cc-cover">{c.progress.courseTitle.slice(0, 2).toUpperCase()}</div>
                  <div className="cc-body">
                    <h3>{c.progress.courseTitle}</h3>
                    <p className="cc-meta">
                      {c.lessonCount} lessons · <span className="lifecycle published learner-enrolled-badge">ENROLLED · {c.progress.courseAccessMode}</span>
                    </p>
                    <div className="cc-progress">
                      <span className="progress-ring" style={{ ["--p" as string]: c.progress.percent }}>
                        <i>{c.progress.percent}%</i>
                      </span>
                      <span className="txt">
                        <b className="learner-ink">{c.progress.completedRequired} of {c.progress.totalRequired}</b> required lessons complete
                      </span>
                      <span className="cc-state learner-in-progress">In progress</span>
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          </section>
        )}

        {completed.length > 0 && (
          <section className="learner-section" aria-labelledby="done-h">
            <h2 className="a-h2" id="done-h">Completed</h2>
            <div className="learner-completed-list">
              {completed.map((c) => (
                <div className="learner-completed-row" key={c.enrollment.id}>
                  <span className="progress-ring learner-ring-complete"><i>✓</i></span>
                  <div className="learner-completed-title">
                    <b className="learner-completed-name">{c.progress.courseTitle}</b>
                    <p className="cc-meta">Completed{c.progress.enrollmentCompletedAt ? ` · ${new Date(c.progress.enrollmentCompletedAt).toLocaleDateString()}` : ""}</p>
                  </div>
                  <Link className="btn secondary small" href={`/learn/courses/${c.progress.courseSlug}/complete`}>See completion</Link>
                  <Link className="btn secondary small learner-link" href={`/learn/courses/${c.progress.courseSlug}`}>
                    Review
                  </Link>
                </div>
              ))}
            </div>
          </section>
        )}
        {explore.length > 0 && (
          <section className="learner-section" aria-labelledby="explore-h">
            <h2 className="a-h2" id="explore-h">Explore more courses</h2>
            <div className="course-cards learner-mt-18">
              {explore.map((course) => (
                <Link className="course-card" href={`/learn/courses/${course.slug}`} key={course.id}>
                  <div className="cc-cover">{course.title.slice(0, 2).toUpperCase()}</div>
                  <div className="cc-body"><h3>{course.title}</h3><p className="cc-meta">{lessonCounts[course.id] ?? 0} lessons</p></div>
                </Link>
              ))}
            </div>
          </section>
        )}
      </div>
    </main>
  );
}
