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
import { getD1Database, setD1DatabaseForTest, clearD1DatabaseForTest, disposeCloudflareBindings } from "../src/lib/cloudflare/bindings";
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
  getLessonContinuationHref,
  compareEnrollmentActivity,
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

test("CONTINUE: skip completed lessons, include optional lessons, wrap in curriculum order", () => {
  const course = { id: "course", slug: "course-slug" };
  const ls = ["a", "opt", "b", "c"].map((id) => ({
    ...lesson(id, id !== "opt"), courseId: course.id, slug: id, status: "published",
  })) as Lesson[];
  const target = (id: string, done: string[]) => getLessonContinuationHref(course, id, ls, done);
  assert.equal(target("a", ["a"]), "/learn/courses/course-slug/lessons/opt");
  assert.equal(target("a", ["a", "opt", "b"]), "/learn/courses/course-slug/lessons/c");
  assert.equal(target("c", ["c", "b"]), "/learn/courses/course-slug/lessons/a");
  assert.equal(target("c", ["a", "b", "c"]), "/learn/courses/course-slug/complete", "optional work never blocks completion");
  assert.equal(target("c", ["a", "opt", "b", "c"]), "/learn/courses/course-slug/complete");
  assert.throws(() => target("unknown", []), /not in this course/);
  const foreign = { ...ls[0], courseId: "other", id: "foreign" };
  assert.throws(() => getLessonContinuationHref(course, foreign.id, [...ls, foreign], []), /not in this course/);
  const draft = { ...ls[0], id: "draft", status: "draft" } as Lesson;
  assert.throws(() => getLessonContinuationHref(course, draft.id, [...ls, draft], []), /not in this course/);
  assert.equal(getLessonContinuationHref(course, "opt", [ls[1]], ["opt"]), "/learn/courses/course-slug", "zero required is not complete");
});

test("ACTIVITY: newest activity sorts first with a deterministic tie break", () => {
  const rows = [
    { enrollmentId: "old", lastActivityAt: new Date(1000) },
    { enrollmentId: "recent-b", lastActivityAt: new Date(2000) },
    { enrollmentId: "recent-a", lastActivityAt: new Date(2000) },
  ];
  assert.deepEqual(rows.sort(compareEnrollmentActivity).map((row) => row.enrollmentId), ["recent-a", "recent-b", "old"]);
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
    const freshSummary = (await getBatchedEnrollmentProgress([enrollment])).get(enrollment.id)!;
    assert.equal(freshSummary.lastActivityAt.getTime(), enrollment.enrolledAt.getTime());
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
    assert.equal(closed.lastActivityAt.getTime(), Math.floor(now.getTime() / 1000) * 1000);
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


test("ACTIVITY: batched rows pick latest completion with one read per table at any enrollment count", async () => {
  const db = await getDb();
  const course = await createCourse({ title: "Activity", slug: `activity-${stamp()}`, accessMode: "FREE" });
  const section = await createSection({ courseId: course.id, title: "S" });
  const ls = [];
  for (let i = 0; i < 3; i++) {
    const entry = await createLesson({ courseId: course.id, sectionId: section.id, title: `Lesson ${i}`, slug: `activity-${i}-${stamp()}`, required: true });
    await publishLesson(entry.id);
    ls.push(entry);
  }
  await publishCourse(course.id);
  const userIds: string[] = [];
  const memberships = [];
  try {
    for (let i = 0; i < 3; i++) {
      const id = `activity-${stamp()}`;
      userIds.push(id);
      await db.insert(users).values({ id, name: "Activity fixture", email: `${id}@example.test`, role: "user", emailVerified: false, createdAt: new Date(), updatedAt: new Date() });
      const membership = await enrollFree(id, course.id);
      await db.update(enrollments).set({ enrolledAt: new Date((i + 1) * 1000) }).where(eq(enrollments.id, membership.id));
      memberships.push(membership);
    }
    // Older enrollment's latest completion must outrank newer enrollment dates.
    for (const [i, time] of [10000, 5000].entries()) {
      await db.insert(lessonProgress).values({ id: `activity-${stamp()}`, enrollmentId: memberships[0].id, lessonId: ls[i].id, completedAt: new Date(time) });
    }
    const realD1 = await getD1Database();
    const reads: string[] = [];
    setD1DatabaseForTest({
      prepare(sql: string) { if (/^select/i.test(sql)) reads.push(sql); return realD1.prepare(sql); },
      batch: realD1.batch.bind(realD1),
    } as Parameters<typeof setD1DatabaseForTest>[0]);
    try {
      const summaries = [...(await getBatchedEnrollmentProgress(memberships)).values()];
      assert.equal(reads.length, 4, "courses, curriculum, progress, enrollment states: exactly four batched reads");
      assert.equal(reads.filter((sql) => /from "lesson_progress"/i.test(sql)).length, 1);
      assert.equal(summaries[0].lastActivityAt.getTime(), 10000, "max, not last row read");
      assert.equal(summaries[1].lastActivityAt.getTime(), 2000, "fallback uses current enrollment date");
      assert.deepEqual(summaries.sort(compareEnrollmentActivity).map((row) => row.enrollmentId), [memberships[0].id, memberships[2].id, memberships[1].id]);
      reads.length = 0;
      await getBatchedEnrollmentProgress([memberships[0]]);
      assert.equal(reads.length, 4, "query count does not grow with enrollments");
    } finally { clearD1DatabaseForTest(); }
  } finally {
    for (const membership of memberships) await db.delete(lessonProgress).where(eq(lessonProgress.enrollmentId, membership.id));
    await db.delete(enrollments).where(eq(enrollments.courseId, course.id));
    await db.delete(lessons).where(eq(lessons.courseId, course.id));
    await db.delete(courseSections).where(eq(courseSections.courseId, course.id));
    await db.delete(courses).where(eq(courses.id, course.id));
    for (const id of userIds) await db.delete(users).where(eq(users.id, id));
  }
});
