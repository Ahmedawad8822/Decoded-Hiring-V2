import { getDb } from "@/lib/db";
import { enrollments, type Enrollment } from "@/lib/db";
import { and, eq } from "drizzle-orm";
import { getAdminCourseById } from "@/features/courses/service";

// ============================================================================
// ENROLLMENTS SERVICE (Mission 06)
// Only FREE published courses auto-enroll. Archived courses reject NEW
// enrollments; existing learners keep access (no revocation here).
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

export async function enrollFree(userId: string, courseId: string): Promise<Enrollment> {
  const db = await getDb();
  const course = await getAdminCourseById(courseId);
  if (!course) throw new Error("Course not found.");
  if (course.status === "archived") {
    throw new Error("This course is archived and no longer accepts new enrollments.");
  }
  if (course.status !== "published") {
    throw new Error("This course is not yet published and cannot be enrolled in.");
  }
  if (course.accessMode !== "FREE") {
    if (course.accessMode === "PAID_ONE_TIME") {
      throw new Error("This course requires a one-time payment. Online checkout is not available yet — please contact us.");
    }
    if (course.accessMode === "MANUAL_INVOICE") {
      throw new Error("This course is enrolled by manual invoice. Please contact us to arrange access.");
    }
    throw new Error("Enrollment is currently disabled for this course.");
  }

  // Idempotent: existing enrollment wins (unique userId+courseId).
  const existing = await getEnrollment(userId, courseId);
  if (existing) return existing;

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
  } catch {
    // Race: another request inserted first — return the winner.
    const winner = await getEnrollment(userId, courseId);
    if (winner) return winner;
    throw new Error("Enrollment failed. Please try again.");
  }
  return (await getEnrollment(userId, courseId))!;
}

/** Server-side ownership check: does this user have an active enrollment path to this course? */
export async function requireEnrollment(userId: string, courseId: string): Promise<Enrollment> {
  const enrollment = await getEnrollment(userId, courseId);
  if (!enrollment) {
    throw new Error("Forbidden: You are not enrolled in this course.");
  }
  return enrollment;
}
