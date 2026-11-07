import { revalidateTag } from "next/cache";

/** All live content writes enter via Studio actions or the resource upload route. */
export function invalidateCourseContent(courseId: string, lessonId?: string) {
  // No stale-while-revalidate: an unpublish must be a blocking miss next time.
  revalidateTag(`course:${courseId}`, { expire: 0 });
  if (lessonId) revalidateTag(`lesson:${lessonId}`, { expire: 0 });
}
