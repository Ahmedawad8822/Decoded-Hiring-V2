import { and, asc, eq } from "drizzle-orm";
import { courseSections, getDb, lessons, type Lesson } from "@/lib/db";
import { getLessonResources, parseLessonBody } from "./service";
import { buildYouTubeEmbedUrl } from "./youtube";

/** Only published navigation data; no bodies, resource keys, dates or learner state. */
export type PublishedLessonSummary = Pick<Lesson, "id" | "courseId" | "slug" | "title" | "required">;

/** Uncached loader, also exercised directly under tsx (no Next request scope). */
export async function prepareCourseContent(courseId: string) {
  const db = await getDb();
  const [sections, publishedLessons] = await Promise.all([
    db.select({ id: courseSections.id, title: courseSections.title })
      .from(courseSections).where(eq(courseSections.courseId, courseId))
      .orderBy(asc(courseSections.position), asc(courseSections.createdAt)),
    db.select({
      id: lessons.id, courseId: lessons.courseId, sectionId: lessons.sectionId,
      slug: lessons.slug, title: lessons.title, required: lessons.required,
    }).from(lessons)
      .where(and(eq(lessons.courseId, courseId), eq(lessons.status, "published")))
      .orderBy(asc(lessons.position), asc(lessons.createdAt)),
  ]);
  const bySection = new Map<string, PublishedLessonSummary[]>();
  for (const { sectionId, ...lesson } of publishedLessons) {
    const bucket = bySection.get(sectionId) ?? [];
    bucket.push(lesson);
    bySection.set(sectionId, bucket);
  }
  const curriculum = sections.map((section) => ({
    section, publishedLessons: bySection.get(section.id) ?? [],
  }));
  const flat = curriculum.flatMap((entry) => entry.publishedLessons);
  const navigation = Object.fromEntries(flat.map((lesson, index) => [lesson.id, {
    position: index + 1, prev: flat[index - 1] ?? null, next: flat[index + 1] ?? null,
  }]));
  return { curriculum, publishedLessons: flat, navigation };
}

/** Published content only. JSON parsing and video/resource preparation happen on a miss. */
export async function prepareLessonContent(courseId: string, lessonId: string) {
  const db = await getDb();
  const lesson = await db.select().from(lessons).where(and(
    eq(lessons.id, lessonId), eq(lessons.courseId, courseId), eq(lessons.status, "published"),
  )).get();
  if (!lesson) return null;
  const resources = await getLessonResources(lessonId);
  return {
    blocks: parseLessonBody(lesson),
    embedUrl: lesson.videoUrl ? buildYouTubeEmbedUrl(lesson.videoUrl) : null,
    resources: resources.map(({ id, title, size }) => ({
      id, title, sizeLabel: (size / 1024).toFixed(0),
    })),
  };
}
