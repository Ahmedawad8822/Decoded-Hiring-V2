import { getDb } from "@/lib/db";
import {
  enrollments,
  lessonProgress,
  lessons,
  courses,
  courseSections,
  type Enrollment,
  type Lesson,
} from "@/lib/db";
import { and, asc, eq, inArray } from "drizzle-orm";
import {
  getAdminLessonById,
  getPublishedCourseLessons,
} from "@/features/courses/service";
import { hasLearnerAccess } from "@/features/enrollments/access";
import { isUniqueConstraintError } from "@/lib/db/sqlite-errors";
import { AppError } from "@/lib/errors";

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
  /** ALL published lessons (required + optional) — feeds dashboard cards so
   *  collection reads never re-fetch the curriculum just for a lesson total. */
  totalPublished: number;
  completedLessonIds: string[];
  resumeLesson: Lesson | null;
  nextAfterLessonId: Record<string, Lesson | null>;
}

/** Shape of the shared progress maths (everything derivable from the curriculum + completions). */
export interface ComputedCourseProgress {
  totalRequired: number;
  completedRequired: number;
  percent: number;
  completed: boolean;
  /** Completed ids restricted to currently-published lessons (required + optional). */
  completedLessonIds: string[];
  resumeLesson: Lesson | null;
}

/**
 * THE one place progress maths lives; single and batched reads both call it
 * so they can never drift. Pure: no I/O.
 *
 * `publishedLessons` must already be ordered section.position then
 * lesson.position — resume selection is the first incomplete REQUIRED lesson
 * in that order. Completions of unpublished/unknown lessons are ignored.
 * A course with zero required published lessons has nothing to complete:
 * percent 0, completed false.
 */
export function computeCourseProgress(
  publishedLessons: Lesson[],
  completedLessonIds: Iterable<string>
): ComputedCourseProgress {
  const publishedIds = new Set(publishedLessons.map((l) => l.id));
  // completedLessonIds covers ALL completed published lessons (required +
  // optional) so optional completion stays visibly complete; the verdict
  // below uses ONLY required.
  const completedIds = [...completedLessonIds].filter((id) => publishedIds.has(id));
  const completedSet = new Set(completedIds);

  const required = publishedLessons.filter((l) => l.required);
  const totalRequired = required.length;
  const completedRequired = required.filter((l) => completedSet.has(l.id)).length;
  const percent =
    totalRequired === 0 ? 0 : Math.round((completedRequired / totalRequired) * 100);
  const completed = totalRequired > 0 && completedRequired >= totalRequired;
  const resumeLesson = required.find((l) => !completedSet.has(l.id)) ?? null;

  return { totalRequired, completedRequired, percent, completed, completedLessonIds: completedIds, resumeLesson };
}

export async function getEnrollmentProgress(enrollment: Enrollment): Promise<CourseProgress> {
  const db = await getDb();
  // PERFORMANCE (review correction F): ONE published-lessons fetch. The
  // previous code called getPublishedCourseLessons twice (required set +
  // next-map) — 2x the curriculum queries per progress read.
  const publishedAll = await getPublishedCourseLessons(enrollment.courseId);

  const rows = await db
    .select()
    .from(lessonProgress)
    .where(eq(lessonProgress.enrollmentId, enrollment.id));

  const { totalRequired, completedRequired, percent, completed, completedLessonIds, resumeLesson } =
    computeCourseProgress(publishedAll, rows.map((r) => r.lessonId));

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
    totalPublished: publishedAll.length,
    completedLessonIds,
    resumeLesson,
    nextAfterLessonId,
  };
}

/**
 * Bring enrollment.status/completedAt in line with the recomputed completion
 * verdict. No-op when already consistent. Exported for tests.
 *
 * SECURITY INVARIANT: cancelled is terminal for learner access. This helper
 * NEVER modifies a cancelled enrollment — only active ↔ completed
 * transitions happen here. Without this guard a cancelled learner who had
 * already finished the (current) required set would be resurrected to
 * completed by a mere dashboard/progress read. Reactivation happens ONLY
 * through the explicit re-enrollment flow (enrollFree).
 *
 * Reads the CURRENT row (never the caller-passed snapshot): progress callers
 * routinely hold objects fetched before earlier completions, and a stale
 * status="active" snapshot must not suppress the reopen write. The same
 * current-row read is what makes the cancelled guard authoritative even
 * when the caller holds a stale pre-cancellation snapshot.
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
  if (current.status === "cancelled") return;
  // Each write is conditional on the status it replaces, so a cancellation
  // that lands between the read above and this write is never overwritten.
  if (completed && current.status === "active") {
    await db
      .update(enrollments)
      .set({ completedAt: new Date(), status: "completed" })
      .where(and(eq(enrollments.id, enrollment.id), eq(enrollments.status, "active")));
  } else if (!completed && current.status === "completed") {
    // Curriculum grew (or a lesson unpublished): reopen the enrollment so
    // progress bars, resume logic, and status agree again.
    await db
      .update(enrollments)
      .set({ completedAt: null, status: "active" })
      .where(and(eq(enrollments.id, enrollment.id), eq(enrollments.status, "completed")));
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
  if (!enrollment) throw new AppError("not_found", "Enrollment not found.");
  if (enrollment.userId !== userId) {
    throw new AppError("forbidden", "Forbidden: This enrollment belongs to another learner.");
  }
  // SECURITY (review correction C): cancelled enrollments write nothing.
  if (!hasLearnerAccess(enrollment)) {
    throw new AppError("forbidden", "Forbidden: This enrollment is no longer active.");
  }

  const lesson = await getAdminLessonById(lessonId);
  if (!lesson) throw new AppError("not_found", "Lesson not found.");
  if (lesson.courseId !== enrollment.courseId) {
    throw new AppError("forbidden", "Forbidden: This lesson does not belong to the enrolled course.");
  }
  if (lesson.status !== "published") {
    throw new AppError("invalid", "This lesson is not published and cannot be completed.");
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
    } catch (error: unknown) {
      // Race: another request completed it first (UNIQUE index on
      // enrollment_id, lesson_id) — verify the winner exists and treat as
      // idempotent success. Any unrelated DB error (locked, I/O, schema) must
      // propagate untouched; it is NOT a duplicate race and must never be
      // swallowed.
      if (!isUniqueConstraintError(error)) throw error;
      // Verify the EXPECTED winner (same enrollmentId + lessonId) actually
      // exists before treating the unique failure as a lost race. If no
      // such row exists, rethrow the original DB error — it was not the
      // duplicate race this recovery handles.
      const winner = await db
        .select()
        .from(lessonProgress)
        .where(and(eq(lessonProgress.enrollmentId, enrollment.id), eq(lessonProgress.lessonId, lesson.id)))
        .get();
      if (winner) {
        alreadyComplete = true;
      } else {
        throw error;
      }
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

// ============================================================================
// BATCHED PROGRESS SUMMARY (Item E: Learner Collection Query Fan-Out)
// ============================================================================
// Single domain-owned batch path for collection pages (/learn/courses).
// Batches: enrollments, course metadata, published curriculum for all courses,
// progress rows for all enrollments, current states for reconciliation.
// Query count bounded as enrollment count grows — no per-enrollment fan-out.

export interface BatchedProgressSummary {
  enrollmentId: string;
  courseId: string;
  courseTitle: string;
  courseSlug: string;
  courseAccessMode: string;
  courseStatus: string;
  totalRequired: number;
  completedRequired: number;
  percent: number;
  completed: boolean;
  totalPublished: number;
  completedLessonIds: string[];
  resumeLessonId: string | null;
  /** Slug + title of the deterministic resume lesson (section.position then
   *  lesson.position), so collection pages can build resume links without
   *  any per-enrollment lesson fetch. */
  resumeLessonSlug: string | null;
  resumeLessonTitle: string | null;
  enrollmentStatus: string;
  enrollmentCompletedAt: Date | null;
}

/**
 * Compute progress summaries for multiple enrollments in a bounded number of queries.
 * Returns a map keyed by enrollmentId for O(1) lookups by the caller.
 * Keeps the existing single-enrollment getEnrollmentProgress for detail/player routes.
 */
export async function getBatchedEnrollmentProgress(
  enrollmentsList: Enrollment[]
): Promise<Map<string, BatchedProgressSummary>> {
  if (enrollmentsList.length === 0) return new Map();

  const db = await getDb();

  const enrollmentIds = enrollmentsList.map((e) => e.id);
  const courseIds = [...new Set(enrollmentsList.map((e) => e.courseId))];

  // 1. Batch fetch all course metadata in ONE query
  const courseRows = await db
    .select()
    .from(courses)
    .where(inArray(courses.id, courseIds));
  const courseMap = new Map(courseRows.map((c) => [c.id, c]));

  // 2. Batch fetch ALL published lessons for all involved courses in ONE query.
  // CURRICULUM ORDERING: resume selection must be deterministic by
  // section.position then lesson.position (not insertion order). The single
  // bounded query joins course_sections purely to order by the section
  // position column — no per-enrollment or per-section fetch.
  const allPublishedLessons = (
    await db
      .select({ lesson: lessons })
      .from(lessons)
      .innerJoin(courseSections, eq(lessons.sectionId, courseSections.id))
      .where(
        and(
          inArray(lessons.courseId, courseIds),
          eq(lessons.status, "published")
        )
      )
      .orderBy(asc(courseSections.position), asc(lessons.position), asc(lessons.createdAt))
  ).map((row) => row.lesson);
  const lessonsByCourse = new Map<string, typeof allPublishedLessons>();
  for (const lesson of allPublishedLessons) {
    const bucket = lessonsByCourse.get(lesson.courseId);
    if (bucket) bucket.push(lesson);
    else lessonsByCourse.set(lesson.courseId, [lesson]);
  }

  // 3. Batch fetch ALL progress rows for all enrollments in ONE query
  const progressRows = await db
    .select()
    .from(lessonProgress)
    .where(inArray(lessonProgress.enrollmentId, enrollmentIds));
  const progressByEnrollment = new Map<string, typeof progressRows>();
  for (const row of progressRows) {
    const bucket = progressByEnrollment.get(row.enrollmentId);
    if (bucket) bucket.push(row);
    else progressByEnrollment.set(row.enrollmentId, [row]);
  }

  // 4. Batch fetch CURRENT enrollment states for reconciliation in ONE query
  const currentEnrollments = await db
    .select()
    .from(enrollments)
    .where(inArray(enrollments.id, enrollmentIds));
  const currentEnrollmentMap = new Map(currentEnrollments.map((e) => [e.id, e]));

  // 5. Compute summaries in memory
  const summaries = new Map<string, BatchedProgressSummary>();
  const reconciliations: Array<{ enrollmentId: string; completed: boolean }> = [];

  for (const enrollment of enrollmentsList) {
    const course = courseMap.get(enrollment.courseId);
    if (!course) continue; // Skip if course not found (should not happen)

    const publishedAll = lessonsByCourse.get(enrollment.courseId) ?? [];
    const enrollmentProgressRows = progressByEnrollment.get(enrollment.id) ?? [];
    const { totalRequired, completedRequired, percent, completed, completedLessonIds, resumeLesson } =
      computeCourseProgress(publishedAll, enrollmentProgressRows.map((r) => r.lessonId));

    const currentEnrollment = currentEnrollmentMap.get(enrollment.id);

    summaries.set(enrollment.id, {
      enrollmentId: enrollment.id,
      courseId: enrollment.courseId,
      courseTitle: course.title,
      courseSlug: course.slug,
      courseAccessMode: course.accessMode,
      courseStatus: course.status,
      totalRequired,
      completedRequired,
      percent,
      completed,
      totalPublished: publishedAll.length,
      completedLessonIds,
      resumeLessonId: resumeLesson?.id ?? null,
      resumeLessonSlug: resumeLesson?.slug ?? null,
      resumeLessonTitle: resumeLesson?.title ?? null,
      enrollmentStatus: currentEnrollment?.status ?? enrollment.status,
      enrollmentCompletedAt: currentEnrollment?.completedAt ?? enrollment.completedAt,
    });

    reconciliations.push({ enrollmentId: enrollment.id, completed });
  }

  // 6. Batch reconciliation writes (active ↔ completed only; cancelled is terminal)
  // Group by target status to minimize writes. Status is re-checked in the
  // WHERE so a concurrent cancellation is never overwritten.
  const toComplete: string[] = [];
  const toReopen: string[] = [];
  for (const { enrollmentId, completed } of reconciliations) {
    const current = currentEnrollmentMap.get(enrollmentId);
    if (!current) continue;
    if (current.status === "cancelled") continue;
    if (completed && current.status === "active") toComplete.push(enrollmentId);
    else if (!completed && current.status === "completed") toReopen.push(enrollmentId);
  }

  const now = new Date();
  if (toComplete.length > 0) {
    await db
      .update(enrollments)
      .set({ completedAt: now, status: "completed" })
      .where(and(inArray(enrollments.id, toComplete), eq(enrollments.status, "active")));
  }
  if (toReopen.length > 0) {
    await db
      .update(enrollments)
      .set({ completedAt: null, status: "active" })
      .where(and(inArray(enrollments.id, toReopen), eq(enrollments.status, "completed")));
  }

  // 7. Report POST-reconcile state. The conditional UPDATEs may have lost a
  // race (e.g. concurrent cancellation), so re-read just the touched rows in
  // ONE query rather than assuming they won.
  const touched = [...toComplete, ...toReopen];
  if (touched.length > 0) {
    const fresh = await db.select().from(enrollments).where(inArray(enrollments.id, touched));
    for (const row of fresh) {
      const summary = summaries.get(row.id);
      if (!summary) continue;
      summary.enrollmentStatus = row.status;
      summary.enrollmentCompletedAt = row.completedAt;
    }
  }

  return summaries;
}
