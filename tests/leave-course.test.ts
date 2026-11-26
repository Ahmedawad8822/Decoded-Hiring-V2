/**
 * LEAVE-A-COURSE (ENROLLMENT CANCELLATION) TESTS
 * ---------------------------------------------------------------------------
 * - signed-out leave is refused;
 * - leaving is scoped to the caller (another learner's enrollment is safe);
 * - cancel is idempotent (second leave is ok, no second write);
 * - leaving keeps progress, quiz attempts, notes and certificate rows;
 * - already-issued certificates stay valid and verifiable after leaving;
 * - access gates refuse lessons/notes/claims while cancelled;
 * - /learn dashboard excludes cancelled enrollments;
 * - re-enroll restores `completed` (with a completion date) when all required
 *   work was done, and `active` otherwise;
 * - cancelledAt is set on leave and cleared on re-enroll.
 *
 * Runs through tsx via `npm test` (no Playwright).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { eq } from "drizzle-orm";
import "./helpers/env"; // MUST be first: fake TEST-ONLY secret before any app module.
import { markEmailVerified } from "./helpers/verified";

import {
  getDb,
  lessonNotes,
  lessonProgress,
  quizAttempts,
} from "../src/lib/db";
import { migrateLocalDb } from "../src/lib/db/migrate";
import { disposeCloudflareBindings } from "../src/lib/cloudflare/bindings";
import { getAuth } from "../src/lib/auth";
import {
  createCourse,
  createLesson,
  createSection,
  publishCourse,
  publishLesson,
} from "../src/features/courses/service";
import {
  cancelMyEnrollment,
  enrollFree,
  getAccessibleEnrollments,
  getEnrollment,
  requireEnrollment,
} from "../src/features/enrollments/service";
import { hasLearnerAccess } from "../src/features/enrollments/access";
import {
  getEnrollmentProgress,
  markLessonComplete,
} from "../src/features/progress/service";
import { getCourseCompletionState } from "../src/features/progress/completion";
import { saveMyLessonNote, getMyLessonNote } from "../src/features/notes/service";
import { submitQuizAttempt, upsertLessonQuiz } from "../src/features/quizzes/service";
import {
  claimCertificate,
  getLearnerCertificate,
  getPublicCertificate,
  listLearnerCertificates,
} from "../src/features/certificates/service";

const nodeRequire = createRequire(__filename);
const uid = () => crypto.randomUUID().slice(0, 10);
let cookieHeader = "";
let learnerACookie = "";
let learnerA = "";
let actions: typeof import("../src/features/enrollments/actions");

function stubModule(id: string, exports: Record<string, unknown>) {
  const resolved = nodeRequire.resolve(id);
  nodeRequire.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports,
    children: [],
    paths: [],
  } as unknown as NodeJS.Module;
}

async function account(): Promise<{ id: string; cookie: string }> {
  const auth = await getAuth();
  const email = `leave-${uid()}@example.test`;
  const password = `Fixture-${crypto.randomUUID()}`;
  const created = await auth.api.signUpEmail({ body: { email, password, name: "Leave Learner" } });
  await markEmailVerified(created.user.id);
  const signIn = await auth.api.signInEmail({
    body: { email, password },
    returnHeaders: true,
  });
  return {
    id: created.user.id,
    cookie: signIn.headers.getSetCookie().map((value) => value.split(";")[0]).join("; "),
  };
}

test.before(async () => {
  await migrateLocalDb();
  stubModule("next/headers", { headers: async () => new Headers({ cookie: cookieHeader }) });
  stubModule("next/cache", { revalidatePath: () => {} });
  const a = await account();
  learnerA = a.id;
  learnerACookie = a.cookie;
  cookieHeader = a.cookie;
  actions = await import("../src/features/enrollments/actions");
});

test.after(async () => {
  await disposeCloudflareBindings();
});

async function makeCourse(options: { lessonCount?: number; certificate?: boolean } = {}) {
  const count = options.lessonCount ?? 2;
  const course = await createCourse({
    title: "Leave course",
    slug: `leave-course-${uid()}`,
    certificateEnabled: options.certificate ?? false,
  });
  const section = await createSection({ courseId: course.id, title: "Leave section" });
  const lessonIds: string[] = [];
  const lessonSlugs: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const slug = `leave-lesson-${uid()}`;
    const lesson = await createLesson({
      courseId: course.id,
      sectionId: section.id,
      title: `Leave lesson ${index + 1}`,
      slug,
      required: true,
    });
    await publishLesson(lesson.id);
    lessonIds.push(lesson.id);
    lessonSlugs.push(slug);
  }
  await publishCourse(course.id);
  return { course, lessonIds, lessonSlugs };
}

// ---------------------------------------------------------------- action gate

test("signed-out learners are refused by the leave action", async () => {
  const { course } = await makeCourse();
  cookieHeader = "";
  const result = await actions.leaveCourseAction({ courseSlug: course.slug });
  assert.equal(result.ok, false, "signed-out leave is refused");
  assert.match(result.error ?? "", /Unauthorized/i);
  cookieHeader = learnerACookie;
});

test("leaving is scoped to the caller: another learner's enrollment is untouched", async () => {
  const { course } = await makeCourse();
  const enrollmentA = await enrollFree(learnerA, course.id);

  // Learner B is signed in but has no enrollment of their own here: the
  // action resolves the course by slug and scopes the write to B's row, so
  // it must fail and A's enrollment must stay active.
  const b = await account();
  cookieHeader = b.cookie;
  const result = await actions.leaveCourseAction({ courseSlug: course.slug });
  assert.equal(result.ok, false, "leaving without an enrollment fails");
  cookieHeader = learnerACookie;

  const after = await getEnrollment(learnerA, course.id);
  assert.equal(after?.status, "active", "A's enrollment is untouched");
  assert.equal(after?.id, enrollmentA.id);
  assert.ok(hasLearnerAccess(after));
});

// ---------------------------------------------------------------- idempotency

test("leaving sets cancelled + cancelledAt and a second leave is a no-op", async () => {
  const { course } = await makeCourse();
  await enrollFree(learnerA, course.id);

  const first = await cancelMyEnrollment(learnerA, course.id);
  assert.equal(first.status, "cancelled");
  assert.ok(first.cancelledAt instanceof Date, "cancelledAt is recorded");
  assert.equal(hasLearnerAccess(first), false);

  const second = await cancelMyEnrollment(learnerA, course.id);
  assert.equal(second.status, "cancelled");
  assert.equal(
    second.cancelledAt?.getTime(),
    first.cancelledAt?.getTime(),
    "second leave performs no write",
  );
});

// ---------------------------------------------------------------- record kept

test("leaving keeps progress, quiz attempts, notes and certificate rows; the certificate still verifies", async () => {
  const { course, lessonIds, lessonSlugs } = await makeCourse({ certificate: true });
  const enrollment = await enrollFree(learnerA, course.id);

  // Quiz with no pass requirement: the attempt row is kept as evidence only.
  await upsertLessonQuiz({
    lessonId: lessonIds[0],
    passPercent: 70,
    requirePass: false,
    questions: [
      {
        id: "leave-q1",
        prompt: "Which plan keeps scope honest?",
        kind: "single",
        options: [
          { id: "leave-a", text: "A small measurable plan" },
          { id: "leave-b", text: "A vague big plan" },
        ],
        correctOptionIds: ["leave-a"],
        explanation: "Small scopes make progress visible.",
      },
    ],
  });
  await submitQuizAttempt(learnerA, {
    courseSlug: course.slug,
    lessonSlug: lessonSlugs[0],
    answers: { "leave-q1": ["leave-a"] },
  });

  await saveMyLessonNote(learnerA, {
    courseSlug: course.slug,
    lessonSlug: lessonSlugs[0],
    body: "Kept across leaving",
  });

  // Complete every required lesson, then claim before leaving.
  await markLessonComplete(learnerA, enrollment.id, lessonIds[0]);
  await markLessonComplete(learnerA, enrollment.id, lessonIds[1]);
  const completed = await getEnrollment(learnerA, course.id);
  assert.equal(completed?.status, "completed");
  const certificate = await claimCertificate(learnerA, course.slug, "Leave Learner");
  assert.ok(certificate.id);

  await cancelMyEnrollment(learnerA, course.id);
  const left = await getEnrollment(learnerA, course.id);
  assert.equal(left?.status, "cancelled");
  assert.ok(left?.cancelledAt instanceof Date);

  const db = await getDb();
  assert.equal(
    (await db.select().from(lessonProgress).where(eq(lessonProgress.enrollmentId, enrollment.id))).length,
    2,
    "progress rows are kept",
  );
  assert.ok(
    (await db.select().from(quizAttempts).where(eq(quizAttempts.enrollmentId, enrollment.id))).length >= 1,
    "quiz attempt rows are kept",
  );
  assert.equal(
    (await db.select().from(lessonNotes).where(eq(lessonNotes.userId, learnerA))).filter(
      (row) => row.courseId === course.id,
    ).length,
    1,
    "note rows are kept",
  );
  assert.ok(await getLearnerCertificate(learnerA, course.id), "certificate row is kept");
  assert.equal((await getLearnerCertificate(learnerA, course.id))?.revokedAt, null, "leaving does not revoke");

  // Already-issued certificates stay publicly verifiable after leaving.
  const verified = await getPublicCertificate(certificate.id);
  assert.ok(verified, "certificate still verifies");
  assert.equal(verified?.revokedAt, null);
  assert.equal(verified?.recipientName, "Leave Learner");
  assert.ok(
    (await listLearnerCertificates(learnerA)).some((row) => row.id === certificate.id),
    "certificate still listed for the learner",
  );
});

// ---------------------------------------------------------------- gates

test("access gates refuse lessons, notes and completion while cancelled", async () => {
  const { course, lessonIds, lessonSlugs } = await makeCourse();
  const enrollment = await enrollFree(learnerA, course.id);
  await markLessonComplete(learnerA, enrollment.id, lessonIds[0]);
  await cancelMyEnrollment(learnerA, course.id);

  await assert.rejects(() => requireEnrollment(learnerA, course.id), /Forbidden/);
  await assert.rejects(
    () => markLessonComplete(learnerA, enrollment.id, lessonIds[1]),
    /no longer active/,
    "cancelled enrollments write nothing",
  );
  await assert.rejects(
    () =>
      saveMyLessonNote(learnerA, {
        courseSlug: course.slug,
        lessonSlug: lessonSlugs[1],
        body: "Blocked",
      }),
    /Enroll in this course/,
  );
  assert.equal(await getMyLessonNote(learnerA, lessonIds[0]), null, "note reads are refused");
  assert.equal(
    (await getCourseCompletionState(learnerA, course.slug)).kind,
    "enrollment_required",
    "completion page requires enrollment",
  );

  // Cancelled enrollments never appear as in-progress dashboard courses.
  const accessible = await getAccessibleEnrollments(learnerA);
  assert.ok(!accessible.some((row) => row.courseId === course.id));
  await assert.rejects(
    () => claimCertificate(learnerA, course.slug, "Leave Learner"),
    /active/,
    "no new claims while cancelled",
  );
});

// ---------------------------------------------------------------- re-enroll

test("re-enrolling restores completed (with a completion date) when all required work was done", async () => {
  const { course, lessonIds } = await makeCourse();
  const enrollment = await enrollFree(learnerA, course.id);
  await markLessonComplete(learnerA, enrollment.id, lessonIds[0]);
  await markLessonComplete(learnerA, enrollment.id, lessonIds[1]);
  const before = await getEnrollment(learnerA, course.id);
  assert.equal(before?.status, "completed");
  assert.ok(before?.completedAt instanceof Date);

  await cancelMyEnrollment(learnerA, course.id);
  const left = await getEnrollment(learnerA, course.id);
  assert.equal(left?.status, "cancelled");
  assert.ok(left?.cancelledAt instanceof Date, "cancelledAt is set");

  const restored = await enrollFree(learnerA, course.id);
  assert.equal(restored.status, "completed", "real state is restored, not plain active");
  assert.ok(restored.completedAt instanceof Date, "completion date is present");
  assert.equal(restored.cancelledAt, null, "cancelledAt is cleared");

  // The kept progress still reads back as complete.
  const progress = await getEnrollmentProgress(restored);
  assert.equal(progress.completed, true);
  assert.equal(progress.completedRequired, progress.totalRequired);
});

test("re-enrolling restores active when required work was incomplete", async () => {
  const { course, lessonIds } = await makeCourse();
  const enrollment = await enrollFree(learnerA, course.id);
  await markLessonComplete(learnerA, enrollment.id, lessonIds[0]);
  await cancelMyEnrollment(learnerA, course.id);

  const restored = await enrollFree(learnerA, course.id);
  assert.equal(restored.status, "active");
  assert.equal(restored.completedAt, null);
  assert.equal(restored.cancelledAt, null);

  const progress = await getEnrollmentProgress(restored);
  assert.equal(progress.completed, false);
  assert.equal(progress.completedRequired, 1);
  assert.ok(progress.resumeLesson, "resume position is kept");
});
