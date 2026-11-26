import { getDb } from "@/lib/db";
import {
  certificates,
  courses,
  courseSections,
  enrollments,
  lessons,
  lessonNotes,
  lessonProgress,
  lessonQuestions,
  lessonQuizzes,
  lessonResources,
  lessonVideoPositions,
  offers,
  orders,
  quizAttempts,
  slugRedirects,
  type Course,
  type CourseSection,
  type Lesson,
  type LessonResource,
} from "@/lib/db";
import { and, asc, desc, eq, inArray, isNull, like, ne, or, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { getR2Bucket } from "@/lib/cloudflare/bindings";
import {
  collectContentMediaKeys,
  deleteMediaIfUnreferenced,
} from "@/features/trash/media-cleanup";
import {
  assertCourseTransition,
  assertLessonTransition,
  assertNotTrashed,
  buildArchiveUpdate,
  buildEditTouch,
  buildPublishUpdate,
  buildRestoreFromArchiveUpdate,
  buildRestoreFromTrashUpdate,
  buildTrashUpdate,
  buildUnpublishUpdate,
} from "@/features/publishing/lifecycle";
import type { ContentBlock } from "@/features/publishing/types";
import { slugifyTitle } from "@/features/publishing/types";
import { extractYouTubeVideoId } from "./youtube";
import {
  buildReleaseSlugStatement,
  buildSlugChangeStatements,
} from "@/features/slug-redirects/service";
import type {
  CreateCourseInput,
  CreateLessonInput,
  CreateSectionInput,
  UpdateCourseInput,
  UpdateLessonInput,
} from "./types";
import { hasLearnerAccess } from "@/features/enrollments/access";
import { isUniqueConstraintError } from "@/lib/db/sqlite-errors";
import { AppError } from "@/lib/errors";
import { reconcileCourseEnrollments } from "@/features/progress/reconcile";
import { getOfferForCourse } from "@/features/offers/service";

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
  // Trashed rows live only in the Studio Trash page, never in normal lists.
  const conditions = [isNull(courses.trashedAt)];
  if (options?.status && options.status !== "all") {
    conditions.push(eq(courses.status, options.status));
  }
  if (options?.search?.trim()) {
    const q = `%${options.search.trim()}%`;
    const match = or(like(courses.title, q), like(courses.slug, q));
    if (match) conditions.push(match);
  }
  const where = and(...conditions);
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

/**
 * Batch course metadata for learner collection reads (/learn, /learn/courses).
 * ONE query for many ids instead of one getAdminCourseById per enrollment.
 * Missing ids are simply absent from the map. No generic repository — one
 * narrow helper for the dashboard fan-out.
 */
export async function getCoursesByIds(courseIds: string[]): Promise<Map<string, Course>> {
  if (courseIds.length === 0) return new Map();
  const db = await getDb();
  const rows = await db
    .select()
    .from(courses)
    .where(and(inArray(courses.id, courseIds), isNull(courses.trashedAt)));
  return new Map(rows.map((c) => [c.id, c]));
}

// ---------------------------------------------------------------- Admin writes

export async function createCourse(input: CreateCourseInput): Promise<Course> {
  const db = await getDb();
  const slug = input.slug || slugifyTitle(input.title);

  const existing = await db.select().from(courses).where(eq(courses.slug, slug)).get();
  if (existing) {
    throw new AppError("conflict", `A course with the slug "${slug}" already exists. Please choose a unique slug.`);
  }

  const now = new Date();
  const id = newId("course");
  try {
    // A new live course wins over any redirect that used this slug.
    await db.batch([
      buildReleaseSlugStatement(db, { entityType: "course", scope: "", slug }),
      db.insert(courses).values({
      id,
      certificateEnabled: input.certificateEnabled ?? false,
      title: input.title,
      slug,
      description: input.description || null,
      outcomes: input.outcomes == null ? null : JSON.stringify(input.outcomes),
      faq: input.faq == null ? null : JSON.stringify(input.faq),
      audience: input.audience || null,
      instructorName: input.instructorName || null,
      instructorBio: input.instructorBio || null,
      sequential: input.sequential ?? false,
      notifyUnlocks: input.notifyUnlocks ?? false,
      nudgeCompleted: input.nudgeCompleted ?? false,
      nudgeInactive: input.nudgeInactive ?? false,
      nudgeQuizFailed: input.nudgeQuizFailed ?? false,
      coachingPath: input.coachingPath?.trim() ? input.coachingPath.trim() : null,
      status: "draft",
      accessMode: input.accessMode ?? "FREE",
      coverImage: input.coverImage || null,
      createdAt: now,
      updatedAt: now,
      publishedAt: null,
      }),
    ]);
  } catch (error: unknown) {
    // The courses.slug UNIQUE index is the authoritative concurrency
    // backstop: the pre-check above cannot see a parallel insert. Only that
    // condition is converted to the same domain error the pre-check raises;
    // anything else propagates untouched.
    if (!isUniqueConstraintError(error)) throw error;
    // Verify the EXPECTED business-key conflict actually exists before
    // converting to a friendly duplicate error. If no conflicting course
    // slug exists, the unique failure was some other constraint — rethrow
    // the original DB error.
    const conflict = await db.select().from(courses).where(eq(courses.slug, slug)).get();
    if (!conflict) throw error;
    throw new AppError("conflict", `A course with the slug "${slug}" already exists. Please choose a unique slug.`);
  }

  const created = await getAdminCourseById(id);
  if (!created) throw new Error("Failed to retrieve created course");
  return created;
}

export async function updateCourse(id: string, input: UpdateCourseInput): Promise<Course> {
  const db = await getDb();
  const current = await getAdminCourseById(id);
  if (!current) throw new AppError("not_found", `Course with id "${id}" not found`);

  if (input.slug && input.slug !== current.slug) {
    const clash = await db
      .select()
      .from(courses)
      .where(and(eq(courses.slug, input.slug), ne(courses.id, id)))
      .get();
    if (clash) throw new AppError("conflict", `A course with the slug "${input.slug}" already exists.`);
  }

  if (typeof input.accessMode !== "undefined" && input.accessMode !== current.accessMode) {
    const linkedOffer = await getOfferForCourse(id);
    if (linkedOffer) {
      throw new AppError(
        "conflict",
        `Course access is owned by linked Offer "${linkedOffer.slug}". Update the Offer instead of the legacy course fallback.`,
      );
    }
  }

  const now = new Date();
  const patch: Partial<typeof courses.$inferInsert> = { ...buildEditTouch(now) };
  if (typeof input.certificateEnabled !== "undefined") patch.certificateEnabled = input.certificateEnabled;
  if (typeof input.title !== "undefined") patch.title = input.title;
  if (typeof input.slug !== "undefined") patch.slug = input.slug;
  if (typeof input.outcomes !== "undefined") patch.outcomes = input.outcomes === null ? null : JSON.stringify(input.outcomes);
  if (typeof input.faq !== "undefined") patch.faq = input.faq === null ? null : JSON.stringify(input.faq);
  if (typeof input.audience !== "undefined") patch.audience = input.audience || null;
  if (typeof input.instructorName !== "undefined") patch.instructorName = input.instructorName || null;
  if (typeof input.instructorBio !== "undefined") patch.instructorBio = input.instructorBio || null;
  if (typeof input.description !== "undefined") patch.description = input.description || null;
  if (typeof input.accessMode !== "undefined") patch.accessMode = input.accessMode;
  if (typeof input.coverImage !== "undefined") patch.coverImage = input.coverImage || null;
  // Learner polish sequential lock (Studio course settings; OFF by default).
  // Toggling it never rewrites progress: locked required lessons still count
  // in totalRequired, so completion reconciles on the next write path.
  if (typeof input.sequential !== "undefined") patch.sequential = input.sequential;
  // Batch J learner automations (Studio course settings; all OFF by default).
  if (typeof input.notifyUnlocks !== "undefined") patch.notifyUnlocks = input.notifyUnlocks;
  if (typeof input.nudgeCompleted !== "undefined") patch.nudgeCompleted = input.nudgeCompleted;
  if (typeof input.nudgeInactive !== "undefined") patch.nudgeInactive = input.nudgeInactive;
  if (typeof input.nudgeQuizFailed !== "undefined") patch.nudgeQuizFailed = input.nudgeQuizFailed;
  if (typeof input.coachingPath !== "undefined") {
    patch.coachingPath = input.coachingPath?.trim() ? input.coachingPath.trim() : null;
  }

  try {
    // Same batch (one D1 transaction): the UPDATE plus the old-slug redirect.
    await db.batch([
      db.update(courses).set(patch).where(eq(courses.id, id)),
      ...buildSlugChangeStatements(db, {
        entityType: "course",
        entityId: id,
        oldSlug: current.slug,
        newSlug: patch.slug ?? current.slug,
        everPublished: current.publishedAt !== null,
        now,
      }),
    ]);
  } catch (error: unknown) {
    // Lost race on the courses.slug UNIQUE index: a parallel admin renamed
    // another course onto this slug between the pre-check and the UPDATE.
    // Convert ONLY when the expected conflicting slug actually exists on a
    // DIFFERENT course; otherwise rethrow the original DB error.
    if (!isUniqueConstraintError(error)) throw error;
    const conflict = await db
      .select()
      .from(courses)
      .where(and(eq(courses.slug, patch.slug ?? input.slug ?? current.slug), ne(courses.id, id)))
      .get();
    if (!conflict) throw error;
    throw new AppError("conflict", `A course with the slug "${patch.slug ?? input.slug ?? current.slug}" already exists.`);
  }
  const updated = await getAdminCourseById(id);
  if (!updated) throw new Error("Failed to retrieve updated course");
  return updated;
}

export async function publishCourse(id: string): Promise<Course> {
  const db = await getDb();
  const current = await getAdminCourseById(id);
  if (!current) throw new AppError("not_found", `Course with id "${id}" not found`);
  assertNotTrashed(current, "course");
  assertCourseTransition(current.status, "publish");
  await db.update(courses).set(buildPublishUpdate(current)).where(eq(courses.id, id));
  return (await getAdminCourseById(id))!;
}

export async function unpublishCourse(id: string): Promise<Course> {
  const db = await getDb();
  const current = await getAdminCourseById(id);
  if (!current) throw new AppError("not_found", `Course with id "${id}" not found`);
  assertNotTrashed(current, "course");
  assertCourseTransition(current.status, "unpublish");
  await db.update(courses).set(buildUnpublishUpdate()).where(eq(courses.id, id));
  return (await getAdminCourseById(id))!;
}

export async function archiveCourse(id: string): Promise<Course> {
  const db = await getDb();
  const current = await getAdminCourseById(id);
  if (!current) throw new AppError("not_found", `Course with id "${id}" not found`);
  assertNotTrashed(current, "course");
  assertCourseTransition(current.status, "archive");
  await db.update(courses).set(buildArchiveUpdate()).where(eq(courses.id, id));
  return (await getAdminCourseById(id))!;
}

/**
 * Restore from archive (§1 lifecycle): archived -> draft. Never straight
 * to published.
 */
export async function restoreCourseFromArchive(id: string): Promise<Course> {
  const db = await getDb();
  const current = await getAdminCourseById(id);
  if (!current) throw new AppError("not_found", `Course with id "${id}" not found`);
  assertNotTrashed(current, "course");
  assertCourseTransition(current.status, "restore");
  await db.update(courses).set(buildRestoreFromArchiveUpdate()).where(eq(courses.id, id));
  return (await getAdminCourseById(id))!;
}

/**
 * Move to Trash (§1 lifecycle). Allowed only from draft or archived; a
 * published course must be unpublished/archived first.
 */
export async function trashCourse(id: string): Promise<Course> {
  const db = await getDb();
  const current = await getAdminCourseById(id);
  if (!current) throw new AppError("not_found", `Course with id "${id}" not found`);
  const now = new Date();
  await db.update(courses).set(buildTrashUpdate(current, now)).where(eq(courses.id, id));
  return (await getAdminCourseById(id))!;
}

/** Restore from Trash: clears the flag, status returns to trashedFromStatus. */
export async function restoreCourseFromTrash(id: string): Promise<Course> {
  const db = await getDb();
  const current = await getAdminCourseById(id);
  if (!current) throw new AppError("not_found", `Course with id "${id}" not found`);
  const now = new Date();
  await db.update(courses).set(buildRestoreFromTrashUpdate(current, now)).where(eq(courses.id, id));
  return (await getAdminCourseById(id))!;
}

/**
 * Protection gate (§1 dependency rules): a course with ANY enrollment (any
 * status), certificate or order can never be permanently deleted — manually
 * or by purge. Studio explains why and offers Archive instead.
 */
export async function assertCourseDeletable(id: string): Promise<void> {
  const db = await getDb();
  const [enrollment, certificate, order] = await Promise.all([
    db.select({ id: enrollments.id }).from(enrollments).where(eq(enrollments.courseId, id)).limit(1),
    db.select({ id: certificates.id }).from(certificates).where(eq(certificates.courseId, id)).limit(1),
    db.select({ id: orders.id }).from(orders).where(eq(orders.courseId, id)).limit(1),
  ]);
  if (enrollment.length > 0 || certificate.length > 0 || order.length > 0) {
    throw new AppError(
      "conflict",
      "This course cannot be deleted permanently because learners are attached to it (enrollments, certificates or orders). Archive it instead — its data, history and relationships are kept."
    );
  }
}

/**
 * Permanently delete a trashed course with NO learners (§1 lifecycle).
 * Irreversible: removes sections, lessons, resources (R2 objects too),
 * quizzes (+ attempts), the linked offer, slug redirects and unreferenced
 * cover media. Chunked for D1's bound-parameter budget (<=100 per statement).
 * Returns a snapshot for audit + cache revalidation.
 */
export async function deleteCoursePermanently(
  id: string,
  confirmTitle: string
): Promise<{ title: string; slug: string; oldSlugs: string[] }> {
  const db = await getDb();
  const current = await getAdminCourseById(id);
  if (!current) throw new AppError("not_found", `Course with id "${id}" not found`);
  if (current.trashedAt === null) {
    throw new AppError("invalid", "Only items in Trash can be deleted permanently. Move this course to Trash first.");
  }
  if (confirmTitle.trim() !== current.title) {
    throw new AppError("invalid", "The typed title does not match. Type the exact title to confirm permanent deletion.");
  }
  // Re-check protection at delete time — the purge path relies on this.
  await assertCourseDeletable(id);

  // Collect child ids + R2 keys BEFORE deleting (one indexed query each).
  const [lessonRows, resourceRows, quizRows, redirectRows] = await Promise.all([
    db.select({ id: lessons.id }).from(lessons).where(eq(lessons.courseId, id)),
    db.select({ storageKey: lessonResources.storageKey }).from(lessonResources).where(eq(lessonResources.courseId, id)),
    db.select({ id: lessonQuizzes.id }).from(lessonQuizzes).where(eq(lessonQuizzes.courseId, id)),
    db
      .select({ oldSlug: slugRedirects.oldSlug })
      .from(slugRedirects)
      .where(and(eq(slugRedirects.entityType, "course"), eq(slugRedirects.entityId, id))),
  ]);
  const lessonIds = lessonRows.map((l) => l.id);
  const quizIds = quizRows.map((q) => q.id);
  const resourceKeys = resourceRows.map((r) => r.storageKey);

  // D1 batch (one implicit transaction): children first, course row last.
  // inArray chunks of 90 stay within the 100-parameter statement budget.
  const statements: [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]] = [
    db.delete(lessonQuizzes).where(eq(lessonQuizzes.courseId, id)),
  ];
  for (let i = 0; i < quizIds.length; i += 90) {
    statements.push(
      db.delete(quizAttempts).where(inArray(quizAttempts.quizId, quizIds.slice(i, i + 90)))
    );
  }
  statements.push(db.delete(lessonResources).where(eq(lessonResources.courseId, id)));
  statements.push(db.delete(lessonNotes).where(eq(lessonNotes.courseId, id)));
  statements.push(db.delete(lessonQuestions).where(eq(lessonQuestions.courseId, id)));
  for (let i = 0; i < lessonIds.length; i += 90) {
    const chunk = lessonIds.slice(i, i + 90);
    statements.push(db.delete(lessonProgress).where(inArray(lessonProgress.lessonId, chunk)));
    statements.push(db.delete(lessonVideoPositions).where(inArray(lessonVideoPositions.lessonId, chunk)));
  }
  statements.push(db.delete(lessons).where(eq(lessons.courseId, id)));
  statements.push(db.delete(courseSections).where(eq(courseSections.courseId, id)));
  statements.push(db.delete(offers).where(eq(offers.courseId, id)));
  statements.push(
    db
      .delete(slugRedirects)
      .where(and(eq(slugRedirects.entityType, "course"), eq(slugRedirects.entityId, id)))
  );
  statements.push(
    db
      .delete(slugRedirects)
      .where(and(eq(slugRedirects.entityType, "lesson"), eq(slugRedirects.scope, id)))
  );
  statements.push(db.delete(courses).where(eq(courses.id, id)));
  await db.batch(statements);

  // R2 second, best-effort: resource PDFs belong to this course alone.
  const bucket = await getR2Bucket();
  for (const key of resourceKeys) {
    if (!key.startsWith("course-resources/") || key.includes("..")) continue;
    await bucket.delete(key).catch(() => undefined);
  }
  await deleteMediaIfUnreferenced(collectContentMediaKeys(current.coverImage, null), {
    table: "courses",
    id,
    coverImage: current.coverImage,
  });

  return { title: current.title, slug: current.slug, oldSlugs: redirectRows.map((r) => r.oldSlug) };
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
  if (!course) throw new AppError("not_found", `Course with id "${input.courseId}" not found`);

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
  if (!current) throw new AppError("not_found", `Section with id "${id}" not found`);
  await db
    .update(courseSections)
    .set({ title, updatedAt: new Date() })
    .where(eq(courseSections.id, id));
  return (await db.select().from(courseSections).where(eq(courseSections.id, id)).get())!;
}

/**
 * Batch J: update a section's drip-release rule. Validated by
 * sectionReleaseSchema (drip 1–365, date required for 'date'). 'immediate'
 * clears the stored rule columns.
 */
export async function updateSectionRelease(input: {
  id: string;
  releaseMode: "immediate" | "date" | "drip";
  releaseAt?: string | null;
  dripDays?: number | null;
}): Promise<CourseSection> {
  const db = await getDb();
  const current = await db.select().from(courseSections).where(eq(courseSections.id, input.id)).get();
  if (!current) throw new AppError("not_found", `Section with id "${input.id}" not found`);
  const now = new Date();
  await db
    .update(courseSections)
    .set({
      releaseMode: input.releaseMode,
      releaseAt: input.releaseMode === "date" && input.releaseAt ? new Date(input.releaseAt) : null,
      dripDays: input.releaseMode === "drip" ? (input.dripDays ?? null) : null,
      updatedAt: now,
    })
    .where(eq(courseSections.id, input.id));
  return (await db.select().from(courseSections).where(eq(courseSections.id, input.id)).get())!;
}

export async function moveSection(id: string, direction: "up" | "down"): Promise<CourseSection[]> {
  const db = await getDb();
  const current = await db.select().from(courseSections).where(eq(courseSections.id, id)).get();
  if (!current) throw new AppError("not_found", `Section with id "${id}" not found`);
  const siblings = await getCourseSections(current.courseId);
  const idx = siblings.findIndex((s) => s.id === id);
  const swapIdx = direction === "up" ? idx - 1 : idx + 1;
  if (idx < 0 || swapIdx < 0 || swapIdx >= siblings.length) return siblings;
  const other = siblings[swapIdx];
  const now = new Date();
  // ATOMICITY: D1 batch() executes both writes as one implicit transaction —
  // a partial failure can never leave duplicate positions on disk.
  await db.batch([
    db.update(courseSections).set({ position: other.position, updatedAt: now }).where(eq(courseSections.id, current.id)),
    db.update(courseSections).set({ position: current.position, updatedAt: now }).where(eq(courseSections.id, other.id)),
  ]);
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
    throw new AppError("invalid", "Video URL must be a valid YouTube watch, youtu.be, embed, shorts, or live URL — or a bare video ID.");
  }
  return raw.trim();
}

export async function createLesson(input: CreateLessonInput): Promise<Lesson> {
  const db = await getDb();
  const course = await getAdminCourseById(input.courseId);
  if (!course) throw new AppError("not_found", `Course with id "${input.courseId}" not found`);
  if (course.trashedAt !== null) {
    throw new AppError("invalid", "This course is in Trash. Restore it before adding lessons.");
  }
  const section = await db.select().from(courseSections).where(eq(courseSections.id, input.sectionId)).get();
  if (!section || section.courseId !== input.courseId) {
    throw new AppError("invalid", "Section does not belong to this course.");
  }

  const slug = input.slug || slugifyTitle(input.title);
  const clash = await db
    .select()
    .from(lessons)
    .where(and(eq(lessons.courseId, input.courseId), eq(lessons.slug, slug)))
    .get();
  if (clash) {
    throw new AppError("conflict", `A lesson with the slug "${slug}" already exists in this course.`);
  }

  const videoUrl = normalizeVideoUrl(input.videoUrl);
  const siblings = await getSectionLessons(input.sectionId);
  const position = siblings.length > 0 ? Math.max(...siblings.map((l) => l.position)) + 1 : 0;
  const now = new Date();
  const id = newId("lesson");
  try {
    // A new live lesson wins over any redirect that used this slug.
    await db.batch([
      buildReleaseSlugStatement(db, { entityType: "lesson", scope: input.courseId, slug }),
      db.insert(lessons).values({
      id,
      courseId: input.courseId,
      sectionId: input.sectionId,
      title: input.title,
      slug,
      body: JSON.stringify(input.body ?? []),
      videoUrl,
      required: input.required ?? true,
      isPreview: input.isPreview ?? false,
      durationMinutes: input.durationMinutes ?? null,
      position,
      status: "draft",
      createdAt: now,
      updatedAt: now,
      publishedAt: null,
      }),
    ]);
  } catch (error: unknown) {
    // The lessons (course_id, slug) UNIQUE index is the authoritative
    // concurrency backstop: only that condition is converted to the same
    // domain error the pre-check raises; anything else propagates untouched.
    if (!isUniqueConstraintError(error)) throw error;
    // Verify the EXPECTED business-key conflict actually exists (a lesson
    // with this courseId + slug) before converting; otherwise rethrow.
    const conflict = await db
      .select()
      .from(lessons)
      .where(and(eq(lessons.courseId, input.courseId), eq(lessons.slug, slug)))
      .get();
    if (!conflict) throw error;
    throw new AppError("conflict", `A lesson with the slug "${slug}" already exists in this course.`);
  }
  const created = await getAdminLessonById(id);
  if (!created) throw new Error("Failed to retrieve created lesson");
  return created;
}

export async function updateLesson(id: string, input: UpdateLessonInput): Promise<Lesson> {
  const db = await getDb();
  const current = await getAdminLessonById(id);
  if (!current) throw new AppError("not_found", `Lesson with id "${id}" not found`);
  assertNotTrashed(current, "lesson");

  if (input.slug && input.slug !== current.slug) {
    const clash = await db
      .select()
      .from(lessons)
      .where(and(eq(lessons.courseId, current.courseId), eq(lessons.slug, input.slug), ne(lessons.id, id)))
      .get();
    if (clash) throw new AppError("conflict", `A lesson with the slug "${input.slug}" already exists in this course.`);
  }

  const now = new Date();
  const patch: Partial<typeof lessons.$inferInsert> = { ...buildEditTouch(now) };
  if (typeof input.title !== "undefined") patch.title = input.title;
  if (typeof input.slug !== "undefined") patch.slug = input.slug;
  if (typeof input.body !== "undefined") patch.body = JSON.stringify(input.body);
  if (typeof input.videoUrl !== "undefined") patch.videoUrl = normalizeVideoUrl(input.videoUrl);
  if (typeof input.required !== "undefined") patch.required = input.required;
  if (typeof input.isPreview !== "undefined") patch.isPreview = input.isPreview;
  if (typeof input.durationMinutes !== "undefined") patch.durationMinutes = input.durationMinutes;

  try {
    // Same batch (one D1 transaction): the UPDATE plus the old-slug redirect.
    await db.batch([
      db.update(lessons).set(patch).where(eq(lessons.id, id)),
      ...buildSlugChangeStatements(db, {
        entityType: "lesson",
        scope: current.courseId,
        entityId: id,
        oldSlug: current.slug,
        newSlug: patch.slug ?? current.slug,
        everPublished: current.publishedAt !== null,
        now,
      }),
    ]);
  } catch (error: unknown) {
    // Lost race on the lessons (course_id, slug) UNIQUE index: a parallel
    // admin created/renamed a lesson onto this slug between the pre-check
    // and the UPDATE. Convert ONLY when a lesson with the same courseId +
    // slug actually exists on a DIFFERENT lesson; otherwise rethrow the
    // original DB error.
    if (!isUniqueConstraintError(error)) throw error;
    const conflict = await db
      .select()
      .from(lessons)
      .where(and(eq(lessons.courseId, current.courseId), eq(lessons.slug, patch.slug ?? input.slug ?? current.slug), ne(lessons.id, id)))
      .get();
    if (!conflict) throw error;
    throw new AppError("conflict", `A lesson with the slug "${patch.slug ?? input.slug ?? current.slug}" already exists in this course.`);
  }
  // COMPLETION: toggling `required` changes the required-published set, which
  // can close or reopen enrollments. Other edits (title/body/slug/video) cannot.
  // Reconciled at write time — learner page reads never write.
  if (typeof input.required !== "undefined" && input.required !== current.required) {
    await reconcileCourseEnrollments(current.courseId);
  }
  return (await getAdminLessonById(id))!;
}

/**
 * Batch J: update a lesson's drip-release rule. Validated by
 * lessonReleaseSchema (drip 1–365, date required for 'date'). 'immediate'
 * clears the stored rule columns. Release changes never alter completion
 * (locked required lessons still count in totalRequired), so no reconcile.
 */
export async function updateLessonRelease(input: {
  id: string;
  releaseMode: "immediate" | "date" | "drip";
  releaseAt?: string | null;
  dripDays?: number | null;
}): Promise<Lesson> {
  const db = await getDb();
  const current = await getAdminLessonById(input.id);
  if (!current) throw new AppError("not_found", `Lesson with id "${input.id}" not found`);
  await db
    .update(lessons)
    .set({
      releaseMode: input.releaseMode,
      releaseAt: input.releaseMode === "date" && input.releaseAt ? new Date(input.releaseAt) : null,
      dripDays: input.releaseMode === "drip" ? (input.dripDays ?? null) : null,
      updatedAt: new Date(),
    })
    .where(eq(lessons.id, input.id));
  return (await getAdminLessonById(input.id))!;
}

export async function publishLesson(id: string): Promise<Lesson> {
  const db = await getDb();
  const current = await getAdminLessonById(id);
  if (!current) throw new AppError("not_found", `Lesson with id "${id}" not found`);
  assertNotTrashed(current, "lesson");
  assertLessonTransition(current.status, "publish");
  await db.update(lessons).set(buildPublishUpdate(current)).where(eq(lessons.id, id));
  // COMPLETION: a newly published required lesson can reopen completed
  // enrollments. The reconcile is idempotent, so optional lessons need no
  // special-casing.
  await reconcileCourseEnrollments(current.courseId);
  return (await getAdminLessonById(id))!;
}

export async function unpublishLesson(id: string): Promise<Lesson> {
  const db = await getDb();
  const current = await getAdminLessonById(id);
  if (!current) throw new AppError("not_found", `Lesson with id "${id}" not found`);
  assertNotTrashed(current, "lesson");
  assertLessonTransition(current.status, "unpublish");
  await db.update(lessons).set(buildUnpublishUpdate()).where(eq(lessons.id, id));
  // COMPLETION: removing the last incomplete required lesson can close
  // enrollments; removing the only required lesson reopens them.
  await reconcileCourseEnrollments(current.courseId);
  return (await getAdminLessonById(id))!;
}

/**
 * Archive a lesson (§1 lifecycle). Archived lessons hide from learner
 * navigation; progress, attempts, notes and questions are kept.
 */
export async function archiveLesson(id: string): Promise<Lesson> {
  const db = await getDb();
  const current = await getAdminLessonById(id);
  if (!current) throw new AppError("not_found", `Lesson with id "${id}" not found`);
  assertNotTrashed(current, "lesson");
  assertLessonTransition(current.status, "archive");
  await db.update(lessons).set(buildArchiveUpdate()).where(eq(lessons.id, id));
  await reconcileCourseEnrollments(current.courseId);
  return (await getAdminLessonById(id))!;
}

/**
 * Restore from archive (§1 lifecycle): archived -> draft. Never straight
 * to published.
 */
export async function restoreLessonFromArchive(id: string): Promise<Lesson> {
  const db = await getDb();
  const current = await getAdminLessonById(id);
  if (!current) throw new AppError("not_found", `Lesson with id "${id}" not found`);
  assertNotTrashed(current, "lesson");
  assertLessonTransition(current.status, "restore");
  await db.update(lessons).set(buildRestoreFromArchiveUpdate()).where(eq(lessons.id, id));
  return (await getAdminLessonById(id))!;
}

/**
 * Move to Trash (§1 lifecycle). Allowed only from draft or archived; a
 * published lesson must be unpublished/archived first.
 */
export async function trashLesson(id: string): Promise<Lesson> {
  const db = await getDb();
  const current = await getAdminLessonById(id);
  if (!current) throw new AppError("not_found", `Lesson with id "${id}" not found`);
  const now = new Date();
  await db.update(lessons).set(buildTrashUpdate(current, now)).where(eq(lessons.id, id));
  await reconcileCourseEnrollments(current.courseId);
  return (await getAdminLessonById(id))!;
}

/** Restore from Trash: clears the flag, status returns to trashedFromStatus. */
export async function restoreLessonFromTrash(id: string): Promise<Lesson> {
  const db = await getDb();
  const current = await getAdminLessonById(id);
  if (!current) throw new AppError("not_found", `Lesson with id "${id}" not found`);
  const now = new Date();
  await db.update(lessons).set(buildRestoreFromTrashUpdate(current, now)).where(eq(lessons.id, id));
  await reconcileCourseEnrollments(current.courseId);
  return (await getAdminLessonById(id))!;
}

/**
 * Protection gate (§1 dependency rules): a lesson with ANY learner progress,
 * quiz attempt, note or question can never be permanently deleted — manually
 * or by purge. Studio explains why and offers Archive instead.
 */
export async function assertLessonDeletable(id: string): Promise<void> {
  const db = await getDb();
  const lesson = await getAdminLessonById(id);
  if (!lesson) throw new AppError("not_found", `Lesson with id "${id}" not found`);
  const [progress, note, question] = await Promise.all([
    db.select({ id: lessonProgress.id }).from(lessonProgress).where(eq(lessonProgress.lessonId, id)).limit(1),
    db.select({ id: lessonNotes.id }).from(lessonNotes).where(eq(lessonNotes.lessonId, id)).limit(1),
    db.select({ id: lessonQuestions.id }).from(lessonQuestions).where(eq(lessonQuestions.lessonId, id)).limit(1),
  ]);
  const quiz = await db
    .select({ id: lessonQuizzes.id })
    .from(lessonQuizzes)
    .where(eq(lessonQuizzes.lessonId, id))
    .get();
  const attempt = quiz
    ? await db
        .select({ id: quizAttempts.id })
        .from(quizAttempts)
        .where(eq(quizAttempts.quizId, quiz.id))
        .limit(1)
    : [];
  // Attempts also carry a denormalized lessonId (no FK) — check it directly.
  const attemptByLesson = await db
    .select({ id: quizAttempts.id })
    .from(quizAttempts)
    .where(eq(quizAttempts.lessonId, id))
    .limit(1);
  if (progress.length > 0 || note.length > 0 || question.length > 0 || attempt.length > 0 || attemptByLesson.length > 0) {
    throw new AppError(
      "conflict",
      "This lesson cannot be deleted permanently because learners have interacted with it (progress, quiz attempts, notes or questions). Archive it instead — its data and history are kept."
    );
  }
}

/**
 * Permanently delete a trashed lesson with NO learner data (§1 lifecycle).
 * Irreversible: removes resources (R2 objects too), its quiz (+ attempts)
 * and slug redirects. Chunked for D1's bound-parameter budget.
 * Returns a snapshot for audit + cache revalidation.
 */
export async function deleteLessonPermanently(
  id: string,
  confirmTitle: string
): Promise<{ title: string; slug: string; courseId: string; courseSlug: string; oldSlugs: string[] }> {
  const db = await getDb();
  const current = await getAdminLessonById(id);
  if (!current) throw new AppError("not_found", `Lesson with id "${id}" not found`);
  if (current.trashedAt === null) {
    throw new AppError("invalid", "Only items in Trash can be deleted permanently. Move this lesson to Trash first.");
  }
  if (confirmTitle.trim() !== current.title) {
    throw new AppError("invalid", "The typed title does not match. Type the exact title to confirm permanent deletion.");
  }
  // Re-check protection at delete time — the purge path relies on this.
  await assertLessonDeletable(id);

  const [resourceRows, quizRows, redirectRows] = await Promise.all([
    db.select({ storageKey: lessonResources.storageKey }).from(lessonResources).where(eq(lessonResources.lessonId, id)),
    db.select({ id: lessonQuizzes.id }).from(lessonQuizzes).where(eq(lessonQuizzes.lessonId, id)),
    db
      .select({ oldSlug: slugRedirects.oldSlug })
      .from(slugRedirects)
      .where(
        and(
          eq(slugRedirects.entityType, "lesson"),
          eq(slugRedirects.scope, current.courseId),
          eq(slugRedirects.entityId, id)
        )
      ),
  ]);
  const resourceKeys = resourceRows.map((r) => r.storageKey);
  const quizIds = quizRows.map((q) => q.id);

  const statements: [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]] = [
    db.delete(lessonResources).where(eq(lessonResources.lessonId, id)),
  ];
  for (let i = 0; i < quizIds.length; i += 90) {
    statements.push(
      db.delete(quizAttempts).where(inArray(quizAttempts.quizId, quizIds.slice(i, i + 90)))
    );
  }
  statements.push(db.delete(lessonQuizzes).where(eq(lessonQuizzes.lessonId, id)));
  statements.push(
    db
      .delete(slugRedirects)
      .where(
        and(
          eq(slugRedirects.entityType, "lesson"),
          eq(slugRedirects.scope, current.courseId),
          eq(slugRedirects.entityId, id)
        )
      )
  );
  statements.push(db.delete(lessons).where(eq(lessons.id, id)));
  await db.batch(statements);

  const bucket = await getR2Bucket();
  for (const key of resourceKeys) {
    if (!key.startsWith("course-resources/") || key.includes("..")) continue;
    await bucket.delete(key).catch(() => undefined);
  }

  const course = await getAdminCourseById(current.courseId);
  return {
    title: current.title,
    slug: current.slug,
    courseId: current.courseId,
    courseSlug: course?.slug ?? "",
    oldSlugs: redirectRows.map((r) => r.oldSlug),
  };
}

export async function moveLesson(id: string, direction: "up" | "down"): Promise<Lesson[]> {
  const db = await getDb();
  const current = await getAdminLessonById(id);
  if (!current) throw new AppError("not_found", `Lesson with id "${id}" not found`);
  const siblings = await getSectionLessons(current.sectionId);
  const idx = siblings.findIndex((l) => l.id === id);
  const swapIdx = direction === "up" ? idx - 1 : idx + 1;
  if (idx < 0 || swapIdx < 0 || swapIdx >= siblings.length) return siblings;
  const other = siblings[swapIdx];
  const now = new Date();
  // ATOMICITY: D1 batch() executes both writes as one implicit transaction —
  // a partial failure can never leave duplicate positions on disk.
  await db.batch([
    db.update(lessons).set({ position: other.position, updatedAt: now }).where(eq(lessons.id, current.id)),
    db.update(lessons).set({ position: current.position, updatedAt: now }).where(eq(lessons.id, other.id)),
  ]);
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
  if (!course || course.status !== "published" || course.trashedAt !== null) return null;
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
  if (!course || course.trashedAt !== null) return null;
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
    .where(and(eq(courses.status, "published"), isNull(courses.trashedAt)))
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
      // Trashed lessons are hidden from every normal list, including the
      // Studio curriculum view — they live only in the Trash page.
      .where(and(eq(lessons.courseId, courseId), isNull(lessons.trashedAt)))
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
  if (!lesson || lesson.status !== "published" || lesson.trashedAt !== null) return null;
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

/** All resources for many lessons in ONE query, grouped by lesson id. */
export async function getLessonResourcesForLessons(
  lessonIds: string[]
): Promise<Map<string, LessonResource[]>> {
  const out = new Map<string, LessonResource[]>();
  if (lessonIds.length === 0) return out;
  const db = await getDb();
  // D1 caps bound parameters per statement (100); chunk large curricula.
  const rows: LessonResource[] = [];
  for (let i = 0; i < lessonIds.length; i += 90) {
    rows.push(
      ...(await db
        .select()
        .from(lessonResources)
        .where(inArray(lessonResources.lessonId, lessonIds.slice(i, i + 90)))
        .orderBy(asc(lessonResources.position)))
    );
  }
  for (const row of rows) {
    const bucket = out.get(row.lessonId);
    if (bucket) bucket.push(row);
    else out.set(row.lessonId, [row]);
  }
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
    .where(and(inArray(lessons.courseId, courseIds), eq(lessons.status, "published"), isNull(lessons.trashedAt)))
    .groupBy(lessons.courseId);
  for (const id of courseIds) out[id] = 0;
  for (const row of rows) out[row.courseId] = row.count;
  return out;
}
