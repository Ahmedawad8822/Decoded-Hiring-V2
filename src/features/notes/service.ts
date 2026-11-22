import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  courses,
  courseSections,
  enrollments,
  getDb,
  lessonNotes,
  lessons,
  type Course,
  type Enrollment,
  type Lesson,
  type LessonNote,
} from "@/lib/db";
import { getLearnerCourseBySlug, getPublishedLessonBySlug } from "@/features/courses/service";
import { getLessonReadAccess } from "@/features/courses/lesson-access";
import { getEnrollment } from "@/features/enrollments/service";
import { hasLearnerAccess } from "@/features/enrollments/access";
import { AppError } from "@/lib/errors";
import {
  NOTE_THROTTLE_MS,
  saveLessonNoteSchema,
  type CourseNoteEntry,
  type DeleteLessonNoteInput,
  type SaveLessonNoteInput,
  type SaveLessonNoteResult,
} from "./types";

// ============================================================================
// PRIVATE LESSON NOTES SERVICE
// ----------------------------------------------------------------------------
// SECURITY BOUNDARY: every query is scoped by the caller's user id. The client
// never supplies a note id, and no admin/Studio/export/audit surface reads note
// content. Reads also require a current ACTIVE/COMPLETED enrollment: a
// cancelled enrollment keeps the rows in D1 but cannot read them back until
// the learner is enrolled again.
// ============================================================================

function newNoteId(): string {
  return `note_${crypto.randomUUID().slice(0, 12)}`;
}

interface AuthorizedLesson {
  course: Course;
  lesson: Lesson;
  enrollment: Enrollment;
}

/**
 * Write authorization: signed-in (caller guarantees), active/completed
 * enrollment, published lesson that the shared read gate calls "enrolled",
 * and a lesson that belongs to the course named in the URL.
 */
async function requireEnrolledLesson(
  userId: string,
  courseSlug: string,
  lessonSlug: string,
  action: "save" | "delete",
): Promise<AuthorizedLesson> {
  const course = await getLearnerCourseBySlug(courseSlug, userId);
  if (!course) throw new AppError("not_found", "Course not found.");

  const lesson = await getPublishedLessonBySlug(course.id, lessonSlug);
  if (!lesson) throw new AppError("not_found", "Lesson not found.");
  if (lesson.courseId !== course.id) throw new AppError("not_found", "Lesson not found.");

  const enrollment = await getEnrollment(userId, course.id);
  const activeEnrollment = hasLearnerAccess(enrollment) ? enrollment : null;
  const access = getLessonReadAccess({
    signedIn: true,
    enrolled: Boolean(activeEnrollment),
    course,
    lesson,
  });
  if (access !== "enrolled" || !activeEnrollment) {
    throw new AppError(
      "forbidden",
      `Enroll in this course to ${action} notes for this lesson.`,
    );
  }

  return { course, lesson, enrollment: activeEnrollment };
}

/**
 * Owner-scoped read. Joins the learner's CURRENT enrollment so cancelled
 * enrollments keep their rows but read as "no note" (the UI stays hidden until
 * they re-enroll). Also requires a published lesson on a live/archived course.
 */
export async function getMyLessonNote(
  userId: string,
  lessonId: string,
): Promise<LessonNote | null> {
  const db = await getDb();
  const row = await db
    .select({
      id: lessonNotes.id,
      userId: lessonNotes.userId,
      courseId: lessonNotes.courseId,
      lessonId: lessonNotes.lessonId,
      body: lessonNotes.body,
      createdAt: lessonNotes.createdAt,
      updatedAt: lessonNotes.updatedAt,
    })
    .from(lessonNotes)
    .innerJoin(lessons, eq(lessons.id, lessonNotes.lessonId))
    .innerJoin(courses, eq(courses.id, lessonNotes.courseId))
    .innerJoin(
      enrollments,
      and(
        eq(enrollments.userId, userId),
        eq(enrollments.courseId, lessonNotes.courseId),
      ),
    )
    .where(
      and(
        eq(lessonNotes.userId, userId),
        eq(lessonNotes.lessonId, lessonId),
        eq(lessons.courseId, lessonNotes.courseId),
        eq(lessons.status, "published"),
        inArray(courses.status, ["published", "archived"]),
        inArray(enrollments.status, ["active", "completed"]),
      ),
    )
    .get();
  return row ?? null;
}

/** Every note the learner can currently see in one course, curriculum order. */
export async function listMyCourseNotes(
  userId: string,
  courseId: string,
): Promise<CourseNoteEntry[]> {
  const db = await getDb();
  return db
    .select({
      id: lessonNotes.id,
      lessonId: lessonNotes.lessonId,
      lessonTitle: lessons.title,
      lessonSlug: lessons.slug,
      body: lessonNotes.body,
      updatedAt: lessonNotes.updatedAt,
    })
    .from(lessonNotes)
    .innerJoin(lessons, eq(lessons.id, lessonNotes.lessonId))
    .innerJoin(courseSections, eq(courseSections.id, lessons.sectionId))
    .innerJoin(courses, eq(courses.id, lessonNotes.courseId))
    .innerJoin(
      enrollments,
      and(
        eq(enrollments.userId, userId),
        eq(enrollments.courseId, lessonNotes.courseId),
      ),
    )
    .where(
      and(
        eq(lessonNotes.userId, userId),
        eq(lessonNotes.courseId, courseId),
        eq(lessons.courseId, lessonNotes.courseId),
        eq(courseSections.courseId, lessonNotes.courseId),
        eq(lessons.status, "published"),
        inArray(courses.status, ["published", "archived"]),
        inArray(enrollments.status, ["active", "completed"]),
      ),
    )
    .orderBy(asc(courseSections.position), asc(lessons.position), asc(lessons.createdAt));
}

/**
 * ONE count query for the course-page "My notes (N)" link. Uses the same lesson
 * filters as listMyCourseNotes so the count matches the notes page; the caller
 * only runs it for an active enrollment.
 */
export async function countMyCourseNotes(userId: string, courseId: string): Promise<number> {
  const db = await getDb();
  const row = await db
    .select({ count: sql<number>`count(*)` })
    .from(lessonNotes)
    .innerJoin(lessons, eq(lessons.id, lessonNotes.lessonId))
    .innerJoin(courseSections, eq(courseSections.id, lessons.sectionId))
    .innerJoin(courses, eq(courses.id, lessonNotes.courseId))
    .where(
      and(
        eq(lessonNotes.userId, userId),
        eq(lessonNotes.courseId, courseId),
        eq(lessons.courseId, lessonNotes.courseId),
        eq(courseSections.courseId, lessonNotes.courseId),
        eq(lessons.status, "published"),
        inArray(courses.status, ["published", "archived"]),
      ),
    )
    .get();
  return Number(row?.count ?? 0);
}

/**
 * Upsert one note per (user, lesson). An empty normalised body deletes it.
 * A 1 s per-user/per-lesson throttle rejects runaway clients softly.
 */
export async function saveMyLessonNote(
  userId: string,
  input: SaveLessonNoteInput,
): Promise<SaveLessonNoteResult> {
  const parsed = saveLessonNoteSchema.safeParse(input);
  if (!parsed.success) {
    throw new AppError(
      "invalid",
      parsed.error.issues.map((issue) => issue.message).join(", "),
    );
  }

  const { course, lesson } = await requireEnrolledLesson(
    userId,
    parsed.data.courseSlug,
    parsed.data.lessonSlug,
    "save",
  );
  const body = parsed.data.body;
  const db = await getDb();

  const existing = await db
    .select({ id: lessonNotes.id, updatedAt: lessonNotes.updatedAt })
    .from(lessonNotes)
    .where(and(eq(lessonNotes.userId, userId), eq(lessonNotes.lessonId, lesson.id)))
    .get();

  const now = new Date();
  if (existing && now.getTime() - existing.updatedAt.getTime() < NOTE_THROTTLE_MS) {
    throw new AppError("conflict", "Saving too fast — please wait a moment and try again.");
  }

  if (!body) {
    if (existing) {
      await db
        .delete(lessonNotes)
        .where(and(eq(lessonNotes.userId, userId), eq(lessonNotes.lessonId, lesson.id)));
    }
    return { updatedAt: null, deleted: Boolean(existing) };
  }

  await db
    .insert(lessonNotes)
    .values({
      id: newNoteId(),
      userId,
      courseId: course.id,
      lessonId: lesson.id,
      body,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [lessonNotes.userId, lessonNotes.lessonId],
      set: { body, courseId: course.id, updatedAt: now },
    });

  return { updatedAt: now, deleted: false };
}

/** Delete is owner-scoped only: another learner can never target this row. */
export async function deleteMyLessonNote(
  userId: string,
  input: DeleteLessonNoteInput,
): Promise<{ deleted: boolean }> {
  const { course, lesson } = await requireEnrolledLesson(
    userId,
    input.courseSlug,
    input.lessonSlug,
    "delete",
  );
  const db = await getDb();
  const existing = await db
    .select({ id: lessonNotes.id })
    .from(lessonNotes)
    .where(
      and(
        eq(lessonNotes.userId, userId),
        eq(lessonNotes.lessonId, lesson.id),
        eq(lessonNotes.courseId, course.id),
      ),
    )
    .get();
  if (!existing) return { deleted: false };

  await db
    .delete(lessonNotes)
    .where(and(eq(lessonNotes.userId, userId), eq(lessonNotes.id, existing.id)));
  return { deleted: true };
}
