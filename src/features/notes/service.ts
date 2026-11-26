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
import { getSequentialBlocker } from "@/features/progress/service";
import { getLessonReadAccess } from "@/features/courses/lesson-access";
import { isLessonReleased, type ReleaseRule } from "@/features/courses/release";
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
  // DRIP (Batch J): locked lessons refuse note reads and writes alike.
  const db = await getDb();
  const noteSection = await db
    .select()
    .from(courseSections)
    .where(eq(courseSections.id, lesson.sectionId))
    .get();
  if (!isLessonReleased(noteSection ?? null, lesson, activeEnrollment.enrolledAt)) {
    throw new AppError("forbidden", "This lesson has not unlocked yet.");
  }
  // SEQUENTIAL (learner polish): notes on a lesson locked behind earlier
  // required lessons are refused, same as progress and quiz writes.
  if (course.sequential) {
    const blocker = await getSequentialBlocker({ course, enrollment: activeEnrollment, lesson });
    if (blocker) {
      throw new AppError("forbidden", "Finish the previous lesson to unlock this one.");
    }
  }

  return { course, lesson, enrollment: activeEnrollment };
}

/**
 * Owner-scoped read. Joins the learner's CURRENT enrollment so cancelled
 * enrollments keep their rows but read as "no note" (the UI stays hidden until
 * they re-enroll). Also requires a published lesson on a live/archived course.
 * Batch J: pass `release` (the enrollment's enrolledAt) to also hide notes on
 * drip-locked lessons; without it the pre-drip behavior is kept (tests).
 */
export async function getMyLessonNote(
  userId: string,
  lessonId: string,
  release?: { enrolledAt: Date; now?: Date } | null,
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
      releaseMode: lessons.releaseMode,
      releaseAt: lessons.releaseAt,
      dripDays: lessons.dripDays,
      sectionReleaseMode: courseSections.releaseMode,
      sectionReleaseAt: courseSections.releaseAt,
      sectionDripDays: courseSections.dripDays,
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
        eq(lessonNotes.lessonId, lessonId),
        eq(lessons.courseId, lessonNotes.courseId),
        eq(lessons.status, "published"),
        inArray(courses.status, ["published", "archived"]),
        inArray(enrollments.status, ["active", "completed"]),
      ),
    )
    .get();
  if (!row) return null;
  if (release) {
    const section: ReleaseRule = {
      releaseMode: row.sectionReleaseMode,
      releaseAt: row.sectionReleaseAt,
      dripDays: row.sectionDripDays,
    };
    if (
      !isLessonReleased(
        section,
        { releaseMode: row.releaseMode, releaseAt: row.releaseAt, dripDays: row.dripDays, isPreview: false },
        release.enrolledAt,
        release.now ?? new Date(),
      )
    ) {
      return null;
    }
  }
  return {
    id: row.id,
    userId: row.userId,
    courseId: row.courseId,
    lessonId: row.lessonId,
    body: row.body,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Every note the learner can currently see in one course, curriculum order.
 * Batch J: pass `release` to hide notes on drip-locked lessons. */
export async function listMyCourseNotes(
  userId: string,
  courseId: string,
  release?: { enrolledAt: Date; now?: Date } | null,
): Promise<CourseNoteEntry[]> {
  const db = await getDb();
  const rows = await db
    .select({
      id: lessonNotes.id,
      lessonId: lessonNotes.lessonId,
      lessonTitle: lessons.title,
      lessonSlug: lessons.slug,
      body: lessonNotes.body,
      updatedAt: lessonNotes.updatedAt,
      releaseMode: lessons.releaseMode,
      releaseAt: lessons.releaseAt,
      dripDays: lessons.dripDays,
      sectionReleaseMode: courseSections.releaseMode,
      sectionReleaseAt: courseSections.releaseAt,
      sectionDripDays: courseSections.dripDays,
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
  const now = release?.now ?? new Date();
  return rows
    .filter((row) => {
      if (!release) return true;
      return isLessonReleased(
        {
          releaseMode: row.sectionReleaseMode,
          releaseAt: row.sectionReleaseAt,
          dripDays: row.sectionDripDays,
        },
        { releaseMode: row.releaseMode, releaseAt: row.releaseAt, dripDays: row.dripDays, isPreview: false },
        release.enrolledAt,
        now,
      );
    })
    .map((row) => ({
      id: row.id,
      lessonId: row.lessonId,
      lessonTitle: row.lessonTitle,
      lessonSlug: row.lessonSlug,
      body: row.body,
      updatedAt: row.updatedAt,
    }));
}

/**
 * ONE count query for the course-page "My notes (N)" link. Uses the same lesson
 * filters as listMyCourseNotes so the count matches the notes page; the caller
 * only runs it for an active enrollment. Batch J: pass `release` so the count
 * matches the drip-filtered list.
 */
export async function countMyCourseNotes(
  userId: string,
  courseId: string,
  release?: { enrolledAt: Date; now?: Date } | null,
): Promise<number> {
  if (!release) {
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
  return (await listMyCourseNotes(userId, courseId, release)).length;
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
