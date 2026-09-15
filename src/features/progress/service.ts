import { getDb } from "@/lib/db";
import { enrollments, lessonProgress, type Enrollment, type Lesson } from "@/lib/db";
import { and, eq } from "drizzle-orm";
import {
  getAdminLessonById,
  getPublishedCourseLessons,
} from "@/features/courses/service";
import { hasLearnerAccess } from "@/features/enrollments/access";

// ============================================================================
// PROGRESS SERVICE (Mission 06)
// Server-authoritative. Progress percentage counts REQUIRED PUBLISHED lessons
// only; optional lessons never affect the denominator. Course completion =
// all required published lessons complete -> enrollment.completedAt set.
// Deterministic rule on curriculum change: completion is re-evaluated from
// current required-published set every time progress is read or written.
// ============================================================================

export interface CourseProgress {
  totalRequired: number;
  completedRequired: number;
  percent: number;
  completed: boolean;
  completedLessonIds: string[];
  resumeLesson: Lesson | null;
  nextAfterLessonId: Record<string, Lesson | null>;
}

export async function getEnrollmentProgress(enrollment: Enrollment): Promise<CourseProgress> {
  const db = await getDb();
  // PERFORMANCE (review correction F): ONE published-lessons fetch. The
  // previous code called getPublishedCourseLessons twice (required set +
  // next-map) — 2x the curriculum queries per progress read.
  const publishedAll = await getPublishedCourseLessons(enrollment.courseId);
  const requiredPublished = publishedAll.filter((l) => l.required);

  const rows = await db
    .select()
    .from(lessonProgress)
    .where(eq(lessonProgress.enrollmentId, enrollment.id));

  // Only count progress for lessons that are still required + published.
  const validIds = new Set(requiredPublished.map((l) => l.id));
  const completedIds = rows.map((r) => r.lessonId).filter((id) => validIds.has(id));
  const completedSet = new Set(completedIds);

  const totalRequired = requiredPublished.length;
  const completedRequired = completedSet.size;
  const percent =
    totalRequired === 0 ? 100 : Math.round((completedRequired / totalRequired) * 100);
  const completed = totalRequired > 0 && completedRequired >= totalRequired;

  const resumeLesson =
    requiredPublished.find((l) => !completedSet.has(l.id)) ?? null;

  const nextAfterLessonId: Record<string, Lesson | null> = {};
  for (let i = 0; i < publishedAll.length; i++) {
    nextAfterLessonId[publishedAll[i].id] = publishedAll[i + 1] ?? null;
  }

  // CONSISTENCY (review correction H): reconcile the enrollment row with the
  // recomputed verdict. Curriculum edits (new required lesson, lesson
  // unpublished) change the verdict after the fact — a stale
  // status="completed" must reopen to active, and a newly-satisfied set must
  // close to completed, on the next read OR write. Reads and writes share
  // this one helper so the two paths can never disagree.
  await reconcileEnrollmentCompletion(enrollment, completed);

  return {
    totalRequired,
    completedRequired,
    percent,
    completed,
    completedLessonIds: completedIds,
    resumeLesson,
    nextAfterLessonId,
  };
}

/**
 * Bring enrollment.status/completedAt in line with the recomputed completion
 * verdict. No-op when already consistent. Exported for tests.
 *
 * Reads the CURRENT row (never the caller-passed snapshot): progress callers
 * routinely hold objects fetched before earlier completions, and a stale
 * status="active" snapshot must not suppress the reopen write.
 */
export async function reconcileEnrollmentCompletion(
  enrollment: Enrollment,
  completed: boolean
): Promise<void> {
  const db = await getDb();
  const current = await db
    .select()
    .from(enrollments)
    .where(eq(enrollments.id, enrollment.id))
    .get();
  if (!current) return;
  if (completed && current.status !== "completed") {
    await db
      .update(enrollments)
      .set({ completedAt: new Date(), status: "completed" })
      .where(eq(enrollments.id, enrollment.id));
  } else if (!completed && current.status === "completed") {
    // Curriculum grew (or a lesson unpublished): reopen the enrollment so
    // progress bars, resume logic, and status agree again.
    await db
      .update(enrollments)
      .set({ completedAt: null, status: "active" })
      .where(eq(enrollments.id, enrollment.id));
  }
}

/**
 * Mark a lesson complete for an enrollment. Idempotent.
 * Ownership is resolved server-side: the enrollment must belong to the user
 * and the lesson must belong to the enrollment's course.
 */
export async function markLessonComplete(
  userId: string,
  enrollmentId: string,
  lessonId: string
): Promise<{ enrollment: Enrollment; progress: CourseProgress; alreadyComplete: boolean }> {
  const db = await getDb();

  const enrollment = await db
    .select()
    .from(enrollments)
    .where(eq(enrollments.id, enrollmentId))
    .get();
  if (!enrollment) throw new Error("Enrollment not found.");
  if (enrollment.userId !== userId) {
    throw new Error("Forbidden: This enrollment belongs to another learner.");
  }
  // SECURITY (review correction C): cancelled enrollments write nothing.
  if (!hasLearnerAccess(enrollment)) {
    throw new Error("Forbidden: This enrollment is no longer active.");
  }

  const lesson = await getAdminLessonById(lessonId);
  if (!lesson) throw new Error("Lesson not found.");
  if (lesson.courseId !== enrollment.courseId) {
    throw new Error("Forbidden: This lesson does not belong to the enrolled course.");
  }
  if (lesson.status !== "published") {
    throw new Error("This lesson is not published and cannot be completed.");
  }

  const existing = await db
    .select()
    .from(lessonProgress)
    .where(and(eq(lessonProgress.enrollmentId, enrollment.id), eq(lessonProgress.lessonId, lesson.id)))
    .get();

  let alreadyComplete = false;
  if (existing) {
    alreadyComplete = true;
  } else {
    try {
      await db.insert(lessonProgress).values({
        id: `prog_${crypto.randomUUID().slice(0, 12)}`,
        enrollmentId: enrollment.id,
        lessonId: lesson.id,
        completedAt: new Date(),
      });
    } catch {
      // Race: another request completed it first (UNIQUE index) — treat as
      // idempotent success instead of a 500.
      alreadyComplete = true;
    }
  }

  // getEnrollmentProgress reconciles completion (correction H) — no separate
  // ad-hoc status write here, so read and write paths share one verdict.
  const progress = await getEnrollmentProgress(enrollment);

  const updated = await db
    .select()
    .from(enrollments)
    .where(eq(enrollments.id, enrollment.id))
    .get();

  return { enrollment: updated!, progress, alreadyComplete };
}

/** Is this lesson complete for this enrollment? */
export async function isLessonComplete(enrollmentId: string, lessonId: string): Promise<boolean> {
  const db = await getDb();
  const row = await db
    .select()
    .from(lessonProgress)
    .where(and(eq(lessonProgress.enrollmentId, enrollmentId), eq(lessonProgress.lessonId, lessonId)))
    .get();
  return !!row;
}
