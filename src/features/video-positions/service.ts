import { and, eq } from "drizzle-orm";
import {
  courseSections,
  getDb,
  lessonVideoPositions,
  type Enrollment,
  type Lesson,
  type LessonVideoPosition,
} from "@/lib/db";
import {
  getLearnerCourseBySlug,
  getPublishedLessonBySlug,
} from "@/features/courses/service";
import { getLessonReadAccess } from "@/features/courses/lesson-access";
import { getSequentialBlocker } from "@/features/progress/service";
import { isLessonReleased } from "@/features/courses/release";
import { getEnrollment } from "@/features/enrollments/service";
import { hasLearnerAccess } from "@/features/enrollments/access";
import { AppError } from "@/lib/errors";
import {
  saveVideoPositionSchema,
  type SaveVideoPositionInput,
} from "./types";

// ============================================================================
// VIDEO POSITIONS SERVICE (learner polish: resume + 90% auto-complete)
// ----------------------------------------------------------------------------
// SECURITY BOUNDARY: every write is scoped by the caller's user id and
// requires a current ACTIVE/COMPLETED enrollment on a readable, unlocked
// lesson. Reads are owner-scoped the same way. Numbers are validated by the
// zod schema (finite, non-negative, capped, within duration tolerance).
// One write per save (upsert on the user+lesson primary key).
// ============================================================================

interface AuthorizedLesson {
  lesson: Lesson;
  enrollment: Enrollment;
}

/**
 * Write authorization: signed-in (caller guarantees), active/completed
 * enrollment, published lesson the shared read gate calls "enrolled", and a
 * lesson that belongs to the course named in the URL — plus the drip and
 * sequential gates, so positions can only be recorded where the player is
 * actually served (the lesson page shows a lock otherwise).
 */
async function requireTrackableLesson(
  userId: string,
  courseSlug: string,
  lessonSlug: string,
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
    throw new AppError("forbidden", "Enroll in this course to track video progress.");
  }

  const db = await getDb();
  const section = await db
    .select()
    .from(courseSections)
    .where(eq(courseSections.id, lesson.sectionId))
    .get();
  if (!isLessonReleased(section ?? null, lesson, activeEnrollment.enrolledAt)) {
    throw new AppError("forbidden", "This lesson has not unlocked yet.");
  }
  if (course.sequential && !lesson.isPreview) {
    const blocker = await getSequentialBlocker({ course, enrollment: activeEnrollment, lesson });
    if (blocker) {
      throw new AppError("forbidden", "Finish the previous lesson to unlock this one.");
    }
  }

  return { lesson, enrollment: activeEnrollment };
}

/**
 * Save (upsert) the learner's watched position for one lesson. ONE write.
 * The stored position is clamped to the known duration so resume never seeks
 * past the end. Returns the stored row.
 */
export async function saveMyVideoPosition(
  userId: string,
  input: SaveVideoPositionInput,
): Promise<LessonVideoPosition> {
  const parsed = saveVideoPositionSchema.safeParse(input);
  if (!parsed.success) {
    throw new AppError(
      "invalid",
      parsed.error.issues.map((issue) => issue.message).join(", "),
    );
  }

  const { lesson } = await requireTrackableLesson(userId, parsed.data.courseSlug, parsed.data.lessonSlug);

  const duration = parsed.data.durationSeconds ?? null;
  const position =
    duration != null ? Math.min(Math.max(parsed.data.positionSeconds, 0), duration) : parsed.data.positionSeconds;

  const db = await getDb();
  const now = new Date();
  await db
    .insert(lessonVideoPositions)
    .values({
      userId,
      lessonId: lesson.id,
      positionSeconds: position,
      durationSeconds: duration,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [lessonVideoPositions.userId, lessonVideoPositions.lessonId],
      set: { positionSeconds: position, durationSeconds: duration, updatedAt: now },
    });

  return (await getMyVideoPosition(userId, lesson.id))!;
}

/** Owner-scoped read: one row per (learner, lesson), null when never saved. */
export async function getMyVideoPosition(
  userId: string,
  lessonId: string,
): Promise<LessonVideoPosition | null> {
  const db = await getDb();
  const row = await db
    .select()
    .from(lessonVideoPositions)
    .where(
      and(eq(lessonVideoPositions.userId, userId), eq(lessonVideoPositions.lessonId, lessonId)),
    )
    .get();
  return row ?? null;
}
