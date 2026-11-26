import { desc, eq } from "drizzle-orm";

import { courses, getDb, type Course } from "@/lib/db";
import { getCourseCurriculum } from "./service";
import { getQuizLessonIds } from "@/features/quizzes/service";

// ============================================================================
// PUBLIC COURSE SALES READS (website `/courses`)
// ----------------------------------------------------------------------------
// Cacheable public projections for the sales pages. These deliberately share
// the classroom data functions (curriculum shape, quiz flags) but project
// ONLY public fields: no lesson bodies, no video URLs, no learner or
// enrollment data. The pages that consume them never read the session, so the
// ISR cache stays shared across all visitors.
//
// Only `published`, non-trashed courses are visible. Drafts and archived
// courses return null (-> 404, with slug redirects honoured by the page).
// The Trash lifecycle (`trashed_at`) is being added by a parallel change: it
// is detected at runtime (`isTrashedCourse`) so a trashed course is treated
// as missing whether or not the column has landed yet. This file adds no
// migration itself.
// ============================================================================

/** Runtime Trash check. True when a trash timestamp is present, whatever the
 *  column's serialised key (`trashedAt` Drizzle model vs `trashed_at` raw). */
export function isTrashedCourse(
  course: Pick<Course, "status"> & Record<string, unknown>,
): boolean {
  const marker =
    (course as Record<string, unknown>).trashedAt ??
    (course as Record<string, unknown>).trashed_at;
  return marker !== undefined && marker !== null;
}

/** Published, non-trashed course by slug — null otherwise (-> 404). */
export async function getPublicCourseBySlug(slug: string): Promise<Course | null> {
  const db = await getDb();
  const course = await db.select().from(courses).where(eq(courses.slug, slug)).get();
  if (!course || course.status !== "published" || isTrashedCourse(course)) return null;
  return course;
}

/** All published, non-trashed courses for the `/courses` list and sitemap.
 *  Trashed rows are filtered in memory so the list stays correct before and
 *  after the Trash column lands; the source query filters on status (there
 *  is no status index — the courses table is small, so this stays a single
 *  cheap read). */
export async function getPublicCourses(): Promise<Course[]> {
  const db = await getDb();
  const rows = await db
    .select()
    .from(courses)
    .where(eq(courses.status, "published"))
    .orderBy(desc(courses.publishedAt), desc(courses.updatedAt));
  return rows.filter((course) => !isTrashedCourse(course));
}

export type PublicSalesLesson = {
  id: string;
  title: string;
  slug: string;
  isPreview: boolean;
  durationMinutes: number | null;
  required: boolean;
  /** "video" when the lesson has a video, else "reading" — the raw URL is
   *  never projected; previews stay reachable only from the classroom. */
  kind: "video" | "reading";
  hasQuiz: boolean;
};

export type PublicSalesSection = {
  id: string;
  title: string;
  lessons: PublicSalesLesson[];
};

/** Curriculum preview: sections and PUBLISHED lesson titles with durations,
 *  preview flags and type hints. Lesson bodies, video URLs, resources and
 *  drip schedules are never projected. */
export async function getPublicCourseCurriculum(
  courseId: string,
): Promise<PublicSalesSection[]> {
  const [curriculum, quizLessonIds] = await Promise.all([
    getCourseCurriculum(courseId),
    getQuizLessonIds(courseId),
  ]);
  return curriculum.map((entry) => ({
    id: entry.section.id,
    title: entry.section.title,
    lessons: entry.publishedLessons.map((lesson) => ({
      id: lesson.id,
      title: lesson.title,
      slug: lesson.slug,
      isPreview: lesson.isPreview,
      durationMinutes: lesson.durationMinutes,
      required: lesson.required,
      kind: lesson.videoUrl ? ("video" as const) : ("reading" as const),
      hasQuiz: quizLessonIds.has(lesson.id),
    })),
  }));
}
