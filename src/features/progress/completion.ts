import { getLearnerCourseBySlug } from "@/features/courses/service";
import { getEnrollment } from "@/features/enrollments/service";
import { hasLearnerAccess } from "@/features/enrollments/access";
import { getEnrollmentProgress } from "./service";

/** Read-only completion gate; cancelled enrollment never grants access. */
export async function getCourseCompletionState(userId: string, courseSlug: string) {
  const course = await getLearnerCourseBySlug(courseSlug, userId);
  if (!course) return { kind: "not_found" } as const;
  const enrollment = await getEnrollment(userId, course.id);
  if (!hasLearnerAccess(enrollment)) return { kind: "enrollment_required", course } as const;
  const progress = await getEnrollmentProgress(enrollment);
  if (!progress.completed) return { kind: "incomplete", course } as const;
  return { kind: "complete", course, enrollment, progress } as const;
}
