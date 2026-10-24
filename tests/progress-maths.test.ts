/**
 * PROGRESS MATHS REGRESSIONS
 * ---------------------------------------------------------------------------
 * - PURE: computeCourseProgress is the single source of the percent /
 *   completed / resume maths (required-only denominator, ordered resume,
 *   unpublished completions ignored, zero-required => 0% and NOT completed).
 * - BATCHED: the call that flips active<->completed reports the NEW status.
 *
 * Runs through tsx via `npm test` (no Playwright).
 */
import test from "node:test";
import assert from "node:assert/strict";
import "./helpers/env"; // MUST be first: fake TEST-ONLY secret before any app module.

import {
  getDb,
  users,
  courses,
  courseSections,
  lessons,
  enrollments,
  lessonProgress,
  type Lesson,
} from "../src/lib/db";
import { migrateLocalDb } from "../src/lib/db/migrate";
import { disposeCloudflareBindings } from "../src/lib/cloudflare/bindings";
import {
  createCourse,
  createSection,
  createLesson,
  publishLesson,
  publishCourse,
} from "../src/features/courses/service";
import { enrollFree } from "../src/features/enrollments/service";
import {
  computeCourseProgress,
  getBatchedEnrollmentProgress,
} from "../src/features/progress/service";
import { eq } from "drizzle-orm";

test.before(async () => {
  await migrateLocalDb();
});

test.after(async () => {
  await disposeCloudflareBindings();
});

const stamp = () => Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);

const lesson = (id: string, required: boolean) => ({ id, required }) as unknown as Lesson;

// ---------------------------------------------------------------- pure

test("PURE: mixed required/optional counts required only", () => {
  const ls = [lesson("a", true), lesson("opt", false), lesson("b", true)];
  const p = computeCourseProgress(ls, ["opt", "a"]);
  assert.equal(p.totalRequired, 2);
  assert.equal(p.completedRequired, 1);
  assert.equal(p.percent, 50);
  assert.equal(p.completed, false);
  assert.deepEqual(p.completedLessonIds, ["opt", "a"]);
  assert.equal(p.resumeLesson?.id, "b");
});

test("PURE: zero required lessons is 0% and not completed", () => {
  for (const ls of [[], [lesson("opt", false)]]) {
    const p = computeCourseProgress(ls, ["opt"]);
    assert.equal(p.totalRequired, 0);
    assert.equal(p.percent, 0);
    assert.equal(p.completed, false);
    assert.equal(p.resumeLesson, null);
  }
});

test("PURE: all required complete", () => {
  const p = computeCourseProgress([lesson("a", true), lesson("b", true)], ["b", "a"]);
  assert.equal(p.percent, 100);
  assert.equal(p.completed, true);
  assert.equal(p.resumeLesson, null);
});

test("PURE: resume is the first incomplete required lesson in curriculum order", () => {
  const ls = [lesson("a", true), lesson("opt", false), lesson("b", true), lesson("c", true)];
  // Completion order is irrelevant; curriculum order decides.
  assert.equal(computeCourseProgress(ls, ["c", "a"]).resumeLesson?.id, "b");
  assert.equal(computeCourseProgress(ls, []).resumeLesson?.id, "a");
});

test("PURE: completions of unpublished lessons are ignored", () => {
  const p = computeCourseProgress([lesson("a", true)], ["ghost", "a"]);
  assert.deepEqual(p.completedLessonIds, ["a"]);
  assert.equal(p.completedRequired, 1);
  const none = computeCourseProgress([lesson("a", true)], ["ghost"]);
  assert.equal(none.completedRequired, 0);
  assert.equal(none.percent, 0);
});

// ---------------------------------------------------------------- batched

test("BATCHED: reads report the computed verdict and never write the enrollment row", async () => {
  const db = await getDb();
  const course = await createCourse({ title: "Maths Course", slug: `pm-${stamp()}`, accessMode: "FREE" });
  const section = await createSection({ courseId: course.id, title: "S1" });
  const only = await createLesson({
    courseId: course.id,
    sectionId: section.id,
    title: "Only",
    slug: `only-${stamp()}`,
    required: true,
  });
  await publishLesson(only.id);
  await publishCourse(course.id);

  const userId = `u_test_${stamp()}`;
  const now = new Date();
  await db.insert(users).values({
    id: userId,
    name: "Maths Learner",
    email: `pm-${stamp()}@example.com`,
    emailVerified: false,
    createdAt: now,
    updatedAt: now,
    role: "user",
  });
  const enrollment = await enrollFree(userId, course.id);

  try {
    // Active but the required set is satisfied: the batched READ reports the
    // computed verdict (completed) but must NOT write — the stored row stays
    // active until a write path reconciles it. (Previously this read closed it.)
    await db.insert(lessonProgress).values({
      id: `prog_${stamp()}`,
      enrollmentId: enrollment.id,
      lessonId: only.id,
      completedAt: now,
    });
    const closed = (await getBatchedEnrollmentProgress([enrollment])).get(enrollment.id)!;
    assert.equal(closed.completed, true);
    assert.equal(closed.enrollmentStatus, "active");
    assert.equal(closed.enrollmentCompletedAt, null);
    const stored = await db.select().from(enrollments).where(eq(enrollments.id, enrollment.id)).get();
    assert.equal(stored?.status, "active");

    // Stored "completed" but the set is no longer satisfied: the read reports
    // completed=false from the maths and still does not rewrite the row.
    await db.delete(lessonProgress).where(eq(lessonProgress.enrollmentId, enrollment.id));
    await db.update(enrollments).set({ status: "completed", completedAt: now }).where(eq(enrollments.id, enrollment.id));
    const fresh = await db.select().from(enrollments).where(eq(enrollments.id, enrollment.id)).get();
    const reopened = (await getBatchedEnrollmentProgress([fresh!])).get(enrollment.id)!;
    assert.equal(reopened.completed, false);
    assert.equal(reopened.enrollmentStatus, "completed");
  } finally {
    await db.delete(lessonProgress).where(eq(lessonProgress.enrollmentId, enrollment.id));
    await db.delete(enrollments).where(eq(enrollments.courseId, course.id));
    await db.delete(lessons).where(eq(lessons.courseId, course.id));
    await db.delete(courseSections).where(eq(courseSections.courseId, course.id));
    await db.delete(courses).where(eq(courses.id, course.id));
    await db.delete(users).where(eq(users.id, userId));
  }
});
