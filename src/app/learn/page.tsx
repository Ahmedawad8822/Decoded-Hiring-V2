import Link from "next/link";
import { getServerSession } from "@/lib/auth";
import { getUserEnrollments } from "@/features/enrollments/service";
import { getEnrollmentProgress } from "@/features/progress/service";
import { getAdminCourseById, getPublishedCourseLessons } from "@/features/courses/service";

export const metadata = {
  title: "Continue learning | Decoded Hiring",
  description: "Your classroom home — resume where you left off.",
};

export default async function LearnHomePage() {
  const session = await getServerSession();
  const userId = session!.user.id;

  const memberships = await getUserEnrollments(userId);
  const cards = await Promise.all(
    memberships.map(async (enrollment) => {
      const course = await getAdminCourseById(enrollment.courseId);
      if (!course) return null;
      const progress = await getEnrollmentProgress(enrollment);
      const published = await getPublishedCourseLessons(enrollment.courseId);
      return { enrollment, course, progress, lessonCount: published.length };
    })
  ).then((rows) => rows.filter((r) => r !== null));

  const inProgress = cards.filter((c) => !c!.progress.completed);
  const completed = cards.filter((c) => c!.progress.completed);
  const spotlight = inProgress[0] ?? null;

  return (
    <main className="sec-app" id="main" style={{ padding: "clamp(24px,4vw,48px) 0" }}>
      <div className="wrap" style={{ maxWidth: 880 }}>
        <p className="a-micro" style={{ marginBottom: 6 }}>WELCOME BACK, {(session!.user.name || "LEARNER").toUpperCase()}</p>
        <h1 className="a-h1" style={{ marginBottom: 28 }}>Continue learning</h1>

        {cards.length === 0 && (
          <div style={{ border: "1px solid var(--line)", borderRadius: "var(--radius-card)", background: "var(--paper-bright)", padding: "28px 24px" }}>
            <b style={{ fontSize: 15 }}>No enrollments yet</b>
            <p className="muted-strong" style={{ marginTop: 8, fontSize: 14, lineHeight: 1.6 }}>
              Browse the course catalog and enroll free — your classroom will remember your place.
            </p>
            <div style={{ marginTop: 16 }}>
              <Link className="btn primary" href="/learn/courses" style={{ textDecoration: "none" }}>
                Browse courses →
              </Link>
            </div>
          </div>
        )}

        {spotlight && spotlight.progress.resumeLesson && (
          <Link
            className="continue-card"
            href={`/learn/courses/${spotlight.course.slug}/lessons/${spotlight.progress.resumeLesson.slug}`}
            style={{ color: "inherit", textDecoration: "none" }}
          >
            <div className="cc-top">
              <div>
                <h3>{spotlight.course.title}</h3>
                <p className="cc-lesson">
                  Next up · <em>{spotlight.progress.resumeLesson.title}</em>
                </p>
              </div>
              <span className="cc-count mono">
                {spotlight.progress.completedRequired} / {spotlight.progress.totalRequired} LESSONS
              </span>
            </div>
            <div>
              <div className="cc-bar"><i style={{ width: `${spotlight.progress.percent}%` }}></i></div>
              <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8 }}>
                <span className="cc-count">Progress counts required lessons only</span>
                <span className="btn primary small">Resume lesson →</span>
              </div>
            </div>
          </Link>
        )}

        {cards.length > 0 && (
          <section style={{ marginTop: 44 }} aria-labelledby="mc-h">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
              <h2 className="a-h2" id="mc-h">My courses</h2>
              <Link href="/learn/courses" className="a-micro" style={{ color: "var(--blue)", textDecoration: "none", textTransform: "none", letterSpacing: 0 }}>
                All courses →
              </Link>
            </div>
            <div className="course-cards" style={{ marginTop: 18, gridTemplateColumns: "1fr" }}>
              {inProgress.map((c) => (
                <Link
                  key={c!.enrollment.id}
                  className="course-card"
                  href={`/learn/courses/${c!.course.slug}`}
                  style={{ maxWidth: 640, textDecoration: "none", color: "inherit" }}
                >
                  <div className="cc-cover">{c!.course.title.slice(0, 2).toUpperCase()}</div>
                  <div className="cc-body">
                    <h3>{c!.course.title}</h3>
                    <p className="cc-meta">
                      {c!.lessonCount} lessons · <span className="lifecycle published" style={{ fontSize: 10 }}>ENROLLED · {c!.course.accessMode}</span>
                    </p>
                    <div className="cc-progress">
                      <span className="progress-ring" style={{ ["--p" as string]: c!.progress.percent }}>
                        <i>{c!.progress.percent}%</i>
                      </span>
                      <span className="txt">
                        <b style={{ color: "var(--ink)" }}>{c!.progress.completedRequired} of {c!.progress.totalRequired}</b> required lessons complete
                      </span>
                      <span className="cc-state" style={{ marginLeft: "auto", color: "var(--blue)" }}>In progress</span>
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          </section>
        )}

        {completed.length > 0 && (
          <section style={{ marginTop: 44 }} aria-labelledby="done-h">
            <h2 className="a-h2" id="done-h">Completed</h2>
            <div style={{ display: "grid", gap: 12, marginTop: 18 }}>
              {completed.map((c) => (
                <div key={c!.enrollment.id} style={{ border: "1px solid var(--line)", borderRadius: "var(--radius-card)", background: "var(--paper-bright)", padding: "18px 20px", display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
                  <span className="progress-ring" style={{ ["--p" as string]: 100 }}><i>✓</i></span>
                  <div style={{ flex: 1, minWidth: 200 }}>
                    <b style={{ fontSize: 14.5 }}>{c!.course.title}</b>
                    <p className="cc-meta">Completed{c!.enrollment.completedAt ? ` · ${new Date(c!.enrollment.completedAt).toLocaleDateString()}` : ""}</p>
                  </div>
                  <Link className="btn secondary small" href={`/learn/courses/${c!.course.slug}`} style={{ textDecoration: "none" }}>
                    Review
                  </Link>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </main>
  );
}
