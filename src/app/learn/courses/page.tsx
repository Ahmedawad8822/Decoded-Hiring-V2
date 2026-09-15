import Link from "next/link";
import { getServerSession } from "@/lib/auth";
import { getUserEnrollments } from "@/features/enrollments/service";
import { getEnrollmentProgress } from "@/features/progress/service";
import {
  getAdminCourseById,
  getPublishedCourses,
  getPublishedCourseLessons,
} from "@/features/courses/service";

export const metadata = {
  title: "My courses | Decoded Hiring",
  description: "Every course you are enrolled in — plus the free catalog.",
};

export default async function LearnCoursesPage() {
  const session = await getServerSession();
  const userId = session!.user.id;

  const memberships = await getUserEnrollments(userId);
  const enrolledIds = new Set(memberships.map((e) => e.courseId));

  const enrolled = (
    await Promise.all(
      memberships.map(async (enrollment) => {
        const course = await getAdminCourseById(enrollment.courseId);
        if (!course) return null;
        const progress = await getEnrollmentProgress(enrollment);
        return { enrollment, course, progress };
      })
    )
  ).filter((r) => r !== null);

  const catalog = (await getPublishedCourses()).filter((c) => !enrolledIds.has(c.id));
  const catalogCounts = await Promise.all(catalog.map((c) => getPublishedCourseLessons(c.id)));

  return (
    <main className="sec-app" id="main" style={{ padding: "clamp(24px,4vw,48px) 0" }}>
      <div className="wrap" style={{ maxWidth: 880 }}>
        <h1 className="a-h1" style={{ marginBottom: 6 }}>My courses</h1>
        <p className="muted" style={{ marginBottom: 24 }}>Enrolled first. The free catalog follows.</p>

        {enrolled.length === 0 && (
          <p className="muted-strong" style={{ fontSize: 14 }}>
            You are not enrolled in anything yet — the free courses below enroll instantly.
          </p>
        )}

        <div className="course-cards" style={{ marginTop: 18, gridTemplateColumns: "1fr" }}>
          {enrolled.map((c) => (
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
                  <span className="lifecycle published" style={{ fontSize: 10 }}>
                    {c!.progress.completed ? "COMPLETED" : "ENROLLED"} · {c!.course.accessMode}
                  </span>
                </p>
                <div className="cc-progress">
                  <span className="progress-ring" style={{ ["--p" as string]: c!.progress.percent }}>
                    <i>{c!.progress.completed ? "✓" : `${c!.progress.percent}%`}</i>
                  </span>
                  <span className="txt">
                    <b style={{ color: "var(--ink)" }}>{c!.progress.completedRequired} of {c!.progress.totalRequired}</b> required lessons complete
                  </span>
                </div>
              </div>
            </Link>
          ))}
        </div>

        <section style={{ marginTop: 44 }} aria-labelledby="catalog-h">
          <h2 className="a-h2" id="catalog-h">Free catalog</h2>
          <div className="course-cards" style={{ marginTop: 18, gridTemplateColumns: "1fr" }}>
            {catalog.length === 0 && (
              <p className="muted" style={{ fontSize: 13.5 }}>Nothing new right now — you hold every published course.</p>
            )}
            {catalog.map((course, i) => (
              <Link
                key={course.id}
                className="course-card"
                href={`/learn/courses/${course.slug}`}
                style={{ maxWidth: 640, textDecoration: "none", color: "inherit" }}
              >
                <div className="cc-cover">{course.title.slice(0, 2).toUpperCase()}</div>
                <div className="cc-body">
                  <h3>{course.title}</h3>
                  <p className="cc-meta">
                    {catalogCounts[i].length} lessons · <span className="lifecycle published" style={{ fontSize: 10 }}>{course.accessMode}</span>
                  </p>
                  {course.description && (
                    <p className="txt" style={{ fontSize: 13 }}>{course.description.slice(0, 140)}</p>
                  )}
                </div>
              </Link>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}
