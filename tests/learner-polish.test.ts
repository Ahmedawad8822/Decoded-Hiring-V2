/**
 * LEARNER POLISH TESTS (sequential lock, restart, video positions)
 * ---------------------------------------------------------------------------
 * A. Sequential lock (per course, optional):
 *    - pure order maths (earlier REQUIRED lessons block; optional never
 *      blocks; previews bypass; unknown ids stay open);
 *    - Studio toggle persists and writes an admin audit row;
 *    - mark-complete, quiz submit refuse locked lessons and succeed after the
 *      earlier lessons complete; resume/continuation skip locked lessons;
 *    - resource verdict is locked (not 404) for enrolled learners;
 *    - previews unaffected (complete/submit/notes out of order).
 * B. Restart course (self-serve):
 *    - signed-out and strangers refused, scoped to the caller's row;
 *    - clears lesson progress + video positions for THAT course only;
 *    - keeps quiz attempts, notes, certificates and the enrollment record;
 *    - completed -> active with completedAt cleared, enrolledAt kept;
 *    - cancelled enrollments cannot restart;
 *    - audits like leave-course (course_restarted outbox event, never throws).
 * C. Phone quiz stepping has no server changes (pure client + CSS).
 * D. Video positions:
 *    - number validation; owner-scoped reads/writes; enrollment auth;
 *    - one row per (user, lesson), upsert keeps the latest;
 *    - the 90% auto-complete path (markLessonComplete) respects quiz gates;
 *    - resume helpers (format + offer rules).
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
  adminAuditLog,
  certificates,
  courses,
  emailOutbox,
  getDb,
  lessonNotes,
  lessonProgress,
  lessonVideoPositions,
  quizAttempts,
  users,
} from "../src/lib/db";
import { migrateLocalDb } from "../src/lib/db/migrate";
import { disposeCloudflareBindings } from "../src/lib/cloudflare/bindings";
import { getAuth } from "../src/lib/auth";
import {
  findSequentialBlocker,
  isSequentiallyLocked,
} from "../src/features/courses/release";
import {
  completeLessonAndContinue,
  getEnrollmentProgress,
  getSequentialBlocker,
} from "../src/features/progress/service";
import {
  createCourse,
  createLesson,
  createSection,
  publishCourse,
  publishLesson,
  updateCourse,
} from "../src/features/courses/service";
import {
  cancelMyEnrollment,
  enrollFree,
  getEnrollment,
  restartMyEnrollment,
} from "../src/features/enrollments/service";
import { resolveLessonResourceAccess } from "../src/lib/course-resources/access";
import { getLessonQuiz, submitQuizAttempt, upsertLessonQuiz } from "../src/features/quizzes/service";
import { markLessonComplete } from "../src/features/progress/service";
import { saveMyLessonNote, getMyLessonNote } from "../src/features/notes/service";
import {
  getMyVideoPosition,
  saveMyVideoPosition,
} from "../src/features/video-positions/service";
import {
  AUTO_COMPLETE_FRACTION,
  saveVideoPositionSchema,
} from "../src/features/video-positions/types";
import { claimCertificate, getPublicCertificate } from "../src/features/certificates/service";

process.env.ADMIN_REQUIRE_2FA = "false";

const nodeRequire = createRequire(__filename);
const uid = () => crypto.randomUUID().slice(0, 10);
let cookieHeader = "";
let learnerCookie = "";
let adminCookie = "";
let learnerId = "";
let adminId = "";
let courseActions: typeof import("../src/features/courses/actions");
let enrollmentActions: typeof import("../src/features/enrollments/actions");
let videoActions: typeof import("../src/features/video-positions/actions");

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

async function account(admin: boolean) {
  const auth = await getAuth();
  const email = `polish-${uid()}@example.test`;
  const password = `Fixture-${crypto.randomUUID()}`;
  const created = await auth.api.signUpEmail({ body: { email, password, name: "Polish Learner" } });
  if (admin) {
    await (await getDb()).update(users).set({ role: "admin" }).where(eq(users.id, created.user.id));
  }
  await markEmailVerified(created.user.id);
  const signIn = await auth.api.signInEmail({ body: { email, password }, returnHeaders: true });
  return {
    id: created.user.id,
    cookie: signIn.headers.getSetCookie().map((value) => value.split(";")[0]).join("; "),
  };
}

test.before(async () => {
  await migrateLocalDb();
  stubModule("next/headers", { headers: async () => new Headers({ cookie: cookieHeader }) });
  stubModule("next/cache", { revalidatePath: () => {} });
  stubModule("next/navigation", { useRouter: () => ({ push: () => {}, refresh: () => {} }) });
  const learner = await account(false);
  learnerId = learner.id;
  learnerCookie = learner.cookie;
  const admin = await account(true);
  adminId = admin.id;
  adminCookie = admin.cookie;
  cookieHeader = learnerCookie;
  courseActions = await import("../src/features/courses/actions");
  enrollmentActions = await import("../src/features/enrollments/actions");
  videoActions = await import("../src/features/video-positions/actions");
});

test.after(async () => {
  await disposeCloudflareBindings();
});

async function makeCourse(options: { lessons?: number; sequential?: boolean; certificate?: boolean; previewLast?: boolean } = {}) {
  const count = options.lessons ?? 3;
  const course = await createCourse({
    title: "Polish course",
    slug: `polish-course-${uid()}`,
    certificateEnabled: options.certificate ?? false,
  });
  const sectionA = await createSection({ courseId: course.id, title: "Section A" });
  const sectionB = await createSection({ courseId: course.id, title: "Section B" });
  const lessonIds: string[] = [];
  const lessonSlugs: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const slug = `polish-lesson-${uid()}`;
    const lesson = await createLesson({
      courseId: course.id,
      // Spread lessons across two sections so course order crosses sections.
      sectionId: index < 2 ? sectionA.id : sectionB.id,
      title: `Polish lesson ${index + 1}`,
      slug,
      required: true,
      isPreview: options.previewLast === true && index === count - 1,
    });
    await publishLesson(lesson.id);
    lessonIds.push(lesson.id);
    lessonSlugs.push(slug);
  }
  await publishCourse(course.id);
  if (options.sequential) {
    await updateCourse(course.id, { id: course.id, sequential: true });
  }
  const db = await getDb();
  const courseRow = await db.select().from(courses).where(eq(courses.id, course.id)).get();
  return { course: courseRow!, lessonIds, lessonSlugs };
}

// ---------------------------------------------------------------- A. pure order maths

test("sequential: earlier required lessons block, optional never blocks, previews bypass", async () => {
  const ordered = [
    { id: "a", required: true, isPreview: false },
    { id: "b", required: false, isPreview: false },
    { id: "c", required: true, isPreview: false },
    { id: "d", required: true, isPreview: false },
  ];
  // First lesson is always open; unknown ids fail open (drip/other gates apply).
  assert.equal(findSequentialBlocker(ordered, new Set(), "a"), null);
  assert.equal(findSequentialBlocker(ordered, new Set(), "missing"), null);
  // Earlier required blocks, even for an optional target.
  assert.equal(findSequentialBlocker(ordered, new Set(), "c"), "a");
  assert.equal(findSequentialBlocker(ordered, new Set(), "b"), "a");
  assert.equal(findSequentialBlocker(ordered, new Set(["a"]), "c"), null);
  // An incomplete earlier OPTIONAL lesson never blocks.
  assert.equal(findSequentialBlocker(ordered, new Set(["a"]), "d"), "c");
  assert.equal(findSequentialBlocker(ordered, new Set(["a", "c"]), "d"), null);
  assert.equal(isSequentiallyLocked(ordered, new Set(), "d"), true);
  assert.equal(isSequentiallyLocked(ordered, new Set(["a", "c"]), "d"), false);
  // Previews stay readable regardless of earlier incompletes.
  const withPreview = [...ordered, { id: "p", required: true, isPreview: true }];
  assert.equal(findSequentialBlocker(withPreview, new Set(), "p"), null);
  assert.equal(isSequentiallyLocked(withPreview, new Set(), "p"), false);
});

// ---------------------------------------------------------------- A. Studio toggle + audit

test("sequential: Studio toggle persists and writes an admin audit row", async () => {
  const { course } = await makeCourse();
  cookieHeader = adminCookie;
  const res = await courseActions.updateCourseAction({ id: course.id, sequential: true });
  assert.equal(res.ok, true, String(res.error));
  const db = await getDb();
  const row = await db.select().from(courses).where(eq(courses.id, course.id)).get();
  assert.equal(row?.sequential, true);
  const audits = await db.select().from(adminAuditLog);
  const update = audits.find((a) => a.action === "course.update" && a.entityId === course.id);
  assert.ok(update, "course.update audit row");
  assert.equal((JSON.parse(update!.details!) as { sequential: boolean }).sequential, true);
  void adminId;
  cookieHeader = learnerCookie;
});

test("sequential: signed-out Studio toggle is refused", async () => {
  const { course } = await makeCourse();
  cookieHeader = "";
  const res = await courseActions.updateCourseAction({ id: course.id, sequential: true });
  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /Unauthorized/i);
  cookieHeader = learnerCookie;
});

// ---------------------------------------------------------------- A. progress gating

test("sequential: completion refuses locked lessons, resume skips them", async () => {
  const { course, lessonIds } = await makeCourse({ sequential: true });
  const enrollment = await enrollFree(learnerId, course.id);

  // Third lesson is locked behind the first two required lessons.
  await assert.rejects(
    () => markLessonComplete(learnerId, enrollment.id, lessonIds[2]),
    /Finish the previous lesson/i,
  );
  // The blocker is the first incomplete earlier required lesson.
  const blocker = await getSequentialBlocker({
    course,
    enrollment,
    lesson: { id: lessonIds[2], isPreview: false },
  });
  assert.equal(blocker?.id, lessonIds[0]);

  await markLessonComplete(learnerId, enrollment.id, lessonIds[0]);
  await assert.rejects(
    () => markLessonComplete(learnerId, enrollment.id, lessonIds[2]),
    /Finish the previous lesson/i,
  );

  // Resume skips locked lessons: the second lesson, not the third.
  const progress = await getEnrollmentProgress(enrollment);
  assert.equal(progress.totalRequired, 3);
  assert.equal(progress.resumeLesson?.id, lessonIds[1]);

  await markLessonComplete(learnerId, enrollment.id, lessonIds[1]);
  const open = await markLessonComplete(learnerId, enrollment.id, lessonIds[2]);
  assert.equal(open.alreadyComplete, false);
});

test("sequential: continuation never lands on a locked lesson", async () => {
  const { course, lessonIds, lessonSlugs } = await makeCourse({ sequential: true });
  const enrollment = await enrollFree(learnerId, course.id);
  // The server-owned target after lesson 1 is lesson 2 (never lesson 3, which
  // is still sequentially locked, and never the completion page yet).
  const first = await completeLessonAndContinue(learnerId, enrollment.id, lessonIds[0]);
  assert.equal(first.nextHref, `/learn/courses/${course.slug}/lessons/${lessonSlugs[1]}`);
});

// ---------------------------------------------------------------- A. quiz + download gates

test("sequential: quiz submit refuses locked lessons", async () => {
  const { course, lessonIds, lessonSlugs } = await makeCourse({ sequential: true, lessons: 2 });
  await upsertLessonQuiz({
    lessonId: lessonIds[1],
    passPercent: 50,
    requirePass: false,
    questions: [
      {
        id: "q1",
        prompt: "P",
        kind: "single",
        options: [
          { id: "o1", text: "One" },
          { id: "o2", text: "Two" },
        ],
        correctOptionIds: ["o1"],
      },
    ],
  });
  await enrollFree(learnerId, course.id);
  const saved = await getLessonQuiz(lessonIds[1]);
  const answers = Object.fromEntries(saved!.questions.map((q) => [q.id, [...q.correctOptionIds]]));
  await assert.rejects(
    () => submitQuizAttempt(learnerId, { courseSlug: course.slug, lessonSlug: lessonSlugs[1], answers }),
    /Finish the previous lesson/i,
  );
  await markLessonComplete(learnerId, (await getEnrollment(learnerId, course.id))!.id, lessonIds[0]);
  const result = await submitQuizAttempt(learnerId, { courseSlug: course.slug, lessonSlug: lessonSlugs[1], answers });
  assert.equal(result.passed, true);
});

test("sequential: resource verdict is locked for enrolled learners, admins bypass", async () => {
  const { course } = await makeCourse({ sequential: true });
  const enrollment = await enrollFree(learnerId, course.id);
  const locked = resolveLessonResourceAccess({
    role: "user",
    lessonStatus: "published",
    enrollment,
    sequentialLocked: true,
  });
  assert.deepEqual(locked, { status: "locked", releaseAt: null });
  assert.deepEqual(
    resolveLessonResourceAccess({ role: "admin", lessonStatus: "published", enrollment: null, sequentialLocked: true }).status,
    "allowed",
  );
  assert.deepEqual(
    resolveLessonResourceAccess({ role: "user", lessonStatus: "published", enrollment }).status,
    "allowed",
  );
});

// ---------------------------------------------------------------- A. previews unaffected

test("sequential: previews stay completable and submittable out of order", async () => {
  const { course, lessonIds, lessonSlugs } = await makeCourse({ sequential: true, lessons: 2, previewLast: true });
  await upsertLessonQuiz({
    lessonId: lessonIds[1],
    passPercent: 50,
    requirePass: false,
    questions: [
      {
        id: "q1",
        prompt: "P",
        kind: "single",
        options: [
          { id: "o1", text: "One" },
          { id: "o2", text: "Two" },
        ],
        correctOptionIds: ["o1"],
      },
    ],
  });
  const enrollment = await enrollFree(learnerId, course.id);
  // Preview lesson (last) completes and submits while the first is incomplete.
  const done = await markLessonComplete(learnerId, enrollment.id, lessonIds[1]);
  assert.equal(done.alreadyComplete, false);
  const saved = await getLessonQuiz(lessonIds[1]);
  const answers = Object.fromEntries(saved!.questions.map((q) => [q.id, [...q.correctOptionIds]]));
  const result = await submitQuizAttempt(learnerId, { courseSlug: course.slug, lessonSlug: lessonSlugs[1], answers });
  assert.equal(result.passed, true);
  // Notes on the preview lesson are writable too.
  const note = await saveMyLessonNote(learnerId, {
    courseSlug: course.slug,
    lessonSlug: lessonSlugs[1],
    body: "preview note",
  });
  assert.equal(note.deleted, false);
  assert.equal((await getMyLessonNote(learnerId, lessonIds[1]))?.body, "preview note");
});

// ---------------------------------------------------------------- B. restart

test("restart: signed-out learners are refused", async () => {
  const { course } = await makeCourse();
  cookieHeader = "";
  const result = await enrollmentActions.restartCourseAction({ courseSlug: course.slug });
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /Unauthorized/i);
  cookieHeader = learnerCookie;
});

test("restart: scoped to the caller, cancelled enrollments cannot restart", async () => {
  const { course } = await makeCourse();
  const enrollmentA = await enrollFree(learnerId, course.id);
  const b = await account(false);
  cookieHeader = b.cookie;
  const result = await enrollmentActions.restartCourseAction({ courseSlug: course.slug });
  assert.equal(result.ok, false, "restart without an enrollment fails");
  cookieHeader = learnerCookie;
  assert.equal((await getEnrollment(learnerId, course.id))?.id, enrollmentA.id);

  await cancelMyEnrollment(learnerId, course.id);
  await assert.rejects(() => restartMyEnrollment(learnerId, course.id), /not enrolled/i);
});

test("restart: clears only the right rows and returns to the first lesson", async () => {
  const alpha = await makeCourse({ lessons: 2, certificate: true });
  const beta = await makeCourse({ lessons: 1 });
  const enrollment = await enrollFree(learnerId, alpha.course.id);
  const betaEnrollment = await enrollFree(learnerId, beta.course.id);
  const beforeEnrolledAt = enrollment.enrolledAt.getTime();

  // Quiz + note + video position on alpha; video position on beta (must survive).
  await upsertLessonQuiz({
    lessonId: alpha.lessonIds[0],
    passPercent: 70,
    requirePass: false,
    questions: [
      {
        id: "r-q1",
        prompt: "Which plan keeps scope honest?",
        kind: "single",
        options: [
          { id: "r-a", text: "A small measurable plan" },
          { id: "r-b", text: "A vague big plan" },
        ],
        correctOptionIds: ["r-a"],
        explanation: "Small scopes make progress visible.",
      },
    ],
  });
  await submitQuizAttempt(learnerId, {
    courseSlug: alpha.course.slug,
    lessonSlug: alpha.lessonSlugs[0],
    answers: { "r-q1": ["r-a"] },
  });
  await saveMyLessonNote(learnerId, {
    courseSlug: alpha.course.slug,
    lessonSlug: alpha.lessonSlugs[0],
    body: "Kept across restart",
  });
  await saveMyVideoPosition(learnerId, {
    courseSlug: alpha.course.slug,
    lessonSlug: alpha.lessonSlugs[0],
    positionSeconds: 272,
    durationSeconds: 600,
  });
  await saveMyVideoPosition(learnerId, {
    courseSlug: beta.course.slug,
    lessonSlug: beta.lessonSlugs[0],
    positionSeconds: 42,
    durationSeconds: 300,
  });

  // Complete every required lesson, claim the certificate, then restart.
  await markLessonComplete(learnerId, enrollment.id, alpha.lessonIds[0]);
  await markLessonComplete(learnerId, enrollment.id, alpha.lessonIds[1]);
  assert.equal((await getEnrollment(learnerId, alpha.course.id))?.status, "completed");
  const certificate = await claimCertificate(learnerId, alpha.course.slug, "Restart Learner");
  assert.ok(certificate.id);

  cookieHeader = learnerCookie;
  const action = await enrollmentActions.restartCourseAction({ courseSlug: alpha.course.slug });
  if (!action.ok) assert.fail(action.error);
  assert.equal(
    action.data.firstLessonHref,
    `/learn/courses/${alpha.course.slug}/lessons/${alpha.lessonSlugs[0]}`,
  );

  const restarted = (await getEnrollment(learnerId, alpha.course.id))!;
  assert.equal(restarted.id, enrollment.id, "enrollment record is kept");
  assert.equal(restarted.status, "active", "completed returns to active");
  assert.equal(restarted.completedAt, null, "completion date is cleared");
  assert.equal(restarted.enrolledAt.getTime(), beforeEnrolledAt, "original start is kept for drip");

  const db = await getDb();
  assert.equal(
    (await db.select().from(lessonProgress).where(eq(lessonProgress.enrollmentId, enrollment.id))).length,
    0,
    "lesson progress is cleared",
  );
  assert.equal(
    await getMyVideoPosition(learnerId, alpha.lessonIds[0]),
    null,
    "alpha resume position is cleared",
  );
  assert.equal(
    (await getMyVideoPosition(learnerId, beta.lessonIds[0]))?.positionSeconds,
    42,
    "other courses are untouched",
  );
  assert.equal(
    (await db.select().from(lessonProgress).where(eq(lessonProgress.enrollmentId, betaEnrollment.id))).length,
    0,
    "beta had no progress",
  );
  assert.ok(
    (await db.select().from(quizAttempts).where(eq(quizAttempts.enrollmentId, enrollment.id))).length >= 1,
    "quiz attempts are kept",
  );
  assert.equal(
    (await db.select().from(lessonNotes).where(eq(lessonNotes.userId, learnerId))).filter(
      (row) => row.courseId === alpha.course.id,
    ).length,
    1,
    "notes are kept",
  );
  const kept = await db.select().from(certificates).where(eq(certificates.userId, learnerId));
  assert.ok(kept.some((row) => row.id === certificate.id), "certificate row is kept");
  assert.ok(await getPublicCertificate(certificate.id), "certificate still verifies");

  // Audit like leave-course: a durable, deduped course_restarted outbox event.
  const outbox = await db.select().from(emailOutbox);
  const audit = outbox.find(
    (row) =>
      row.kind === "course_restarted" &&
      row.dedupeKey?.startsWith(`course_restarted:${learnerId}:${alpha.course.id}:`),
  );
  assert.ok(audit, "course_restarted audit event is queued");
});

// ---------------------------------------------------------------- D. video positions

test("video positions: numbers are validated", async () => {
  assert.equal(saveVideoPositionSchema.safeParse({
    courseSlug: "c", lessonSlug: "l", positionSeconds: 10, durationSeconds: 100,
  }).success, true);
  assert.equal(saveVideoPositionSchema.safeParse({
    courseSlug: "c", lessonSlug: "l", positionSeconds: 10,
  }).success, true);
  for (const bad of [
    { courseSlug: "c", lessonSlug: "l", positionSeconds: -1, durationSeconds: 100 },
    { courseSlug: "c", lessonSlug: "l", positionSeconds: Number.NaN, durationSeconds: 100 },
    { courseSlug: "c", lessonSlug: "l", positionSeconds: Number.POSITIVE_INFINITY, durationSeconds: 100 },
    { courseSlug: "c", lessonSlug: "l", positionSeconds: 200, durationSeconds: 100 },
    { courseSlug: "c", lessonSlug: "l", positionSeconds: 10, durationSeconds: 0 },
    { courseSlug: "c", lessonSlug: "l", positionSeconds: 10, durationSeconds: -5 },
    { courseSlug: "c", lessonSlug: "l", positionSeconds: 100_000, durationSeconds: null },
    { courseSlug: "", lessonSlug: "l", positionSeconds: 10, durationSeconds: 100 },
  ]) {
    assert.equal(saveVideoPositionSchema.safeParse(bad).success, false, JSON.stringify(bad));
  }
  assert.equal(AUTO_COMPLETE_FRACTION, 0.9);
});

test("video positions: owner-scoped reads, enrollment auth, one row upsert", async () => {
  const { course, lessonIds, lessonSlugs } = await makeCourse({ lessons: 1 });
  const enrollment = await enrollFree(learnerId, course.id);
  void enrollment;

  // Strangers (no enrollment) cannot write.
  const stranger = await account(false);
  await assert.rejects(
    () => saveMyVideoPosition(stranger.id, {
      courseSlug: course.slug, lessonSlug: lessonSlugs[0], positionSeconds: 5, durationSeconds: 100,
    }),
    /Enroll in this course/i,
  );

  // First save creates, second save updates the same row.
  await saveMyVideoPosition(learnerId, {
    courseSlug: course.slug, lessonSlug: lessonSlugs[0], positionSeconds: 30, durationSeconds: 600,
  });
  const updated = await saveMyVideoPosition(learnerId, {
    courseSlug: course.slug, lessonSlug: lessonSlugs[0], positionSeconds: 272, durationSeconds: 600,
  });
  assert.equal(updated.positionSeconds, 272);
  const db = await getDb();
  assert.equal(
    (await db.select().from(lessonVideoPositions).where(eq(lessonVideoPositions.userId, learnerId))).filter(
      (row) => row.lessonId === lessonIds[0],
    ).length,
    1,
    "one row per learner lesson",
  );

  // Owner-scoped reads: another learner sees nothing.
  assert.equal(await getMyVideoPosition(stranger.id, lessonIds[0]), null);
  assert.equal((await getMyVideoPosition(learnerId, lessonIds[0]))?.positionSeconds, 272);

  // Position past the known duration is clamped, not stored raw.
  const clamped = await saveMyVideoPosition(learnerId, {
    courseSlug: course.slug, lessonSlug: lessonSlugs[0], positionSeconds: 601, durationSeconds: 600,
  });
  assert.equal(clamped.positionSeconds, 600);
});

test("video positions: signed-out saves are refused", async () => {
  const { course, lessonSlugs } = await makeCourse({ lessons: 1 });
  await enrollFree(learnerId, course.id);
  cookieHeader = "";
  const result = await videoActions.saveVideoPositionAction({
    courseSlug: course.slug, lessonSlug: lessonSlugs[0], positionSeconds: 5, durationSeconds: 100,
  });
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /Unauthorized/i);
  cookieHeader = learnerCookie;
});

test("video positions: 90% auto-complete goes through gates (quiz, drip, sequential)", async () => {
  const { course, lessonIds, lessonSlugs } = await makeCourse({ sequential: true, lessons: 2 });
  // Watch-gated lesson: requirePass quiz, no passed attempt.
  await upsertLessonQuiz({
    lessonId: lessonIds[1],
    passPercent: 70,
    requirePass: true,
    questions: [
      {
        id: "g-q1",
        prompt: "P",
        kind: "single",
        options: [
          { id: "g-a", text: "One" },
          { id: "g-b", text: "Two" },
        ],
        correctOptionIds: ["g-a"],
      },
    ],
  });
  const enrollment = await enrollFree(learnerId, course.id);
  // Positions cannot be recorded on a locked lesson (the player is not served
  // there — same rule as note writes).
  await assert.rejects(
    () => saveMyVideoPosition(learnerId, {
      courseSlug: course.slug, lessonSlug: lessonSlugs[1], positionSeconds: 95, durationSeconds: 100,
    }),
    /Finish the previous lesson/i,
  );
  // Even at 95% watched, the completion path refuses: sequential first...
  await assert.rejects(
    () => markLessonComplete(learnerId, enrollment.id, lessonIds[1]),
    /Finish the previous lesson/i,
  );
  await markLessonComplete(learnerId, enrollment.id, lessonIds[0]);
  // ...then, unlocked but quiz-gated, the quiz gate.
  await saveMyVideoPosition(learnerId, {
    courseSlug: course.slug, lessonSlug: lessonSlugs[1], positionSeconds: 95, durationSeconds: 100,
  });
  await assert.rejects(
    () => markLessonComplete(learnerId, enrollment.id, lessonIds[1]),
    /Pass the quiz/i,
  );
});

// ---------------------------------------------------------------- C + D helpers (pure client maths)

test("quiz stepping + resume helpers: pure client rules", async () => {
  const player = await import("../src/components/learner/lesson-video-player");
  assert.equal(player.formatResumeTime(272), "4:32");
  assert.equal(player.formatResumeTime(3661), "1:01:01");
  assert.equal(player.formatResumeTime(9), "0:09");
  assert.equal(player.shouldOfferResume(null, 600), false);
  assert.equal(player.shouldOfferResume(0, 600), false);
  assert.equal(player.shouldOfferResume(4.9, 600), false);
  assert.equal(player.shouldOfferResume(272, 600), true);
  assert.equal(player.shouldOfferResume(272, null), true);
  assert.equal(player.shouldOfferResume(600, 600), false, "at the end: no resume");
});
