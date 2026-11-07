import { unstable_cache } from "next/cache";
import { prepareCourseContent, prepareLessonContent } from "./content-data";

// Next 16's use cache/cacheTag require app-wide Cache Components. Keep the
// existing rendering model and use the supported incremental Data Cache API.
// No session, headers, enrollment, access policy or progress enters this scope.
export function getCachedCourseContent(courseId: string) {
  return unstable_cache(prepareCourseContent, ["learner-course-content-v1"], {
    tags: [`course:${courseId}`], revalidate: false,
  })(courseId);
}

// Call only AFTER live publication + enrollment checks. Course tagging also
// expires lesson entries when course metadata or lifecycle changes.
export function getCachedLessonContent(courseId: string, lessonId: string) {
  return unstable_cache(prepareLessonContent, ["learner-lesson-content-v1"], {
    tags: [`course:${courseId}`, `lesson:${lessonId}`], revalidate: false,
  })(courseId, lessonId);
}
