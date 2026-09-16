import Link from "next/link";
import { getServerSession } from "@/lib/auth";
import { getAccessibleEnrollments } from "@/features/enrollments/service";
import { getBatchedEnrollmentProgress } from "@/features/progress/service";
import {
  getPublishedCourses,
  getPublishedLessonCounts,
} from "@/features/courses/service";

export const metadata = {
  title: "My courses | Decoded Hiring",
  description: "Every course you are enrolled in — plus the course catalog.",
};

export default async function LearnCoursesPage() {
  const session = await getServerSession();
  const userId = session!.user.id;

  // BATCHED PROGRESS (Item E): ONE query per table instead of per-enrollment fan-out.
  // Batches: enrollments, course metadata, published curriculum, progress rows,
  // reconciliation states. Query count bounded as enrollment count grows.
  const memberships = await getAccessibleEnrollments(userId);
  const enrolledIds = new Set(memberships.map((e) => e.courseId));

  // Single batched progress call replaces N individual getEnrollmentProgress calls
  const batchedProgress = await getBatchedEnrollmentProgress(memberships);

  const enrolled = memberships
    .map((enrollment) => {
      const progress = batchedProgress.get(enrollment.id);
      if (!progress) return null;
      return { enrollment, course: progress, progress };
    })
    .filter((r) => r !== null);

  const catalog = (await getPublishedCourses()).filter((c) => !enrolledIds.has(c.id));
  // PERFORMANCE (review correction G): ONE grouped COUNT instead of N
  // full-lesson-row fetches — the page only renders the lesson total.
  const catalogCounts = await getPublishedLessonCounts(catalog.map((c) => c.id));

  return (
    <main className="sec-app" id="main" style={{ padding: "clamp(24px,4vw,48px) 0" }}>
      <div className="wrap" style={{ maxWidth: 880 }}>
        <h1 className="a-h1" style={{ marginBottom: 6 }}>My courses</h1>
        <p className="muted" style={{ marginBottom: 24 }}>Enrolled first. The catalog follows.</p>

        {enrolled.length === 0 && (
          <p className="muted-strong" style={{ fontSize: 14 }}>
            You are not enrolled in anything yet — browse the catalog below to find your next course.
          </p>
        )}

        <div className="course-cards" style={{ marginTop: 18, gridTemplateColumns: "1fr" }}>
          {enrolled.map((c) => (
            <Link
              key={c!.enrollment.id}
              className="course-card"
              href={`/learn/courses/${c!.progress.courseSlug}`}
              style={{ maxWidth: 640, textDecoration: "none", color: "inherit" }}
            >
              <div className="cc-cover">{c!.progress.courseTitle.slice(0, 2).toUpperCase()}</div>
              <div className="cc-body">
                <h3>{c!.progress.courseTitle}</h3>
                <p className="cc-meta">
                  <span className="lifecycle published" style={{ fontSize: 10 }}>
                    {c!.progress.completed ? "COMPLETED" : "ENROLLED"} · {c!.progress.courseAccessMode}
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
          <h2 className="a-h2" id="catalog-h">Course catalog</h2>
          <div className="course-cards" style={{ marginTop: 18, gridTemplateColumns: "1fr" }}>
            {catalog.length === 0 && (
              <p className="muted" style={{ fontSize: 13.5 }}>Nothing new right now — you hold every published course.</p>
            )}
            {catalog.map((course) => (
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
                    {(catalogCounts[course.id] ?? 0)} lessons · <span className="lifecycle published" style={{ fontSize: 10 }}>{course.accessMode}</span>
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
