import { notFound } from "next/navigation";
import { requireAdminPage } from "@/lib/auth";
import {
  getAdminCourseById,
  getCourseCurriculum,
  getCourseEnrollmentCount,
  getLessonCompletionCounts,
  getLessonResourcesForLessons,
} from "@/features/courses/service";
import { CurriculumClient } from "./curriculum-client";

// Session-gated Studio route: render per request.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Curriculum · Studio | Decoded Hiring",
  description: "Course curriculum editor — sections, lessons, resources.",
};

export default async function AdminCurriculumPage(props: {
  params: Promise<{ courseId: string }>;
}) {
  await requireAdminPage();
  const { courseId } = await props.params;
  const course = await getAdminCourseById(courseId);
  if (!course) notFound();

  const curriculum = await getCourseCurriculum(courseId);
  const enrollmentCount = await getCourseEnrollmentCount(courseId);

  // PERFORMANCE (Mission 06): bounded query count, independent of lesson
  // count. The per-lesson getLessonCompletionCount()/getLessonResources()
  // fan-out (2N queries for N lessons) is replaced by TWO batched GROUP BY /
  // IN queries over the full lesson list, grouped in memory.
  const lessonIds = curriculum.flatMap((entry) => entry.lessons.map((lesson) => lesson.id));
  const [completionCounts, resourcesByLesson] = await Promise.all([
    getLessonCompletionCounts(lessonIds),
    getLessonResourcesForLessons(lessonIds),
  ]);

  const sectionsWithLessons = curriculum.map((entry) => ({
    section: entry.section,
    lessons: entry.lessons.map((lesson) => ({
      lesson,
      completions: completionCounts[lesson.id] ?? 0,
      resources: resourcesByLesson.get(lesson.id) ?? [],
    })),
  }));

  return (
    <CurriculumClient
      course={course}
      sections={sectionsWithLessons}
      enrollmentCount={enrollmentCount}
    />
  );
}
