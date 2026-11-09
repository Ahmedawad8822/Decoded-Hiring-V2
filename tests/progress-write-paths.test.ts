/**
 * PROGRESS WRITE-PATH REGRESSIONS
 * ---------------------------------------------------------------------------
 * - READS ARE PURE: getEnrollmentProgress / getBatchedEnrollmentProgress never
 *   UPDATE enrollments (counted at the D1 prepare() seam, and row compare).
 * - CURRICULUM WRITES RECONCILE: unpublishing the last incomplete required
 *   lesson closes enrollments; publishing a new required lesson reopens them;
 *   toggling `required` does the same. Cancelled enrollments are never touched.
 * - ARCHIVED LESSONS ARE TERMINAL: publishLesson rejects them.
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
} from "../src/lib/db";
import { migrateLocalDb } from "../src/lib/db/migrate";
import {
  disposeCloudflareBindings,
  getD1Database,
  setD1DatabaseForTest,
  clearD1DatabaseForTest,
} from "../src/lib/cloudflare/bindings";
import {
  createCourse,
  createSection,
  createLesson,
  updateLesson,
  publishLesson,
  unpublishLesson,
  publishCourse,
} from "../src/features/courses/service";
import { enrollFree } from "../src/features/enrollments/service";
import {
  getEnrollmentProgress,
  getBatchedEnrollmentProgress,
  markLessonComplete,
  completeLessonAndContinue,
} from "../src/features/progress/service";
import { eq } from "drizzle-orm";

test.before(async () => {
  await migrateLocalDb();
});

test.after(async () => {
  await disposeCloudflareBindings();
});

const stamp = () => Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);

async function makeUser(): Promise<string> {
  const db = await getDb();
  const id = `u_test_${stamp()}`;
  const now = new Date();
  await db.insert(users).values({
    id,
    name: "Write Path Learner",
    email: `wp-${stamp()}@example.com`,
    emailVerified: false,
    createdAt: now,
    updatedAt: now,
    role: "user",
  });
  return id;
}

async function makeCourse() {
  const course = await createCourse({ title: "Write Paths", slug: `wp-${stamp()}`, accessMode: "FREE" });
  const section = await createSection({ courseId: course.id, title: "S1" });
  const mk = async (title: string, required: boolean) => {
    const l = await createLesson({
      courseId: course.id,
      sectionId: section.id,
      title,
      slug: `${title.toLowerCase()}-${stamp()}`,
      required,
    });
    await publishLesson(l.id);
    return l;
  };
  const a = await mk("A", true);
  const b = await mk("B", true);
  await publishCourse(course.id);
  return { course, section, a, b, mk };
}

async function cleanup(courseId: string, userIds: string[]) {
  const db = await getDb();
  const rows = await db.select().from(enrollments).where(eq(enrollments.courseId, courseId));
  for (const e of rows) await db.delete(lessonProgress).where(eq(lessonProgress.enrollmentId, e.id));
  await db.delete(enrollments).where(eq(enrollments.courseId, courseId));
  await db.delete(lessons).where(eq(lessons.courseId, courseId));
  await db.delete(courseSections).where(eq(courseSections.courseId, courseId));
  await db.delete(courses).where(eq(courses.id, courseId));
  for (const id of userIds) await db.delete(users).where(eq(users.id, id));
}

async function status(enrollmentId: string) {
  const db = await getDb();
  return (await db.select().from(enrollments).where(eq(enrollments.id, enrollmentId)).get())!;
}

test("READS: progress reads issue no UPDATE and leave stale rows untouched", async () => {
  const { course, a, b } = await makeCourse();
  const userId = await makeUser();
  const enrollment = await enrollFree(userId, course.id);
  try {
    const db = await getDb();
    await markLessonComplete(userId, enrollment.id, a.id);
    await markLessonComplete(userId, enrollment.id, b.id);
    assert.equal((await status(enrollment.id)).status, "completed");

    // Force a STALE stored row (active) while the maths says completed, and
    // the reverse for a second check: reads must report the verdict only.
    await db.update(enrollments).set({ status: "active", completedAt: null }).where(eq(enrollments.id, enrollment.id));
    const stale = await status(enrollment.id);

    // Spy at the D1 seam: count any statement that writes to enrollments.
    const realD1 = await getD1Database();
    const writes: string[] = [];
    setD1DatabaseForTest({
      prepare: (sql: string) => {
        if (/^\s*(update|insert|delete)\b[^;]*\benrollments\b/i.test(sql)) writes.push(sql);
        return realD1.prepare(sql);
      },
      batch: realD1.batch.bind(realD1),
    } as unknown as Parameters<typeof setD1DatabaseForTest>[0]);
    try {
      const single = await getEnrollmentProgress(stale);
      const batched = (await getBatchedEnrollmentProgress([stale])).get(enrollment.id)!;
      assert.equal(single.completed, true, "computed verdict reported");
      assert.equal(batched.completed, true, "computed verdict reported (batched)");
      assert.equal(batched.enrollmentStatus, "active", "stored status reported as-is");
    } finally {
      clearD1DatabaseForTest();
    }
    assert.deepEqual(writes, [], "page-render reads must not write enrollments");
    assert.equal((await status(enrollment.id)).status, "active", "row untouched by reads");
  } finally {
    await cleanup(course.id, [userId]);
  }
});

test("WRITES: unpublishing the last incomplete required lesson closes enrollments", async () => {
  const { course, a, b } = await makeCourse();
  const u1 = await makeUser();
  const u2 = await makeUser();
  const e1 = await enrollFree(u1, course.id);
  const e2 = await enrollFree(u2, course.id);
  try {
    await markLessonComplete(u1, e1.id, a.id); // u1 finished A only
    assert.equal((await status(e1.id)).status, "active");
    assert.equal((await status(e2.id)).status, "active"); // u2 has nothing

    await unpublishLesson(b.id); // required set is now {A}
    const r1 = await status(e1.id);
    assert.equal(r1.status, "completed");
    assert.ok(r1.completedAt);
    assert.equal((await status(e2.id)).status, "active", "learner without A stays active");
  } finally {
    await cleanup(course.id, [u1, u2]);
  }
});

test("WRITES: publishing a new required lesson reopens completed enrollments", async () => {
  const { course, a, b, mk } = await makeCourse();
  const userId = await makeUser();
  const enrollment = await enrollFree(userId, course.id);
  try {
    await markLessonComplete(userId, enrollment.id, a.id);
    await markLessonComplete(userId, enrollment.id, b.id);
    assert.equal((await status(enrollment.id)).status, "completed");

    // An OPTIONAL lesson does not change the verdict.
    await mk("Opt", false);
    assert.equal((await status(enrollment.id)).status, "completed");

    await mk("C", true);
    const reopened = await status(enrollment.id);
    assert.equal(reopened.status, "active");
    assert.equal(reopened.completedAt, null);
  } finally {
    await cleanup(course.id, [userId]);
  }
});

test("WRITES: toggling `required` reconciles; other edits do not need to", async () => {
  const { course, a, b } = await makeCourse();
  const userId = await makeUser();
  const enrollment = await enrollFree(userId, course.id);
  try {
    await markLessonComplete(userId, enrollment.id, a.id);
    assert.equal((await status(enrollment.id)).status, "active");

    await updateLesson(b.id, { id: b.id, required: false }); // required set is now {A}
    assert.equal((await status(enrollment.id)).status, "completed");

    await updateLesson(b.id, { id: b.id, required: true }); // grows back
    assert.equal((await status(enrollment.id)).status, "active");
  } finally {
    await cleanup(course.id, [userId]);
  }
});

test("WRITES: cancelled enrollments are never touched by curriculum reconcile", async () => {
  const { course, a, b, mk } = await makeCourse();
  const userId = await makeUser();
  const enrollment = await enrollFree(userId, course.id);
  try {
    const db = await getDb();
    await markLessonComplete(userId, enrollment.id, a.id);
    await db.update(enrollments).set({ status: "cancelled" }).where(eq(enrollments.id, enrollment.id));

    await unpublishLesson(b.id); // would close an active enrollment
    assert.equal((await status(enrollment.id)).status, "cancelled");
    await mk("D", true); // would reopen a completed one
    assert.equal((await status(enrollment.id)).status, "cancelled");
    assert.equal((await status(enrollment.id)).completedAt, null);
  } finally {
    await cleanup(course.id, [userId]);
  }
});

test("WRITES: reconcile is a bounded number of statements regardless of enrollment count", async () => {
  const { course, a, b } = await makeCourse();
  const users3 = [await makeUser(), await makeUser(), await makeUser()];
  try {
    for (const u of users3) {
      const e = await enrollFree(u, course.id);
      await markLessonComplete(u, e.id, a.id);
    }
    const realD1 = await getD1Database();
    let enrollmentUpdates = 0;
    setD1DatabaseForTest({
      prepare: (sql: string) => {
        if (/^\s*update\s+["'`]?enrollments/i.test(sql)) enrollmentUpdates++;
        return realD1.prepare(sql);
      },
      batch: realD1.batch.bind(realD1),
    } as unknown as Parameters<typeof setD1DatabaseForTest>[0]);
    try {
      await unpublishLesson(b.id);
    } finally {
      clearD1DatabaseForTest();
    }
    assert.ok(enrollmentUpdates <= 2, `expected <= 2 UPDATEs, saw ${enrollmentUpdates}`);
    const db = await getDb();
    const rows = await db.select().from(enrollments).where(eq(enrollments.courseId, course.id));
    assert.ok(rows.every((r) => r.status === "completed"));
  } finally {
    await cleanup(course.id, users3);
  }
});

test("LESSONS: an archived lesson cannot be published", async () => {
  const { course, section } = await makeCourse();
  try {
    const db = await getDb();
    const l = await createLesson({
      courseId: course.id,
      sectionId: section.id,
      title: "Arch",
      slug: `arch-${stamp()}`,
      required: true,
    });
    await db.update(lessons).set({ status: "archived" }).where(eq(lessons.id, l.id));
    await assert.rejects(
      () => publishLesson(l.id),
      (err: unknown) => (err as { kind?: string }).kind === "invalid" && /archived/i.test((err as Error).message)
    );
    const after = await db.select().from(lessons).where(eq(lessons.id, l.id)).get();
    assert.equal(after?.status, "archived");
  } finally {
    await cleanup(course.id, []);
  }
});


test("CONTINUE: action domain target is server-owned, idempotent, and rejects foreign or cancelled enrollment", async () => {
  const { course, a, b } = await makeCourse();
  const userId = await makeUser();
  const stranger = await makeUser();
  const enrollment = await enrollFree(userId, course.id);
  const other = await makeCourse();
  try {
    const first = await completeLessonAndContinue(userId, enrollment.id, a.id);
    assert.equal(first.nextHref, `/learn/courses/${course.slug}/lessons/${b.slug}`);
    assert.equal(first.alreadyComplete, false);
    const repeated = await completeLessonAndContinue(userId, enrollment.id, a.id);
    assert.equal(repeated.nextHref, first.nextHref);
    assert.equal(repeated.alreadyComplete, true);
    await assert.rejects(() => completeLessonAndContinue(stranger, enrollment.id, a.id), /another learner/);
    await assert.rejects(() => completeLessonAndContinue(userId, enrollment.id, other.a.id), /does not belong/);
    const finish = await completeLessonAndContinue(userId, enrollment.id, b.id);
    assert.equal(finish.nextHref, `/learn/courses/${course.slug}/complete`);
    assert.ok(finish.enrollment.completedAt);
    const db = await getDb();
    await db.update(enrollments).set({ status: "cancelled" }).where(eq(enrollments.id, enrollment.id));
    await assert.rejects(() => completeLessonAndContinue(userId, enrollment.id, b.id), /no longer active/);
  } finally {
    await cleanup(course.id, [userId, stranger]);
    await cleanup(other.course.id, []);
  }
});

test("COMPLETION: enrollment gate denies strangers/cancelled, rejects incomplete, allows computed complete", async () => {
  const { getCourseCompletionState } = await import("../src/features/progress/completion");
  const { course, a, b } = await makeCourse();
  const userId = await makeUser();
  try {
    assert.equal((await getCourseCompletionState(userId, course.slug)).kind, "enrollment_required");
    const enrollment = await enrollFree(userId, course.id);
    assert.equal((await getCourseCompletionState(userId, course.slug)).kind, "incomplete");
    await markLessonComplete(userId, enrollment.id, a.id);
    assert.equal((await getCourseCompletionState(userId, course.slug)).kind, "incomplete");
    await markLessonComplete(userId, enrollment.id, b.id);
    const complete = await getCourseCompletionState(userId, course.slug);
    assert.equal(complete.kind, "complete");
    if (complete.kind !== "complete") assert.fail("expected completed course");
    assert.ok(complete.enrollment.completedAt);
    assert.equal(complete.progress.completedRequired, 2);
    const db = await getDb();
    await db.update(enrollments).set({ status: "cancelled" }).where(eq(enrollments.id, enrollment.id));
    assert.equal((await getCourseCompletionState(userId, course.slug)).kind, "enrollment_required");
    assert.equal((await status(enrollment.id)).status, "cancelled", "completion reads must not reactivate enrollment");
    assert.equal((await getCourseCompletionState(userId, `missing-${stamp()}`)).kind, "not_found");
  } finally { await cleanup(course.id, [userId]); }
});
