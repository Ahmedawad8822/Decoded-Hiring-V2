import { redirect, notFound } from "next/navigation";
import { getServerSession } from "@/lib/auth";
import {
  getAdminCourseById,
  getCourseCurriculum,
  getCourseEnrollmentCount,
  getLessonCompletionCount,
  getLessonResources,
} from "@/features/courses/service";
import { CurriculumClient } from "./curriculum-client";

export const metadata = {
  title: "Curriculum · Studio | Decoded Hiring",
  description: "Course curriculum editor — sections, lessons, resources.",
};

export default async function AdminCurriculumPage(props: {
  params: Promise<{ courseId: string }>;
}) {
  const session = await getServerSession();
  if (!session?.user) redirect("/admin/login");
  const role = (session.user as { role?: string }).role;
  if (role !== "admin") redirect("/admin/login?error=forbidden");

  const { courseId } = await props.params;
  const course = await getAdminCourseById(courseId);
  if (!course) notFound();

  const curriculum = await getCourseCurriculum(courseId);
  const enrollmentCount = await getCourseEnrollmentCount(courseId);

  const sectionsWithLessons = await Promise.all(
    curriculum.map(async (entry) => ({
      section: entry.section,
      lessons: await Promise.all(
        entry.lessons.map(async (lesson) => ({
          lesson,
          completions: await getLessonCompletionCount(lesson.id),
          resources: await getLessonResources(lesson.id),
        }))
      ),
    }))
  );

  return (
    <CurriculumClient
      course={course}
      sections={sectionsWithLessons}
      enrollmentCount={enrollmentCount}
    />
  );
}
