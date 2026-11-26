import { getDb } from "@/lib/db";
import {
  enrollments,
  lessonProgress,
  lessons,
  courses,
  courseSections,
  type Course,
  type CourseSection,
  type Enrollment,
  type Lesson,
} from "@/lib/db";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import {
  getAdminCourseById,
  getAdminLessonById,
  getCourseCurriculum,
} from "@/features/courses/service";
import { hasLearnerAccess } from "@/features/enrollments/access";
import {
  findSequentialBlocker,
  isLessonReleased,
  nextReleaseAt,
} from "@/features/courses/release";
import { assertManualLessonCompletionAllowed } from "@/features/quizzes/gate";
import { isUniqueConstraintError } from "@/lib/db/sqlite-errors";
import { AppError } from "@/lib/errors";

// Course-wide reconcile for admin curriculum edits lives in ./reconcile (no
// import cycle with the courses service); re-exported for one progress API.
export { reconcileCourseEnrollments } from "./reconcile";

// ============================================================================
// PROGRESS SERVICE (Mission 06)
// Server-authoritative. Progress percentage counts REQUIRED PUBLISHED lessons
// only; optional lessons never affect the denominator. Course completion =
// all required published lessons complete -> enrollment.completedAt set.
// Deterministic rule on curriculum change: the completion VERDICT is always
// computed from the current required-published set. READS (page renders) are
// pure and never write; the stored enrollment status is reconciled on WRITE
// paths only: markLessonComplete (one enrollment) and admin curriculum
// mutations (reconcileCourseEnrollments, see ./reconcile.ts).
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
  publishedLessons: Lesson[];
  /**
   * Batch J drip: earliest future release instant among incomplete lessons, or
   * null when nothing pending is scheduled. The course page shows "Next lesson
   * unlocks on <date>" when resumeLesson is null but this is set.
   */
  nextUnlockAt: Date | null;
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
 * lesson.position — resume selection is the first incomplete RELEASED lesson
 * in that order. Completions of unpublished/unknown lessons are ignored.
 * A course with zero required published lessons has nothing to complete:
 * percent 0, completed false.
 *
 * Batch J drip: `isReleased` marks lessons the learner may already open.
 * Locked REQUIRED lessons still count in totalRequired (a course can never
 * complete early), but resume skips them — the UI shows "Next lesson unlocks
 * on <date>" instead. Defaults to all released (pre-drip callers).
 */
export function computeCourseProgress(
  publishedLessons: Lesson[],
  completedLessonIds: Iterable<string>,
  isReleased?: (lesson: Lesson) => boolean,
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
  const released = isReleased ?? (() => true);
  const resumeLesson = required.find((l) => !completedSet.has(l.id) && released(l)) ?? null;

  return { totalRequired, completedRequired, percent, completed, completedLessonIds: completedIds, resumeLesson };
}

/**
 * Required completion ends the course, even when optional lessons remain.
 * Otherwise continue through ALL unfinished published lessons after the current
 * one, wrapping to earlier lessons. Inputs come only from server curriculum reads;
 * no client href is accepted. Reject a lesson outside this course before routing.
 * Batch J: `isReleased` (when given) skips drip-locked lessons so "Continue"
 * never lands on a locked lesson page.
 */
export function getLessonContinuationHref(
  course: { id: string; slug: string },
  currentLessonId: string,
  publishedLessons: Lesson[],
  completedLessonIds: Iterable<string>,
  isReleased?: (lesson: Lesson) => boolean,
): string {
  const ordered = publishedLessons.filter((lesson) => lesson.courseId === course.id && lesson.status === "published");
  const index = ordered.findIndex((lesson) => lesson.id === currentLessonId);
  if (index < 0) throw new AppError("invalid", "Lesson is not in this course curriculum.");
  const progress = computeCourseProgress(ordered, completedLessonIds, isReleased);
  const courseHref = `/learn/courses/${encodeURIComponent(course.slug)}`;
  if (progress.completed) return `${courseHref}/complete`;
  const completed = new Set(progress.completedLessonIds);
  const released = isReleased ?? (() => true);
  const next = [...ordered.slice(index + 1), ...ordered.slice(0, index)]
    .find((lesson) => !completed.has(lesson.id) && released(lesson));
  return next ? `${courseHref}/lessons/${encodeURIComponent(next.slug)}` : courseHref;
}

/**
 * Build the drip-release predicate for one enrollment from an already-loaded
 * curriculum. Pure over the given rows; admins never call this (they bypass).
 */
export function releasePredicateFor(
  sections: CourseSection[],
  enrolledAt: Date,
  now: Date = new Date(),
): (lesson: Lesson) => boolean {
  const sectionById = new Map(sections.map((s) => [s.id, s]));
  return (lesson: Lesson) =>
    isLessonReleased(sectionById.get(lesson.sectionId) ?? null, lesson, enrolledAt, now);
}

/**
 * Sequential-lock predicate for one enrollment. Pure over the given rows.
 * Inert when the course has `sequential` off; preview lessons are always
 * open. Drip and sequential combine: callers AND this with the drip
 * predicate so both must allow.
 */
export function sequentialPredicateFor(
  orderedPublishedLessons: Lesson[],
  completedLessonIds: Set<string> | Iterable<string>,
  sequential: boolean,
): (lesson: Lesson) => boolean {
  if (!sequential) return () => true;
  const done = completedLessonIds instanceof Set ? completedLessonIds : new Set(completedLessonIds);
  return (lesson: Lesson) =>
    findSequentialBlocker(orderedPublishedLessons, done, lesson.id) === null;
}

/** Drip AND sequential in one predicate (both must allow). */
export function availabilityPredicateFor(options: {
  sections: CourseSection[];
  enrolledAt: Date;
  orderedPublishedLessons: Lesson[];
  completedLessonIds: Set<string> | Iterable<string>;
  sequential: boolean;
  now?: Date;
}): (lesson: Lesson) => boolean {
  const drip = releasePredicateFor(options.sections, options.enrolledAt, options.now ?? new Date());
  const sequential = sequentialPredicateFor(
    options.orderedPublishedLessons,
    options.completedLessonIds,
    options.sequential,
  );
  return (lesson: Lesson) => drip(lesson) && sequential(lesson);
}

/**
 * First earlier required lesson still incomplete for this (course,
 * enrollment, lesson) triple, or null when sequential does not block.
 * Returns the blocker row so pages can link "the next lesson to take".
 * Null when the course has `sequential` off, the lesson is a preview, or
 * the caller lacks an active enrollment (previews/drip handle the rest).
 */
export async function getSequentialBlocker(options: {
  course: Pick<Course, "id" | "sequential">;
  enrollment: Enrollment;
  lesson: Pick<Lesson, "id" | "isPreview">;
}): Promise<Lesson | null> {
  if (!options.course.sequential) return null;
  if (options.lesson.isPreview) return null;
  const db = await getDb();
  const curriculum = await getCourseCurriculum(options.course.id);
  const ordered = curriculum.flatMap((c) => c.publishedLessons);
  const rows = await db
    .select({ lessonId: lessonProgress.lessonId })
    .from(lessonProgress)
    .where(eq(lessonProgress.enrollmentId, options.enrollment.id));
  const publishedIds = new Set(ordered.map((l) => l.id));
  const done = new Set(rows.map((r) => r.lessonId).filter((id) => publishedIds.has(id)));
  const blockerId = findSequentialBlocker(ordered, done, options.lesson.id);
  if (!blockerId) return null;
  return ordered.find((l) => l.id === blockerId) ?? null;
}

/** Server-owned action result: the same validated, idempotent write path. */
export async function completeLessonAndContinue(userId: string, enrollmentId: string, lessonId: string) {
  const result = await markLessonComplete(userId, enrollmentId, lessonId);
  const course = await getAdminCourseById(result.enrollment.courseId);
  if (!course) throw new AppError("not_found", "Course not found.");
  const curriculum = await getCourseCurriculum(course.id);
  // Drip AND sequential combine: "Continue" never lands on a locked lesson.
  const isAvailable = availabilityPredicateFor({
    sections: curriculum.map((c) => c.section),
    enrolledAt: result.enrollment.enrolledAt,
    orderedPublishedLessons: result.progress.publishedLessons,
    completedLessonIds: result.progress.completedLessonIds,
    sequential: course.sequential,
  });
  const nextHref = getLessonContinuationHref(course, lessonId, result.progress.publishedLessons, result.progress.completedLessonIds, isAvailable);
  return { ...result, course, nextHref };
}

export async function getEnrollmentProgress(enrollment: Enrollment, now: Date = new Date()): Promise<CourseProgress> {
  // Batch J: one curriculum read (sections + ALL lessons in 2 queries) which
  // doubles as the drip release-rule source — no extra release fetch.
  const curriculum = await getCourseCurriculum(enrollment.courseId);
  const publishedAll = curriculum.flatMap((c) => c.publishedLessons);

  const db = await getDb();
  const [course, rows] = await Promise.all([
    db.select().from(courses).where(eq(courses.id, enrollment.courseId)).get(),
    db.select().from(lessonProgress).where(eq(lessonProgress.enrollmentId, enrollment.id)),
  ]);
  // Drip AND sequential combine: resume skips lessons locked by either gate.
  // Locked REQUIRED lessons still count in totalRequired (a course can never
  // complete early). Completed ids are filtered to published lessons first so
  // the sequential order check sees the same set as the progress maths.
  const publishedIds = new Set(publishedAll.map((l) => l.id));
  const completedIds = new Set(rows.map((r) => r.lessonId).filter((id) => publishedIds.has(id)));
  const isAvailable = availabilityPredicateFor({
    sections: curriculum.map((c) => c.section),
    enrolledAt: enrollment.enrolledAt,
    orderedPublishedLessons: publishedAll,
    completedLessonIds: completedIds,
    sequential: course?.sequential ?? false,
    now,
  });

  const { totalRequired, completedRequired, percent, completed, completedLessonIds, resumeLesson } =
    computeCourseProgress(publishedAll, completedIds, isAvailable);

  const completedSet = new Set(completedLessonIds);
  const sectionById = new Map(curriculum.map((c) => [c.section.id, c.section]));
  const nextUnlockAt = nextReleaseAt(
    publishedAll.map((l) => ({ id: l.id, section: sectionById.get(l.sectionId) ?? null, lesson: l })),
    enrollment.enrolledAt,
    completedSet,
    now,
  );

  const nextAfterLessonId: Record<string, Lesson | null> = {};
  for (let i = 0; i < publishedAll.length; i++) {
    nextAfterLessonId[publishedAll[i].id] = publishedAll[i + 1] ?? null;
  }

  // PURE READ: no enrollment write here. `completed` is the freshly computed
  // verdict and is what the UI must show ("Course complete"); the stored
  // enrollment.status is reconciled on write paths (markLessonComplete and
  // admin curriculum edits), so it only lags the verdict during a race.
  return {
    totalRequired,
    completedRequired,
    percent,
    completed,
    totalPublished: publishedAll.length,
    completedLessonIds,
    resumeLesson,
    nextUnlockAt,
    nextAfterLessonId,
    publishedLessons: publishedAll,
  };
}

/**
 * Bring ONE enrollment's status/completedAt in line with the recomputed
 * completion verdict. No-op when already consistent. WRITE PATHS ONLY (called
 * from markLessonComplete); page reads must never call it. Exported for tests.
 * Course-wide equivalent for curriculum edits: reconcileCourseEnrollments.
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
  // DRIP (Batch J): a locked lesson refuses completion — it still counts in
  // totalRequired, so the course cannot complete early.
  const lessonSection = await db
    .select()
    .from(courseSections)
    .where(eq(courseSections.id, lesson.sectionId))
    .get();
  if (!isLessonReleased(lessonSection ?? null, lesson, enrollment.enrolledAt)) {
    throw new AppError("forbidden", "This lesson has not unlocked yet.");
  }
  // SEQUENTIAL (learner polish): a lesson locked behind earlier required
  // lessons refuses completion too. Previews stay completable in any order.
  const completedCourse = await getAdminCourseById(lesson.courseId);
  if (completedCourse?.sequential) {
    const blocker = await getSequentialBlocker({ course: completedCourse, enrollment, lesson });
    if (blocker) {
      throw new AppError("forbidden", "Finish the previous lesson to unlock this one.");
    }
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
    // QUIZ GATE: a lesson whose quiz has requirePass=true can only be completed
    // through a passed attempt. Existing completions are never re-checked, so
    // quizzes added later do NOT retroactively un-complete anyone.
    await assertManualLessonCompletionAllowed(enrollment.id, lesson.id);
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

  // WRITE PATH: compute the verdict with the shared read, then reconcile this
  // enrollment's stored status from it (reads themselves no longer write).
  const progress = await getEnrollmentProgress(enrollment);
  await reconcileEnrollmentCompletion(enrollment, progress.completed);

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
// progress rows for all enrollments, current stored enrollment states.
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
  /** Batch J: earliest future unlock among incomplete lessons (null if none). */
  nextUnlockAt: Date | null;
  enrollmentStatus: string;
  enrollmentCompletedAt: Date | null;
  /** Latest recorded lesson completion, falling back to the enrollment date. */
  lastActivityAt: Date;
}

/**
 * Compute progress summaries for multiple enrollments in a bounded number of queries.
 * Returns a map keyed by enrollmentId for O(1) lookups by the caller.
 * PURE READ: never writes. `completed` is the computed verdict (UI source of
 * truth); `enrollmentStatus` is the stored row, reconciled on write paths.
 * Activity uses timestamps from the same progress rows: one query per table,
 * with no activity query or per-enrollment reads.
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

  // 2. Batch fetch ALL sections + published lessons for all involved courses
  // in ONE query (sections carry the Batch J release rules; the join below
  // preserves section.position ordering — no per-enrollment fetch). The
  // section repeats on every lesson row; it is deduped into maps in memory.
  const sectionAndLessons = await db
    .select({ lesson: lessons, section: courseSections })
    .from(lessons)
    .innerJoin(courseSections, eq(lessons.sectionId, courseSections.id))
    .where(
      and(
        inArray(lessons.courseId, courseIds),
        eq(lessons.status, "published"),
        isNull(lessons.trashedAt)
      )
    )
    .orderBy(asc(courseSections.position), asc(lessons.position), asc(lessons.createdAt));
  const allPublishedLessons = sectionAndLessons.map((row) => row.lesson);
  const sectionsByCourse = new Map<string, CourseSection[]>();
  const sectionById = new Map<string, CourseSection>();
  for (const { section } of sectionAndLessons) {
    if (!sectionById.has(section.id)) {
      sectionById.set(section.id, section);
      const bucket = sectionsByCourse.get(section.courseId);
      if (bucket) bucket.push(section);
      else sectionsByCourse.set(section.courseId, [section]);
    }
  }
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

  // 4. Batch fetch CURRENT stored enrollment states (reported as-is) in ONE query
  const currentEnrollments = await db
    .select()
    .from(enrollments)
    .where(inArray(enrollments.id, enrollmentIds));
  const currentEnrollmentMap = new Map(currentEnrollments.map((e) => [e.id, e]));

  // 5. Compute summaries in memory (Batch J: drip-aware resume per enrollment)
  const summaries = new Map<string, BatchedProgressSummary>();

  for (const enrollment of enrollmentsList) {
    const course = courseMap.get(enrollment.courseId);
    if (!course) continue; // Skip if course not found (should not happen)

    const publishedAll = lessonsByCourse.get(enrollment.courseId) ?? [];
    const enrollmentProgressRows = progressByEnrollment.get(enrollment.id) ?? [];
    const publishedIds = new Set(publishedAll.map((l) => l.id));
    const completedIds = new Set(
      enrollmentProgressRows.map((r) => r.lessonId).filter((id) => publishedIds.has(id)),
    );
    // Drip AND sequential combine (same rule as the single-enrollment read).
    const isAvailable = availabilityPredicateFor({
      sections: sectionsByCourse.get(enrollment.courseId) ?? [],
      enrolledAt: enrollment.enrolledAt,
      orderedPublishedLessons: publishedAll,
      completedLessonIds: completedIds,
      sequential: course.sequential,
    });
    const { totalRequired, completedRequired, percent, completed, completedLessonIds, resumeLesson } =
      computeCourseProgress(publishedAll, completedIds, isAvailable);
    const completedSet = new Set(completedLessonIds);

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
      nextUnlockAt: nextReleaseAt(
        publishedAll.map((l) => ({ id: l.id, section: sectionById.get(l.sectionId) ?? null, lesson: l })),
        enrollment.enrolledAt,
        completedSet,
      ),
      lastActivityAt: enrollmentProgressRows.length
        ? new Date(enrollmentProgressRows.reduce((latest, row) => Math.max(latest, row.completedAt.getTime()), 0))
        : (currentEnrollment ?? enrollment).enrolledAt,
      enrollmentStatus: currentEnrollment?.status ?? enrollment.status,
      enrollmentCompletedAt: currentEnrollment?.completedAt ?? enrollment.completedAt,
    });

  }

  return summaries;
}

/** Shared dashboard order: newest activity first; stable enrollment id breaks ties. */
export function compareEnrollmentActivity(
  a: Pick<BatchedProgressSummary, "lastActivityAt" | "enrollmentId">,
  b: Pick<BatchedProgressSummary, "lastActivityAt" | "enrollmentId">,
): number {
  return b.lastActivityAt.getTime() - a.lastActivityAt.getTime() || a.enrollmentId.localeCompare(b.enrollmentId);
}
