/**
 * DRIP RELEASE TESTS (Batch J)
 * ---------------------------------------------------------------------------
 * - release helper: immediate, date, drip, later-of section/lesson, preview
 *   always open, boundary at exactly the release instant;
 * - every learner access path refuses a locked lesson and serves it once
 *   released (mark-complete, quiz submit, notes save/delete/read, resource
 *   verdict); admins bypass;
 * - progress totals include locked lessons; resume skips locked;
 * - Studio release validation + audit rows.
 *
 * Runs through tsx via `npm test` (no Playwright).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import "./helpers/env"; // MUST be first: fake TEST-ONLY secret before any app module.

import { eq } from "drizzle-orm";
import {
  adminAuditLog,
  enrollments,
  getDb,
  lessons,
  users,
} from "../src/lib/db";
import { migrateLocalDb } from "../src/lib/db/migrate";
import { disposeCloudflareBindings } from "../src/lib/cloudflare/bindings";
import { getAuth } from "../src/lib/auth";
import {
  isLessonReleased,
  lessonReleaseAt,
} from "../src/features/courses/release";
import {
  lessonReleaseSchema,
  sectionReleaseSchema,
} from "../src/features/courses/types";
import {
  computeCourseProgress,
  getEnrollmentProgress,
  markLessonComplete,
} from "../src/features/progress/service";
import {
  createCourse,
  createLesson,
  createSection,
  publishCourse,
  publishLesson,
} from "../src/features/courses/service";
import { enrollFree } from "../src/features/enrollments/service";
import { resolveLessonResourceAccess } from "../src/lib/course-resources/access";
import { submitQuizAttempt, upsertLessonQuiz } from "../src/features/quizzes/service";
import {
  deleteMyLessonNote,
  getMyLessonNote,
  listMyCourseNotes,
  saveMyLessonNote,
} from "../src/features/notes/service";

process.env.ADMIN_REQUIRE_2FA = "false";

const nodeRequire = createRequire(__filename);
const uid = () => crypto.randomUUID().slice(0, 10);
let cookieHeader = "";
let learnerCookie = "";
let adminCookie = "";
let learnerId = "";
let adminId = "";
let courseActions: typeof import("../src/features/courses/actions");

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
  const email = `drip-${uid()}@example.test`;
  const password = `Fixture-${crypto.randomUUID()}`;
  const created = await auth.api.signUpEmail({ body: { email, password, name: "Drip Learner" } });
  if (admin) {
    await (await getDb()).update(users).set({ role: "admin" }).where(eq(users.id, created.user.id));
  }
  const signIn = await auth.api.signInEmail({ body: { email, password }, returnHeaders: true });
  return {
    id: created.user.id,
    cookie: signIn.headers.getSetCookie().map((value) => value.split(";")[0]).join("; "),
  };
}

const DAY_MS = 86_400_000;

test.before(async () => {
  await migrateLocalDb();
  stubModule("next/headers", { headers: async () => new Headers({ cookie: cookieHeader }) });
  stubModule("next/cache", { revalidatePath: () => {} });
  const learner = await account(false);
  learnerId = learner.id;
  learnerCookie = learner.cookie;
  const admin = await account(true);
  adminId = admin.id;
  adminCookie = admin.cookie;
  cookieHeader = learnerCookie;
  courseActions = await import("../src/features/courses/actions");
});

test.after(async () => {
  await disposeCloudflareBindings();
});

async function makeCourse() {
  const course = await createCourse({ title: "Drip course", slug: `drip-course-${uid()}` });
  const section = await createSection({ courseId: course.id, title: "Drip section" });
  const lesson = await createLesson({
    courseId: course.id,
    sectionId: section.id,
    title: "Drip lesson",
    slug: `drip-lesson-${uid()}`,
    required: true,
  });
  await publishLesson(lesson.id);
  await publishCourse(course.id);
  const fresh = await (await getDb()).select().from(lessons).where(eq(lessons.id, lesson.id)).get();
  return { course, section, lesson: fresh! };
}

// ---------------------------------------------------------------- pure helper

test("release helper: immediate, date, drip, later-of, preview, boundary", async () => {
  const enrolledAt = new Date("2026-01-10T12:00:00.000Z");
  const section = { releaseMode: "immediate" as const, releaseAt: null, dripDays: null };
  const lesson = { releaseMode: "immediate" as const, releaseAt: null, dripDays: null, isPreview: false };

  assert.equal(lessonReleaseAt(section, lesson, enrolledAt), null);
  assert.equal(isLessonReleased(section, lesson, enrolledAt, new Date("2026-01-10T12:00:00.000Z")), true);

  // Date rule: locked before, open exactly at the instant.
  const at = new Date("2026-02-01T00:00:00.000Z");
  const dateLesson = { ...lesson, releaseMode: "date" as const, releaseAt: at };
  assert.equal(
    lessonReleaseAt(section, dateLesson, enrolledAt)?.getTime(),
    at.getTime(),
  );
  assert.equal(isLessonReleased(section, dateLesson, enrolledAt, new Date(at.getTime() - 1)), false);
  assert.equal(isLessonReleased(section, dateLesson, enrolledAt, new Date(at.getTime())), true);

  // Drip rule: enrolledAt + days, UTC millisecond arithmetic.
  const dripLesson = { ...lesson, releaseMode: "drip" as const, dripDays: 7 };
  const expected = new Date(enrolledAt.getTime() + 7 * DAY_MS);
  assert.equal(lessonReleaseAt(section, dripLesson, enrolledAt)?.getTime(), expected.getTime());
  assert.equal(isLessonReleased(section, dripLesson, enrolledAt, new Date(expected.getTime() - 1)), false);
  assert.equal(isLessonReleased(section, dripLesson, enrolledAt, new Date(expected.getTime())), true);

  // Later of section and lesson wins.
  const strictSection = { releaseMode: "drip" as const, releaseAt: null, dripDays: 14 };
  assert.equal(
    lessonReleaseAt(strictSection, dripLesson, enrolledAt)?.getTime(),
    enrolledAt.getTime() + 14 * DAY_MS,
  );
  const strictDate = { releaseMode: "date" as const, releaseAt: new Date("2027-01-01T00:00:00.000Z"), dripDays: null };
  assert.equal(
    lessonReleaseAt(strictDate, dripLesson, enrolledAt)?.getTime(),
    new Date("2027-01-01T00:00:00.000Z").getTime(),
  );

  // Preview is always released even under a future rule.
  const previewLocked = { ...dripLesson, isPreview: true };
  assert.equal(lessonReleaseAt(strictDate, previewLocked, enrolledAt), null);
  assert.equal(isLessonReleased(strictDate, previewLocked, enrolledAt, new Date("2020-01-01T00:00:00.000Z")), true);
});

// ---------------------------------------------------------------- learner gates

test("mark-complete refuses a locked lesson and succeeds once released", async () => {
  const { course, lesson } = await makeCourse();
  const enrollment = await enrollFree(learnerId, course.id);
  const db = await getDb();
  await db
    .update(lessons)
    .set({ releaseMode: "drip", dripDays: 30 })
    .where(eq(lessons.id, lesson.id));

  await assert.rejects(() => markLessonComplete(learnerId, enrollment.id, lesson.id), /not unlocked/i);

  // Backdate the enrollment start so the drip has elapsed (releases serve).
  await db
    .update(enrollments)
    .set({ enrolledAt: new Date(Date.now() - 31 * DAY_MS) })
    .where(eq(enrollments.id, enrollment.id));
  const result = await markLessonComplete(learnerId, enrollment.id, lesson.id);
  assert.equal(result.alreadyComplete, false);
});

test("quiz submit refuses a locked lesson", async () => {
  const { course, section, lesson } = await makeCourse();
  const quiz = await upsertLessonQuiz({
    lessonId: lesson.id,
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
  const db = await getDb();
  await db.update(lessons).set({ releaseMode: "drip", dripDays: 30 }).where(eq(lessons.id, lesson.id));
  const answers = Object.fromEntries(quiz.questions.map((q) => [q.id, [...q.correctOptionIds]]));
  await assert.rejects(
    () => submitQuizAttempt(learnerId, { courseSlug: course.slug, lessonSlug: lesson.slug, answers }),
    /not unlocked/i,
  );
  void enrollment;
  void section;
});

test("notes save/read/delete refuse a locked lesson", async () => {
  const { course, lesson } = await makeCourse();
  await enrollFree(learnerId, course.id);
  const db = await getDb();
  const enrollment = (await db.select().from(enrollments).where(eq(enrollments.courseId, course.id))).find(
    (e) => e.userId === learnerId,
  )!;

  // A note saved while released stays stored, but the release-aware read path
  // hides it (and the list) once the lesson locks.
  const saved = await saveMyLessonNote(learnerId, {
    courseSlug: course.slug,
    lessonSlug: lesson.slug,
    body: "hello",
  });
  assert.equal(saved.deleted, false);
  await db.update(lessons).set({ releaseMode: "drip", dripDays: 30 }).where(eq(lessons.id, lesson.id));

  await assert.rejects(
    () => saveMyLessonNote(learnerId, { courseSlug: course.slug, lessonSlug: lesson.slug, body: "hello again" }),
    /not unlocked/i,
  );
  await assert.rejects(
    () => deleteMyLessonNote(learnerId, { courseSlug: course.slug, lessonSlug: lesson.slug }),
    /not unlocked/i,
  );

  // Unfiltered service read still returns the stored row (pre-drip default);
  // the release-aware path used by learner pages hides it.
  assert.equal((await getMyLessonNote(learnerId, lesson.id))?.body, "hello");
  assert.equal(await getMyLessonNote(learnerId, lesson.id, { enrolledAt: enrollment.enrolledAt }), null);
  assert.deepEqual(await listMyCourseNotes(learnerId, course.id, { enrolledAt: enrollment.enrolledAt }), []);
});

test("resource verdict is locked (not 404) for enrolled learners; admins bypass", async () => {
  const { course } = await makeCourse();
  const enrollment = await enrollFree(learnerId, course.id);
  const locked = resolveLessonResourceAccess({
    role: "user",
    lessonStatus: "published",
    enrollment,
    dripLocked: true,
    dripReleaseAt: new Date(Date.now() + DAY_MS),
  });
  assert.equal(locked.status, "locked");
  assert.equal(
    resolveLessonResourceAccess({ role: "admin", lessonStatus: "published", enrollment: null, dripLocked: true }).status,
    "allowed",
  );
  assert.equal(
    resolveLessonResourceAccess({ role: "user", lessonStatus: "published", enrollment }).status,
    "allowed",
  );
});

// ---------------------------------------------------------------- progress

test("progress totals include locked lessons; resume skips them", async () => {
  const { course, lesson } = await makeCourse();
  const second = await createLesson({
    courseId: course.id,
    sectionId: lesson.sectionId,
    title: "Second",
    slug: `drip-second-${uid()}`,
    required: true,
  });
  await publishLesson(second.id);
  const enrollment = await enrollFree(learnerId, course.id);
  const db = await getDb();
  await db.update(lessons).set({ releaseMode: "drip", dripDays: 30 }).where(eq(lessons.id, lesson.id));

  // Pure maths: locked required lesson counts in total but never resumes.
  const lessonRow = (await db.select().from(lessons).where(eq(lessons.id, lesson.id)).get())!;
  const secondRow = (await db.select().from(lessons).where(eq(lessons.id, second.id)).get())!;
  const maths = computeCourseProgress(
    [lessonRow, secondRow],
    [],
    (l) => l.id !== lessonRow.id,
  );
  assert.equal(maths.totalRequired, 2);
  assert.equal(maths.resumeLesson?.id, secondRow.id);

  // Integrated read: resume is the released lesson; locked verdict untouched.
  const progress = await getEnrollmentProgress(enrollment);
  assert.equal(progress.totalRequired, 2);
  assert.equal(progress.resumeLesson?.id, secondRow.id);
  assert.ok(progress.nextUnlockAt instanceof Date);
});

// ---------------------------------------------------------------- Studio validation + audit

test("Studio release validation rejects bad input", async () => {
  assert.equal(sectionReleaseSchema.safeParse({ id: "s", releaseMode: "date", releaseAt: null, dripDays: null }).success, false);
  assert.equal(
    sectionReleaseSchema.safeParse({ id: "s", releaseMode: "drip", releaseAt: null, dripDays: 0 }).success,
    false,
  );
  assert.equal(
    sectionReleaseSchema.safeParse({ id: "s", releaseMode: "drip", releaseAt: null, dripDays: 366 }).success,
    false,
  );
  assert.equal(
    lessonReleaseSchema.safeParse({ id: "l", releaseMode: "date", releaseAt: "not-a-date", dripDays: null }).success,
    false,
  );
  assert.equal(
    sectionReleaseSchema.safeParse({ id: "s", releaseMode: "immediate", releaseAt: null, dripDays: null }).success,
    true,
  );
  assert.equal(
    lessonReleaseSchema.safeParse({ id: "l", releaseMode: "drip", releaseAt: null, dripDays: 7 }).success,
    true,
  );
});

test("Studio release actions persist and write audit rows", async () => {
  const { course, section, lesson } = await makeCourse();
  cookieHeader = adminCookie;

  const sectionRes = await courseActions.updateSectionReleaseAction({
    id: section.id,
    releaseMode: "drip",
    releaseAt: null,
    dripDays: 5,
  });
  assert.equal(sectionRes.ok, true);
  const lessonRes = await courseActions.updateLessonReleaseAction({
    id: lesson.id,
    releaseMode: "date",
    releaseAt: new Date(Date.now() + 3 * DAY_MS).toISOString(),
    dripDays: null,
  });
  assert.equal(lessonRes.ok, true);

  const db = await getDb();
  const audits = await db.select().from(adminAuditLog);
  const kinds = new Set(audits.map((a) => a.action));
  assert.ok(kinds.has("course_section.release"), "section release audit row");
  assert.ok(kinds.has("lesson.release"), "lesson release audit row");
  void course;
  void adminId;

  cookieHeader = learnerCookie;
});
