import { getDb } from "@/lib/db";
import {
  enrollments,
  lessonProgress,
  lessonVideoPositions,
  lessons,
  type Enrollment,
} from "@/lib/db";
import { and, eq, inArray } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { getAdminCourseById } from "@/features/courses/service";
import { hasLearnerAccess } from "./access";
import { isUniqueConstraintError } from "@/lib/db/sqlite-errors";
import { AppError } from "@/lib/errors";
import { getEffectiveCourseAccessPolicy, getOfferForCourse } from "@/features/offers/service";
import {
  ACTIVE_ENROLLMENT_STATUSES,
  assertOfferOpen,
} from "@/features/offers/availability";
import { getD1Database } from "@/lib/cloudflare/bindings";
import {
  notifyCourseLeft,
  notifyCourseRestarted,
  notifyEnrollmentWelcome,
} from "@/lib/email/triggers";

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
  // access again and FREE has no checkout gate, so restore access instead of
  // stacking a second row (which the UNIQUE index forbids). The restored
  // status is recomputed from the learner's kept state (lesson_progress rows,
  // which already encode the quiz requirePass gate — see markLessonComplete):
  // fully complete => completed with a completion date, otherwise active.
  // cancelledAt is cleared; progress, quiz attempts, notes and certificates
  // are never touched here.
  //
  // Offer limits: a reactivation re-claims a seat, so a closed or sold-out
  // offer refuses it. Already-active enrollments are never touched.
  const existing = await getEnrollment(userId, courseId);
  const offer = await getOfferForCourse(courseId);
  if (existing) {
    if (existing.status === "cancelled") {
      if (offer) await assertOfferOpen(offer);
      const { getEnrollmentProgress } = await import("@/features/progress/service");
      const progress = await getEnrollmentProgress(existing);
      const completed = progress.completed;
      const reactivatedAt = new Date();
      const reactivatedStatus = completed ? "completed" : "active";
      const reactivatedCompletedAt = completed
        ? (existing.completedAt ?? reactivatedAt)
        : null;
      if (offer?.seatLimit != null) {
        // Race-safe: the reactivation only lands while a seat is still free.
        const d1 = await getD1Database();
        const claimed = await d1
          .prepare(
            `UPDATE enrollments
             SET status = ?, completed_at = ?, cancelled_at = NULL
             WHERE id = ? AND status = 'cancelled'
               AND (SELECT COUNT(*) FROM enrollments
                    WHERE course_id = ? AND status IN (${ACTIVE_ENROLLMENT_STATUSES.map(() => "?").join(", ")})) < ?`,
          )
          .bind(
            reactivatedStatus,
            reactivatedCompletedAt
              ? Math.floor(reactivatedCompletedAt.getTime() / 1000)
              : null,
            existing.id,
            courseId,
            ...ACTIVE_ENROLLMENT_STATUSES,
            offer.seatLimit,
          )
          .run();
        if ((claimed.meta?.changes ?? 0) === 0) {
          const reread = await getEnrollment(userId, courseId);
          if (reread && reread.status !== "cancelled") return reread;
          throw new AppError("conflict", "This offer has sold out.");
        }
      } else {
        await db
          .update(enrollments)
          .set({
            status: reactivatedStatus,
            completedAt: reactivatedCompletedAt,
            cancelledAt: null,
          })
          .where(and(eq(enrollments.id, existing.id), eq(enrollments.status, "cancelled")));
      }
      const restored = (await getEnrollment(userId, courseId))!;
      // Reactivation (not already-active): welcome email, deduped by time.
      await notifyEnrollmentWelcome({
        userId,
        courseId,
        courseSlug: course.slug,
        courseTitle: course.title,
        eventAt: reactivatedAt,
      });
      return restored;
    }
    return existing;
  }

  if (offer) await assertOfferOpen(offer);

  const now = new Date();
  const id = `enroll_${crypto.randomUUID().slice(0, 12)}`;
  if (offer?.seatLimit != null) {
    // Race-safe last-seat claim: the INSERT only lands while the capped
    // COUNT(*) subquery still has room, in a single statement, so two
    // concurrent attempts cannot both win. D1 executes the statement
    // atomically; the loser sees 0 changes and gets the sold-out conflict
    // (or the idempotent winner when it lost to its own retry).
    const d1 = await getD1Database();
    const claimed = await d1
      .prepare(
        `INSERT INTO enrollments
           (id, user_id, course_id, status, access_source, enrolled_at, completed_at)
         SELECT ?, ?, ?, 'active', 'free', ?, NULL
         WHERE (SELECT COUNT(*) FROM enrollments
                WHERE course_id = ? AND status IN (${ACTIVE_ENROLLMENT_STATUSES.map(() => "?").join(", ")})) < ?
           AND NOT EXISTS (SELECT 1 FROM enrollments
                           WHERE user_id = ? AND course_id = ?)`,
      )
      .bind(
        id,
        userId,
        courseId,
        Math.floor(now.getTime() / 1000),
        courseId,
        ...ACTIVE_ENROLLMENT_STATUSES,
        offer.seatLimit,
        userId,
        courseId,
      )
      .run();
    if ((claimed.meta?.changes ?? 0) === 0) {
      const winner = await getEnrollment(userId, courseId);
      if (winner && winner.status !== "cancelled") {
        await notifyEnrollmentWelcome({
          userId,
          courseId,
          courseSlug: course.slug,
          courseTitle: course.title,
          eventAt: winner.enrolledAt,
        });
        return winner;
      }
      throw new AppError("conflict", "This offer has sold out.");
    }
    const created = (await getEnrollment(userId, courseId))!;
    await notifyEnrollmentWelcome({
      userId,
      courseId,
      courseSlug: course.slug,
      courseTitle: course.title,
      eventAt: created.enrolledAt,
    });
    return created;
  }
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
    if (winner) {
      // Same dedupe key as the creator path: a no-op if the winning request
      // already queued it, a backfill if that request crashed first. Never
      // throws (email failures are caught and logged inside the trigger).
      await notifyEnrollmentWelcome({
        userId,
        courseId,
        courseSlug: course.slug,
        courseTitle: course.title,
        eventAt: winner.enrolledAt,
      });
      return winner;
    }
    throw error;
  }
  const created = (await getEnrollment(userId, courseId))!;
  // New enrollment: welcome email. Never throws (failures stay in the log).
  await notifyEnrollmentWelcome({
    userId,
    courseId,
    courseSlug: course.slug,
    courseTitle: course.title,
    eventAt: created.enrolledAt,
  });
  return created;
}

/**
 * Learner-initiated cancellation (Batch F: "leave this course").
 * Scoped by user id + course id only — the caller never supplies an
 * enrollment id, so one learner can never cancel another learner's row.
 * Idempotent: an already-cancelled enrollment is returned untouched (no
 * write). The conditional UPDATE only replaces active/completed, so a
 * concurrent re-enrollment is never overwritten.
 * Progress, quiz attempts, notes and certificates are NOT deleted here;
 * completedAt is preserved as part of the learner's record and only
 * recomputed on re-enrollment (see enrollFree).
 */
export async function cancelMyEnrollment(userId: string, courseId: string): Promise<Enrollment> {
  const db = await getDb();
  const existing = await getEnrollment(userId, courseId);
  if (!existing) throw new AppError("not_found", "Enrollment not found.");
  if (existing.status === "cancelled") return existing;
  await db
    .update(enrollments)
    .set({ status: "cancelled", cancelledAt: new Date() })
    .where(
      and(
        eq(enrollments.id, existing.id),
        inArray(enrollments.status, ["active", "completed"]),
      ),
    );
  const left = (await getEnrollment(userId, courseId))!;
  // Only when the status actually changed (not already-cancelled). Never throws.
  if (left.status === "cancelled" && left.cancelledAt) {
    const course = await getAdminCourseById(courseId);
    if (course) {
      await notifyCourseLeft({
        userId,
        courseId,
        courseSlug: course.slug,
        courseTitle: course.title,
        cancelledAt: left.cancelledAt,
      });
    }
  }
  return left;
}

/**
 * Learner-initiated course restart (learner polish).
 * Scoped by user id + course id only — the caller never supplies an
 * enrollment id, so one learner can never restart another learner's row.
 * Clears lesson_progress rows for the enrollment AND lesson_video_positions
 * rows for the learner's lessons in this course (resume positions from D).
 * Quiz attempts, notes, certificates and the enrollment record (including
 * the original enrolledAt, so drip still counts from the first start) are
 * kept. A completed enrollment returns to active with completedAt cleared.
 * Cancelled enrollments cannot restart — they re-enroll instead.
 * Audited like leave-course: a never-throwing `course_restarted` email
 * outbox event (durable, deduped). Never throws the audit failure.
 */
export async function restartMyEnrollment(userId: string, courseId: string): Promise<Enrollment> {
  const db = await getDb();
  const existing = await getEnrollment(userId, courseId);
  if (!hasLearnerAccess(existing)) {
    throw new AppError("forbidden", "Forbidden: You are not enrolled in this course.");
  }
  const enrollment = existing;

  // Scope the video-position clear to this course's lessons only — positions
  // are keyed by (user, lesson), so fetch this course's lesson ids first.
  // Chunked for D1's bound-parameter limit; most courses are one chunk.
  const courseLessons = await db
    .select({ id: lessons.id })
    .from(lessons)
    .where(eq(lessons.courseId, courseId));
  const lessonIds = courseLessons.map((l) => l.id);

  const restartedAt = new Date();
  // Non-empty tuple: the D1 batch type requires at least one statement, and
  // this restart always issues the progress clear plus the status reset.
  const statements: [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]] = [
    db
      .delete(lessonProgress)
      .where(eq(lessonProgress.enrollmentId, enrollment.id)),
    db
      .update(enrollments)
      .set({ status: "active", completedAt: null })
      .where(
        and(
          eq(enrollments.id, enrollment.id),
          inArray(enrollments.status, ["active", "completed"]),
        ),
      ),
  ];
  for (let i = 0; i < lessonIds.length; i += 90) {
    const chunk = lessonIds.slice(i, i + 90);
    statements.push(
      db
        .delete(lessonVideoPositions)
        .where(and(eq(lessonVideoPositions.userId, userId), inArray(lessonVideoPositions.lessonId, chunk))),
    );
  }
  // ATOMICITY: one D1 batch — progress, positions and the status reset land
  // together; a partial restart can never strand cleared progress on a
  // still-completed enrollment.
  await db.batch(statements);

  const restarted = (await getEnrollment(userId, courseId))!;
  const course = await getAdminCourseById(courseId);
  if (course) {
    await notifyCourseRestarted({
      userId,
      courseId,
      courseSlug: course.slug,
      courseTitle: course.title,
      restartedAt,
    });
  }
  return restarted;
}

/** Server-side ownership check: does this user have an active enrollment path to this course? */
export async function requireEnrollment(userId: string, courseId: string): Promise<Enrollment> {
  const enrollment = await getEnrollment(userId, courseId);
  if (!hasLearnerAccess(enrollment)) {
    throw new AppError("forbidden", "Forbidden: You are not enrolled in this course.");
  }
  return enrollment;
}
