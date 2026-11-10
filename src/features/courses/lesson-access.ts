import type { Course, Lesson } from "@/lib/db";

/** Read access only. Preview never grants enrollment, downloads or progress writes. */
export function getLessonReadAccess({
  signedIn, enrolled, course, lesson,
}: {
  signedIn: boolean;
  enrolled: boolean;
  course: Pick<Course, "id" | "status">;
  lesson: Pick<Lesson, "courseId" | "status" | "isPreview">;
}): "enrolled" | "preview" | "denied" {
  if (!signedIn || lesson.courseId !== course.id || lesson.status !== "published") return "denied";
  if (enrolled && (course.status === "published" || course.status === "archived")) return "enrolled";
  if (course.status === "published" && lesson.isPreview) return "preview";
  return "denied";
}
