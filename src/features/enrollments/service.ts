import { getDb } from "@/lib/db";
import { enrollments, type Enrollment } from "@/lib/db";
import { and, eq } from "drizzle-orm";
import { getAdminCourseById } from "@/features/courses/service";
import { hasLearnerAccess } from "./access";
import { isUniqueConstraintError } from "@/lib/db/sqlite-errors";
import { AppError } from "@/lib/errors";
import { getEffectiveCourseAccessPolicy } from "@/features/offers/service";

// ============================================================================
// ENROLLMENTS SERVICE (Mission 06)
// Only effectively-FREE published courses auto-enroll. A linked Mission 08.3
// Offer is authoritative; courses without one retain Mission 06 accessMode as
// a compatibility fallback. Archived courses reject NEW enrollments; existing
// learners keep access (no revocation here).
// ============================================================================

export async function getEnrollment(userId: string, courseId: string): Promise<Enrollment | null> {
  const db = await getDb();
  const row = await db
    .select()
    .from(enrollments)
    .where(and(eq(enrollments.userId, userId), eq(enrollments.courseId, courseId)))
    .get();
  return row || null;
}

export async function getUserEnrollments(userId: string): Promise<Enrollment[]> {
  const db = await getDb();
  const { desc } = await import("drizzle-orm");
  return db.select().from(enrollments).where(eq(enrollments.userId, userId)).orderBy(desc(enrollments.enrolledAt));
}

/**
 * Learner collection reads (/learn, /learn/courses).
 * Cancelled enrollments are filtered BEFORE any course/progress work: they
 * must not appear as active/completed learner courses and must not trigger
 * progress reconciliation. Uses the shared hasLearnerAccess() rule — never
 * a second local status check.
 */
export async function getAccessibleEnrollments(userId: string): Promise<Enrollment[]> {
  const all = await getUserEnrollments(userId);
  return all.filter((e) => hasLearnerAccess(e));
}

export async function enrollFree(userId: string, courseId: string): Promise<Enrollment> {
  const db = await getDb();
  const course = await getAdminCourseById(courseId);
  if (!course) throw new AppError("not_found", "Course not found.");
  if (course.status === "archived") {
    throw new AppError("invalid", "This course is archived and no longer accepts new enrollments.");
  }
  if (course.status !== "published") {
    throw new AppError("invalid", "This course is not yet published and cannot be enrolled in.");
  }
  const access = await getEffectiveCourseAccessPolicy(course);
  if (!access.available) {
    throw new AppError("invalid", "Enrollment is currently unavailable for this course.");
  }
  if (access.mode !== "FREE") {
    if (access.mode === "PAID_ONE_TIME") {
      throw new AppError(
        "invalid",
        "This course requires a one-time payment. Online checkout is not available yet — please use the configured alternative access path.",
      );
    }
    if (access.mode === "MANUAL_INVOICE") {
      throw new AppError("invalid", "This course is enrolled by manual invoice. Please use the configured access path.");
    }
    if (access.mode === "COMING_SOON") {
      throw new AppError("invalid", "Enrollment for this course is coming soon.");
    }
    throw new AppError("invalid", "Enrollment is currently disabled for this course.");
  }

  // Idempotent: existing enrollment wins (unique userId+courseId).
  // Cancelled enrollments reactivate on re-enroll: the learner asked for
  // access again and FREE has no checkout gate, so restore active status
  // instead of stacking a second row (which the UNIQUE index forbids).
  const existing = await getEnrollment(userId, courseId);
  if (existing) {
    if (existing.status === "cancelled") {
      await db
        .update(enrollments)
        .set({ status: "active", completedAt: null })
        .where(and(eq(enrollments.id, existing.id), eq(enrollments.status, "cancelled")));
      return (await getEnrollment(userId, courseId))!;
    }
    return existing;
  }

  const now = new Date();
  const id = `enroll_${crypto.randomUUID().slice(0, 12)}`;
  try {
    await db.insert(enrollments).values({
      id,
      userId,
      courseId,
      status: "active",
      accessSource: "free",
      enrolledAt: now,
      completedAt: null,
    });
  } catch (error: unknown) {
    // Narrow recovery: ONLY the (user_id, course_id) UNIQUE race is
    // interpreted as "another request inserted first" — return the winner.
    // Any unrelated DB failure (locked DB, I/O, schema drift) must propagate
    // untouched; it is NOT a duplicate race and must never be swallowed.
    if (!isUniqueConstraintError(error)) throw error;
    // Verify the EXPECTED winner (same userId + courseId) actually exists
    // before treating the unique failure as a lost race. If no such
    // enrollment exists, rethrow the original DB error — it was not the
    // duplicate race this recovery handles.
    const winner = await getEnrollment(userId, courseId);
    if (winner) return winner;
    throw error;
  }
  return (await getEnrollment(userId, courseId))!;
}

/** Server-side ownership check: does this user have an active enrollment path to this course? */
export async function requireEnrollment(userId: string, courseId: string): Promise<Enrollment> {
  const enrollment = await getEnrollment(userId, courseId);
  if (!hasLearnerAccess(enrollment)) {
    throw new AppError("forbidden", "Forbidden: You are not enrolled in this course.");
  }
  return enrollment;
}
