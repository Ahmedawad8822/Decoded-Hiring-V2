import { getDb, enrollments, lessonProgress, lessons } from "@/lib/db";
import { and, eq, sql } from "drizzle-orm";

// ============================================================================
// COURSE-WIDE COMPLETION RECONCILE (write path only)
// Completion is derived from the current required-published lesson set. When an
// admin changes that set (publish/unpublish a lesson, toggle `required`), every
// enrollment of the course may flip active <-> completed. That flip happens
// HERE, at the moment of the curriculum write — never as a side effect of a
// learner page render.
//
// Lives in its own module (not progress/service.ts) because the progress
// service imports the courses service; the courses service must call this, so
// the reconcile may depend on the DB layer only (no import cycle).
// ============================================================================

/**
 * Bring ALL enrollments of one course in line with the current curriculum, in
 * exactly TWO set-based UPDATE statements (no per-enrollment fan-out, no bound
 * parameter lists, so it scales with enrollment count and never trips D1's
 * variable limit):
 *
 *   1. active    -> completed  when the course has >= 1 required published
 *                              lesson and the enrollment has completed all.
 *   2. completed -> active     otherwise (curriculum grew / lesson unpublished /
 *                              no required lessons remain).
 *
 * The verdict is computed inside SQL with the same rule as
 * computeCourseProgress(): required AND published lessons only, zero required
 * lessons => NOT completed, completions of unpublished lessons ignored.
 *
 * SECURITY INVARIANT: each UPDATE is guarded by `status = 'active'` /
 * `status = 'completed'`, so a cancelled enrollment is never touched, and a
 * cancellation landing concurrently is never overwritten. Reactivation of a
 * cancelled learner happens only through the explicit enrollFree flow.
 */
export async function reconcileCourseEnrollments(courseId: string): Promise<void> {
  const db = await getDb();

  // Does the course have at least one required published lesson?
  const hasRequiredPublished = sql`EXISTS (
    SELECT 1 FROM ${lessons}
    WHERE ${lessons.courseId} = ${enrollments.courseId}
      AND ${lessons.status} = 'published'
      AND ${lessons.required} = 1
  )`;
  // Is there a required published lesson this enrollment has NOT completed?
  const hasMissingRequired = sql`EXISTS (
    SELECT 1 FROM ${lessons}
    WHERE ${lessons.courseId} = ${enrollments.courseId}
      AND ${lessons.status} = 'published'
      AND ${lessons.required} = 1
      AND NOT EXISTS (
        SELECT 1 FROM ${lessonProgress}
        WHERE ${lessonProgress.enrollmentId} = ${enrollments.id}
          AND ${lessonProgress.lessonId} = ${lessons.id}
      )
  )`;

  await db
    .update(enrollments)
    .set({ completedAt: new Date(), status: "completed" })
    .where(
      and(
        eq(enrollments.courseId, courseId),
        eq(enrollments.status, "active"),
        hasRequiredPublished,
        sql`NOT ${hasMissingRequired}`
      )
    );

  await db
    .update(enrollments)
    .set({ completedAt: null, status: "active" })
    .where(
      and(
        eq(enrollments.courseId, courseId),
        eq(enrollments.status, "completed"),
        sql`(NOT ${hasRequiredPublished} OR ${hasMissingRequired})`
      )
    );
}
