import { getDb } from "@/lib/db";
import {
  courses,
  courseSections,
  lessons,
  lessonResources,
  enrollments,
  lessonProgress,
  type Course,
  type CourseSection,
  type Lesson,
} from "@/lib/db";
import { and, asc, desc, eq, inArray, like, ne, or, sql } from "drizzle-orm";
import {
  buildArchiveUpdate,
  buildEditTouch,
  buildPublishUpdate,
  buildUnpublishUpdate,
} from "@/features/publishing/lifecycle";
import type { ContentBlock } from "@/features/publishing/types";
import { slugifyTitle } from "@/features/publishing/types";
import { extractYouTubeVideoId } from "./youtube";
import type {
  CreateCourseInput,
  CreateLessonInput,
  CreateSectionInput,
  UpdateCourseInput,
  UpdateLessonInput,
} from "./types";
import { hasLearnerAccess } from "@/features/enrollments/access";

// ============================================================================
// COURSES SERVICE (Mission 06)
// Explicit per-domain DB access. No generic repositories.
// ============================================================================

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().slice(0, 12)}`;
}

// ---------------------------------------------------------------- Admin reads

export async function getAllAdminCourses(options?: {
  search?: string;
  status?: "draft" | "published" | "archived" | "all";
}): Promise<Course[]> {
  const db = await getDb();
  const conditions = [];
  if (options?.status && options.status !== "all") {
    conditions.push(eq(courses.status, options.status));
  }
  if (options?.search?.trim()) {
    const q = `%${options.search.trim()}%`;
    conditions.push(or(like(courses.title, q), like(courses.slug, q)));
  }
  const where = conditions.length > 0 ? and(...conditions) : undefined;
  return db.select().from(courses).where(where).orderBy(desc(courses.updatedAt));
}

export async function getAdminCourseById(id: string): Promise<Course | null> {
  const db = await getDb();
  const course = await db.select().from(courses).where(eq(courses.id, id)).get();
  return course || null;
}

export async function getAdminCourseBySlug(slug: string): Promise<Course | null> {
  const db = await getDb();
  const course = await db.select().from(courses).where(eq(courses.slug, slug)).get();
  return course || null;
}

// ---------------------------------------------------------------- Admin writes

export async function createCourse(input: CreateCourseInput): Promise<Course> {
  const db = await getDb();
  const slug = input.slug || slugifyTitle(input.title);

  const existing = await db.select().from(courses).where(eq(courses.slug, slug)).get();
  if (existing) {
    throw new Error(`A course with the slug "${slug}" already exists. Please choose a unique slug.`);
  }

  const now = new Date();
  const id = newId("course");
  await db.insert(courses).values({
    id,
    title: input.title,
    slug,
    description: input.description || null,
    status: "draft",
    accessMode: input.accessMode ?? "FREE",
    coverImage: input.coverImage || null,
    createdAt: now,
    updatedAt: now,
    publishedAt: null,
  });

  const created = await getAdminCourseById(id);
  if (!created) throw new Error("Failed to retrieve created course");
  return created;
}

export async function updateCourse(id: string, input: UpdateCourseInput): Promise<Course> {
  const db = await getDb();
  const current = await getAdminCourseById(id);
  if (!current) throw new Error(`Course with id "${id}" not found`);

  if (input.slug && input.slug !== current.slug) {
    const clash = await db
      .select()
      .from(courses)
      .where(and(eq(courses.slug, input.slug), ne(courses.id, id)))
      .get();
    if (clash) throw new Error(`A course with the slug "${input.slug}" already exists.`);
  }

  const now = new Date();
  const patch: Partial<typeof courses.$inferInsert> = { ...buildEditTouch(now) };
  if (typeof input.title !== "undefined") patch.title = input.title;
  if (typeof input.slug !== "undefined") patch.slug = input.slug;
  if (typeof input.description !== "undefined") patch.description = input.description || null;
  if (typeof input.accessMode !== "undefined") patch.accessMode = input.accessMode;
  if (typeof input.coverImage !== "undefined") patch.coverImage = input.coverImage || null;

  await db.update(courses).set(patch).where(eq(courses.id, id));
  const updated = await getAdminCourseById(id);
  if (!updated) throw new Error("Failed to retrieve updated course");
  return updated;
}

export async function publishCourse(id: string): Promise<Course> {
  const db = await getDb();
  const current = await getAdminCourseById(id);
  if (!current) throw new Error(`Course with id "${id}" not found`);
  if (current.status === "archived") {
    throw new Error("Cannot publish an archived course. Archived courses are terminal.");
  }
  if (current.status === "published") {
    throw new Error(`Cannot publish a course with status "published".`);
  }
  await db.update(courses).set(buildPublishUpdate(current)).where(eq(courses.id, id));
  return (await getAdminCourseById(id))!;
}

export async function unpublishCourse(id: string): Promise<Course> {
  const db = await getDb();
  const current = await getAdminCourseById(id);
  if (!current) throw new Error(`Course with id "${id}" not found`);
  if (current.status !== "published") {
    throw new Error(`Cannot unpublish a course with status "${current.status}".`);
  }
  await db.update(courses).set(buildUnpublishUpdate()).where(eq(courses.id, id));
  return (await getAdminCourseById(id))!;
}

export async function archiveCourse(id: string): Promise<Course> {
  const db = await getDb();
  const current = await getAdminCourseById(id);
  if (!current) throw new Error(`Course with id "${id}" not found`);
  if (current.status === "archived") {
    throw new Error(`Cannot archive a course with status "archived".`);
  }
  await db.update(courses).set(buildArchiveUpdate()).where(eq(courses.id, id));
  return (await getAdminCourseById(id))!;
}

// No permanent delete in Mission 06 — guarded by design. If a future caller
// needs it, it must refuse when enrollments or progress exist.
export async function assertCourseDeletable(id: string): Promise<void> {
  const db = await getDb();
  const deps = await db.select().from(enrollments).where(eq(enrollments.courseId, id)).get();
  if (deps) {
    throw new Error("Cannot delete a course with active enrollments. Archive it instead.");
  }
}

// ---------------------------------------------------------------- Sections

export async function getCourseSections(courseId: string): Promise<CourseSection[]> {
  const db = await getDb();
  return db
    .select()
    .from(courseSections)
    .where(eq(courseSections.courseId, courseId))
    .orderBy(asc(courseSections.position), asc(courseSections.createdAt));
}

export async function createSection(input: CreateSectionInput): Promise<CourseSection> {
  const db = await getDb();
  const course = await getAdminCourseById(input.courseId);
  if (!course) throw new Error(`Course with id "${input.courseId}" not found`);

  const siblings = await getCourseSections(input.courseId);
  const position = siblings.length > 0 ? Math.max(...siblings.map((s) => s.position)) + 1 : 0;
  const now = new Date();
  const id = newId("section");
  await db.insert(courseSections).values({
    id,
    courseId: input.courseId,
    title: input.title,
    position,
    createdAt: now,
    updatedAt: now,
  });
  const created = await db.select().from(courseSections).where(eq(courseSections.id, id)).get();
  if (!created) throw new Error("Failed to retrieve created section");
  return created;
}

export async function renameSection(id: string, title: string): Promise<CourseSection> {
  const db = await getDb();
  const current = await db.select().from(courseSections).where(eq(courseSections.id, id)).get();
  if (!current) throw new Error(`Section with id "${id}" not found`);
  await db
    .update(courseSections)
    .set({ title, updatedAt: new Date() })
    .where(eq(courseSections.id, id));
  return (await db.select().from(courseSections).where(eq(courseSections.id, id)).get())!;
}

export async function moveSection(id: string, direction: "up" | "down"): Promise<CourseSection[]> {
  const db = await getDb();
  const current = await db.select().from(courseSections).where(eq(courseSections.id, id)).get();
  if (!current) throw new Error(`Section with id "${id}" not found`);
  const siblings = await getCourseSections(current.courseId);
  const idx = siblings.findIndex((s) => s.id === id);
  const swapIdx = direction === "up" ? idx - 1 : idx + 1;
  if (idx < 0 || swapIdx < 0 || swapIdx >= siblings.length) return siblings;
  const other = siblings[swapIdx];
  const now = new Date();
  await db.update(courseSections).set({ position: other.position, updatedAt: now }).where(eq(courseSections.id, current.id));
  await db.update(courseSections).set({ position: current.position, updatedAt: now }).where(eq(courseSections.id, other.id));
  return getCourseSections(current.courseId);
}

// ---------------------------------------------------------------- Lessons

export async function getSectionLessons(sectionId: string): Promise<Lesson[]> {
  const db = await getDb();
  return db
    .select()
    .from(lessons)
    .where(eq(lessons.sectionId, sectionId))
    .orderBy(asc(lessons.position), asc(lessons.createdAt));
}

export async function getCourseLessons(courseId: string): Promise<Lesson[]> {
  const db = await getDb();
  return db
    .select()
    .from(lessons)
    .where(eq(lessons.courseId, courseId))
    .orderBy(asc(lessons.position));
}

export async function getAdminLessonById(id: string): Promise<Lesson | null> {
  const db = await getDb();
  const lesson = await db.select().from(lessons).where(eq(lessons.id, id)).get();
  return lesson || null;
}

function normalizeVideoUrl(raw?: string | null): string | null {
  if (!raw || !raw.trim()) return null;
  if (!extractYouTubeVideoId(raw)) {
    throw new Error("Video URL must be a valid YouTube watch, youtu.be, embed, shorts, or live URL — or a bare video ID.");
  }
  return raw.trim();
}

export async function createLesson(input: CreateLessonInput): Promise<Lesson> {
  const db = await getDb();
  const course = await getAdminCourseById(input.courseId);
  if (!course) throw new Error(`Course with id "${input.courseId}" not found`);
  const section = await db.select().from(courseSections).where(eq(courseSections.id, input.sectionId)).get();
  if (!section || section.courseId !== input.courseId) {
    throw new Error("Section does not belong to this course.");
  }

  const slug = input.slug || slugifyTitle(input.title);
  const clash = await db
    .select()
    .from(lessons)
    .where(and(eq(lessons.courseId, input.courseId), eq(lessons.slug, slug)))
    .get();
  if (clash) {
    throw new Error(`A lesson with the slug "${slug}" already exists in this course.`);
  }

  const videoUrl = normalizeVideoUrl(input.videoUrl);
  const siblings = await getSectionLessons(input.sectionId);
  const position = siblings.length > 0 ? Math.max(...siblings.map((l) => l.position)) + 1 : 0;
  const now = new Date();
  const id = newId("lesson");
  await db.insert(lessons).values({
    id,
    courseId: input.courseId,
    sectionId: input.sectionId,
    title: input.title,
    slug,
    body: JSON.stringify(input.body ?? []),
    videoUrl,
    required: input.required ?? true,
    position,
    status: "draft",
    createdAt: now,
    updatedAt: now,
    publishedAt: null,
  });
  const created = await getAdminLessonById(id);
  if (!created) throw new Error("Failed to retrieve created lesson");
  return created;
}

export async function updateLesson(id: string, input: UpdateLessonInput): Promise<Lesson> {
  const db = await getDb();
  const current = await getAdminLessonById(id);
  if (!current) throw new Error(`Lesson with id "${id}" not found`);

  if (input.slug && input.slug !== current.slug) {
    const clash = await db
      .select()
      .from(lessons)
      .where(and(eq(lessons.courseId, current.courseId), eq(lessons.slug, input.slug), ne(lessons.id, id)))
      .get();
    if (clash) throw new Error(`A lesson with the slug "${input.slug}" already exists in this course.`);
  }

  const now = new Date();
  const patch: Partial<typeof lessons.$inferInsert> = { ...buildEditTouch(now) };
  if (typeof input.title !== "undefined") patch.title = input.title;
  if (typeof input.slug !== "undefined") patch.slug = input.slug;
  if (typeof input.body !== "undefined") patch.body = JSON.stringify(input.body);
  if (typeof input.videoUrl !== "undefined") patch.videoUrl = normalizeVideoUrl(input.videoUrl);
  if (typeof input.required !== "undefined") patch.required = input.required;

  await db.update(lessons).set(patch).where(eq(lessons.id, id));
  return (await getAdminLessonById(id))!;
}

export async function publishLesson(id: string): Promise<Lesson> {
  const db = await getDb();
  const current = await getAdminLessonById(id);
  if (!current) throw new Error(`Lesson with id "${id}" not found`);
  if (current.status === "published") throw new Error(`Cannot publish a lesson with status "published".`);
  await db.update(lessons).set(buildPublishUpdate(current)).where(eq(lessons.id, id));
  return (await getAdminLessonById(id))!;
}

export async function unpublishLesson(id: string): Promise<Lesson> {
  const db = await getDb();
  const current = await getAdminLessonById(id);
  if (!current) throw new Error(`Lesson with id "${id}" not found`);
  if (current.status !== "published") {
    throw new Error(`Cannot unpublish a lesson with status "${current.status}".`);
  }
  await db.update(lessons).set(buildUnpublishUpdate()).where(eq(lessons.id, id));
  return (await getAdminLessonById(id))!;
}

export async function moveLesson(id: string, direction: "up" | "down"): Promise<Lesson[]> {
  const db = await getDb();
  const current = await getAdminLessonById(id);
  if (!current) throw new Error(`Lesson with id "${id}" not found`);
  const siblings = await getSectionLessons(current.sectionId);
  const idx = siblings.findIndex((l) => l.id === id);
  const swapIdx = direction === "up" ? idx - 1 : idx + 1;
  if (idx < 0 || swapIdx < 0 || swapIdx >= siblings.length) return siblings;
  const other = siblings[swapIdx];
  const now = new Date();
  await db.update(lessons).set({ position: other.position, updatedAt: now }).where(eq(lessons.id, current.id));
  await db.update(lessons).set({ position: current.position, updatedAt: now }).where(eq(lessons.id, other.id));
  return getSectionLessons(current.sectionId);
}

// ---------------------------------------------------------------- Learner reads

export interface CurriculumSection {
  section: CourseSection;
  lessons: Lesson[];
  publishedLessons: Lesson[];
}

/** Published course by slug — null unless status=published (admin preview excluded in M06). */
export async function getPublishedCourseBySlug(slug: string): Promise<Course | null> {
  const db = await getDb();
  const course = await db.select().from(courses).where(eq(courses.slug, slug)).get();
  if (!course || course.status !== "published") return null;
  return course;
}

/**
 * Learner-visible course by slug (review correction D — archived access).
 * Published courses are visible to everyone. Archived courses 404 for the
 * public but remain fully visible to already-entitled learners
 * (hasLearnerAccess on their enrollment): no new enrollments (enrollFree
 * rejects archived), no revocation of earned access. Cancelled enrollments
 * see the archived course as 404 — same as strangers.
 */
export async function getLearnerCourseBySlug(
  slug: string,
  userId: string | null | undefined
): Promise<Course | null> {
  const db = await getDb();
  const course = await db.select().from(courses).where(eq(courses.slug, slug)).get();
  if (!course) return null;
  if (course.status === "published") return course;
  if (course.status !== "archived" || !userId) return null;
  const enrollment = await db
    .select()
    .from(enrollments)
    .where(and(eq(enrollments.userId, userId), eq(enrollments.courseId, course.id)))
    .get();
  if (hasLearnerAccess(enrollment || null)) return course;
  return null;
}

export async function getPublishedCourses(): Promise<Course[]> {
  const db = await getDb();
  return db
    .select()
    .from(courses)
    .where(eq(courses.status, "published"))
    .orderBy(desc(courses.publishedAt), desc(courses.updatedAt));
}

/** Full curriculum ordered by section.position then lesson.position. */
export async function getCourseCurriculum(courseId: string): Promise<CurriculumSection[]> {
  const db = await getDb();
  // PERFORMANCE (review correction): exactly 2 queries — one for sections,
  // one for ALL lessons of the course grouped in memory. The previous
  // per-section loop was an N+1 (1 + #sections lesson queries).
  const [sections, allLessons] = await Promise.all([
    getCourseSections(courseId),
    db
      .select()
      .from(lessons)
      .where(eq(lessons.courseId, courseId))
      .orderBy(asc(lessons.position), asc(lessons.createdAt)),
  ]);
  const bySection = new Map<string, Lesson[]>();
  for (const lesson of allLessons) {
    const bucket = bySection.get(lesson.sectionId);
    if (bucket) bucket.push(lesson);
    else bySection.set(lesson.sectionId, [lesson]);
  }
  return sections.map((section) => {
    const sectionLessons = bySection.get(section.id) ?? [];
    return {
      section,
      lessons: sectionLessons,
      publishedLessons: sectionLessons.filter((l) => l.status === "published"),
    };
  });
}

/** Ordered flat list of PUBLISHED lessons across the course (learner-visible). */
export async function getPublishedCourseLessons(courseId: string): Promise<Lesson[]> {
  const curriculum = await getCourseCurriculum(courseId);
  return curriculum.flatMap((c) => c.publishedLessons);
}

export async function getPublishedLessonBySlug(
  courseId: string,
  lessonSlug: string
): Promise<Lesson | null> {
  const db = await getDb();
  const lesson = await db
    .select()
    .from(lessons)
    .where(and(eq(lessons.courseId, courseId), eq(lessons.slug, lessonSlug)))
    .get();
  if (!lesson || lesson.status !== "published") return null;
  return lesson;
}

export function parseLessonBody(lesson: Lesson): ContentBlock[] {
  try {
    const parsed = JSON.parse(lesson.body) as ContentBlock[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------- Stats (admin)

export async function getCourseEnrollmentCount(courseId: string): Promise<number> {
  const db = await getDb();
  const rows = await db
    .select({ count: sql<number>`count(*)` })
    .from(enrollments)
    .where(eq(enrollments.courseId, courseId));
  return rows[0]?.count ?? 0;
}

export async function getLessonCompletionCount(lessonId: string): Promise<number> {
  const db = await getDb();
  const rows = await db
    .select({ count: sql<number>`count(*)` })
    .from(lessonProgress)
    .where(eq(lessonProgress.lessonId, lessonId));
  return rows[0]?.count ?? 0;
}

export async function getLessonResources(lessonId: string) {
  const db = await getDb();
  return db
    .select()
    .from(lessonResources)
    .where(eq(lessonResources.lessonId, lessonId))
    .orderBy(asc(lessonResources.position));
}

// ---------------------------------------------------------------- Batched stats (review correction G)
// Single GROUP BY query per call site instead of one COUNT per row.

/** Enrollment counts for many courses in ONE query. Missing ids map to 0. */
export async function getCourseEnrollmentCounts(courseIds: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  if (courseIds.length === 0) return out;
  const db = await getDb();
  const rows = await db
    .select({ courseId: enrollments.courseId, count: sql<number>`count(*)` })
    .from(enrollments)
    .where(inArray(enrollments.courseId, courseIds))
    .groupBy(enrollments.courseId);
  for (const id of courseIds) out[id] = 0;
  for (const row of rows) out[row.courseId] = row.count;
  return out;
}

/** Completion counts for many lessons in ONE query. Missing ids map to 0. */
export async function getLessonCompletionCounts(lessonIds: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  if (lessonIds.length === 0) return out;
  const db = await getDb();
  const rows = await db
    .select({ lessonId: lessonProgress.lessonId, count: sql<number>`count(*)` })
    .from(lessonProgress)
    .where(inArray(lessonProgress.lessonId, lessonIds))
    .groupBy(lessonProgress.lessonId);
  for (const id of lessonIds) out[id] = 0;
  for (const row of rows) out[row.lessonId] = row.count;
  return out;
}

/** Published-lesson counts for many courses in ONE query. Missing ids map to 0. */
export async function getPublishedLessonCounts(courseIds: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  if (courseIds.length === 0) return out;
  const db = await getDb();
  const rows = await db
    .select({ courseId: lessons.courseId, count: sql<number>`count(*)` })
    .from(lessons)
    .where(and(inArray(lessons.courseId, courseIds), eq(lessons.status, "published")))
    .groupBy(lessons.courseId);
  for (const id of courseIds) out[id] = 0;
  for (const row of rows) out[row.courseId] = row.count;
  return out;
}
