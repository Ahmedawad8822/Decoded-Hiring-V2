/**
 * LESSON QUESTIONS (private learner -> instructor Q&A)
 * ---------------------------------------------------------------------------
 * - Enrolled-only ask (non-enrolled, preview reader and signed-out refused),
 *   validation, daily budget, idempotency keys.
 * - Privacy: a learner never sees another learner's private question; the
 *   public list is identity-free.
 * - Learner delete while open only; leaving a course keeps questions.
 * - Admin answer/publish/close/reopen with audit (no bodies) and the answer
 *   email queued exactly once.
 * - People profile includes the person's questions in the timeline.
 *
 * Runs through tsx via `npm test` (no Playwright).
 */
import "./helpers/env"; // MUST be first: throwaway DH_LOCAL_STATE_DIR + test secret.
import { markEmailVerified } from "./helpers/verified";
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { and, eq } from "drizzle-orm";
import {
  adminAuditLog,
  emailOutbox,
  enrollments,
  getDb,
  lessonQuestions,
  users,
} from "../src/lib/db";
import { migrateLocalDb } from "../src/lib/db/migrate";
import { disposeCloudflareBindings } from "../src/lib/cloudflare/bindings";
import { getAuth } from "../src/lib/auth";
import { AppError } from "../src/lib/errors";
import {
  createCourse,
  createLesson,
  createSection,
  publishCourse,
  publishLesson,
} from "../src/features/courses/service";
import { enrollFree, cancelMyEnrollment } from "../src/features/enrollments/service";
import {
  answerLessonQuestion,
  askLessonQuestion,
  countOpenQuestions,
  deleteMyLessonQuestion,
  getAdminQuestion,
  listAdminQuestions,
  listMyLessonQuestions,
  listPublicLessonQuestions,
  transitionQuestionStatus,
} from "../src/features/lesson-questions/service";
import { getPersonProfile } from "../src/features/people/service";

process.env.ADMIN_REQUIRE_2FA = "false";
const nodeRequire = createRequire(__filename);
let cookieHeader = "";

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

const uid = () => crypto.randomUUID().slice(0, 8);
const key = () => `q_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;

let adminId = "";
let learnerA = { id: "", email: "", cookie: "" };
let learnerB = { id: "", email: "", cookie: "" };
let adminCookie = "";
let courseSlug = "";
let courseId = "";
let lessonSlug = "";
let lessonId = "";
let previewLessonSlug = "";

type Actions = typeof import("../src/features/lesson-questions/actions");
let actions: Actions;

async function account(admin: boolean) {
  const auth = await getAuth();
  const email = `question-${uid()}@example.test`;
  const password = `Fixture-${crypto.randomUUID()}`;
  const created = await auth.api.signUpEmail({
    body: { email, password, name: "Question Fixture" },
  });
  if (admin) await (await getDb()).update(users).set({ role: "admin" }).where(eq(users.id, created.user.id));
  await markEmailVerified(created.user.id);
  const signIn = await auth.api.signInEmail({ body: { email, password }, returnHeaders: true });
  return {
    id: created.user.id,
    email,
    cookie: signIn.headers.getSetCookie().map((value) => value.split(";")[0]).join("; "),
  };
}

async function asUser<T>(cookie: string, fn: () => Promise<T>): Promise<T> {
  const saved = cookieHeader;
  cookieHeader = cookie;
  try {
    return await fn();
  } finally {
    cookieHeader = saved;
  }
}

test.before(async () => {
  await migrateLocalDb();
  stubModule("next/headers", { headers: async () => new Headers({ cookie: cookieHeader }) });
  stubModule("next/cache", {
    revalidatePath: () => {},
    revalidateTag: () => {},
    unstable_cache: <T>(fn: T) => fn,
  });

  const admin = await account(true);
  adminId = admin.id;
  adminCookie = admin.cookie;
  learnerA = await account(false);
  learnerB = await account(false);

  courseSlug = `questions-${uid()}`;
  const course = await createCourse({ title: `Questions ${uid()}`, slug: courseSlug });
  courseId = course.id;
  const section = await createSection({ courseId: course.id, title: "Section" });
  lessonSlug = `lesson-${uid()}`;
  const lesson = await createLesson({
    courseId: course.id,
    sectionId: section.id,
    title: "Lesson",
    slug: lessonSlug,
    required: true,
  });
  lessonId = lesson.id;
  previewLessonSlug = `preview-${uid()}`;
  const preview = await createLesson({
    courseId: course.id,
    sectionId: section.id,
    title: "Preview Lesson",
    slug: previewLessonSlug,
    isPreview: true,
    required: true,
  });
  await publishLesson(lesson.id);
  await publishLesson(preview.id);
  await publishCourse(course.id);

  await enrollFree(learnerA.id, course.id);

  actions = await import("../src/features/lesson-questions/actions");
});

test.after(async () => {
  await disposeCloudflareBindings();
});

test("enrolled learner can ask; validation rejects empty and over-long bodies", async () => {
  const row = await askLessonQuestion(learnerA.id, {
    courseSlug,
    lessonSlug,
    body: "Why does this step come first?",
    idempotencyKey: key(),
  });
  assert.equal(row.status, "open");
  assert.equal(row.isPublic, false);
  assert.equal(row.answerBody, null);

  await assert.rejects(
    askLessonQuestion(learnerA.id, { courseSlug, lessonSlug, body: "   ", idempotencyKey: key() }),
    (e: unknown) => e instanceof AppError && e.kind === "invalid",
  );
  await assert.rejects(
    askLessonQuestion(learnerA.id, { courseSlug, lessonSlug, body: "x".repeat(2001), idempotencyKey: key() }),
    (e: unknown) => e instanceof AppError && e.kind === "invalid",
  );
  await assert.rejects(
    askLessonQuestion(learnerA.id, { courseSlug, lessonSlug: "missing", body: "Hello?", idempotencyKey: key() }),
    (e: unknown) => e instanceof AppError && e.kind === "not_found",
  );
});

test("non-enrolled learner and preview reader cannot ask; signed-out is refused", async () => {
  // Learner B holds no enrollment: denied on the regular lesson.
  await assert.rejects(
    askLessonQuestion(learnerB.id, { courseSlug, lessonSlug, body: "Can I ask?", idempotencyKey: key() }),
    (e: unknown) => e instanceof AppError && e.kind === "forbidden",
  );
  // Even on a free-preview lesson, asking requires enrollment.
  await assert.rejects(
    askLessonQuestion(learnerB.id, { courseSlug, lessonSlug: previewLessonSlug, body: "Can I ask?", idempotencyKey: key() }),
    (e: unknown) => e instanceof AppError && e.kind === "forbidden",
  );

  const signedOut = await asUser("", () =>
    actions.askLessonQuestionAction({ courseSlug, lessonSlug, body: "Hello?", idempotencyKey: key() }),
  );
  assert.equal(signedOut.ok, false);
});

test("idempotency: same key replays the row; same key with new content conflicts", async () => {
  const idem = key();
  const first = await askLessonQuestion(learnerA.id, {
    courseSlug,
    lessonSlug,
    body: "Is this idempotent?",
    idempotencyKey: idem,
  });
  const replay = await askLessonQuestion(learnerA.id, {
    courseSlug,
    lessonSlug,
    body: "Is this idempotent?",
    idempotencyKey: idem,
  });
  assert.equal(replay.id, first.id);
  await assert.rejects(
    askLessonQuestion(learnerA.id, { courseSlug, lessonSlug, body: "Different content", idempotencyKey: idem }),
    (e: unknown) => e instanceof AppError && e.kind === "conflict",
  );
});

test("idempotency: concurrent submits with one key save one question", async () => {
  const idem = key();
  const input = { courseSlug, lessonSlug, body: "Double click?", idempotencyKey: idem };
  const [a, b] = await Promise.all([
    askLessonQuestion(learnerA.id, input),
    askLessonQuestion(learnerA.id, input),
  ]);
  assert.equal(a.id, b.id);
  const db = await getDb();
  const rows = await db.select().from(lessonQuestions).where(eq(lessonQuestions.idempotencyKey, idem));
  assert.equal(rows.length, 1);
});

test("daily budget: at most 10 questions per learner per day; replay still works at the cap", async () => {
  const db = await getDb();
  await db.delete(lessonQuestions);
  const keys: string[] = [];
  for (let i = 0; i < 10; i += 1) {
    const k = key();
    keys.push(k);
    await askLessonQuestion(learnerA.id, {
      courseSlug,
      lessonSlug,
      body: `Budget question ${i}`,
      idempotencyKey: k,
    });
  }
  // Retrying a sent key at the cap returns the original row, not a refusal.
  const replay = await askLessonQuestion(learnerA.id, {
    courseSlug,
    lessonSlug,
    body: "Budget question 0",
    idempotencyKey: keys[0]!,
  });
  assert.ok(replay.id);
  await assert.rejects(
    askLessonQuestion(learnerA.id, { courseSlug, lessonSlug, body: "One too many", idempotencyKey: key() }),
    (e: unknown) => e instanceof AppError && e.kind === "invalid",
  );
  // The budget is per learner: learner B (fresh enrollment) can still ask.
  await enrollFree(learnerB.id, courseId);
  const other = await askLessonQuestion(learnerB.id, {
    courseSlug,
    lessonSlug,
    body: "My own first question",
    idempotencyKey: key(),
  });
  assert.equal(other.status, "open");
});

test("privacy: owner sees own; public list is identity-free and excludes private rows", async () => {
  const db = await getDb();
  await db.delete(lessonQuestions);
  const mine = await askLessonQuestion(learnerA.id, {
    courseSlug,
    lessonSlug,
    body: "Private question from A",
    idempotencyKey: key(),
  });
  const other = await askLessonQuestion(learnerB.id, {
    courseSlug,
    lessonSlug,
    body: "Private question from B",
    idempotencyKey: key(),
  });

  // Owner reads are scoped: A never sees B's row and vice versa.
  assert.deepEqual(
    (await listMyLessonQuestions(learnerA.id, lessonId, courseId)).map((r) => r.id),
    [mine.id],
  );
  assert.deepEqual(
    (await listMyLessonQuestions(learnerB.id, lessonId, courseId)).map((r) => r.id),
    [other.id],
  );

  // Nothing public yet.
  assert.deepEqual(await listPublicLessonQuestions(lessonId, learnerA.id), []);

  // Publish A's answer; B's stays private.
  await answerLessonQuestion(adminId, { id: mine.id, answerBody: "Here is the answer.", isPublic: true });

  const pub = await listPublicLessonQuestions(lessonId, learnerB.id);
  assert.equal(pub.length, 1);
  assert.deepEqual(Object.keys(pub[0]!).sort(), ["answerBody", "answeredAt", "body", "id"]);
  assert.equal(pub[0]!.body, "Private question from A");

  // A's own published row is excluded from the public list (it renders under "Your questions").
  assert.deepEqual(await listPublicLessonQuestions(lessonId, learnerA.id), []);
});

test("learner can delete their own question while open; never another learner's, never after answering", async () => {
  const db = await getDb();
  await db.delete(lessonQuestions);
  const mine = await askLessonQuestion(learnerA.id, {
    courseSlug,
    lessonSlug,
    body: "Delete me",
    idempotencyKey: key(),
  });

  // Another learner cannot target this row.
  await assert.rejects(
    deleteMyLessonQuestion(learnerB.id, mine.id),
    (e: unknown) => e instanceof AppError && e.kind === "not_found",
  );

  const deleted = await deleteMyLessonQuestion(learnerA.id, mine.id);
  assert.deepEqual(deleted, { deleted: true });
  assert.equal(await getAdminQuestion(mine.id), null);

  const answered = await askLessonQuestion(learnerA.id, {
    courseSlug,
    lessonSlug,
    body: "Already answered",
    idempotencyKey: key(),
  });
  await answerLessonQuestion(adminId, { id: answered.id, answerBody: "Done.", isPublic: false });
  await assert.rejects(
    deleteMyLessonQuestion(learnerA.id, answered.id),
    (e: unknown) => e instanceof AppError && e.kind === "invalid",
  );
});

test("admin answer / publish / close / reopen with audit and exactly one email", async () => {
  const db = await getDb();
  await db.delete(lessonQuestions);
  await db.delete(emailOutbox);
  await db.delete(adminAuditLog);

  const row = await askLessonQuestion(learnerA.id, {
    courseSlug,
    lessonSlug,
    body: "When is the live session?",
    idempotencyKey: key(),
  });
  assert.equal(await countOpenQuestions(), 1);

  // Non-admin callers are refused and change nothing.
  const denied = await asUser(learnerA.cookie, () =>
    actions.answerLessonQuestionAction({ id: row.id, answerBody: "Soon.", isPublic: false }),
  );
  assert.equal(denied.ok, false);
  assert.equal((await getAdminQuestion(row.id))?.status, "open");

  const answered = await asUser(adminCookie, () =>
    actions.answerLessonQuestionAction({ id: row.id, answerBody: "Next Tuesday.", isPublic: true }),
  );
  assert.equal(answered.ok, true);
  const after = (await getAdminQuestion(row.id))!;
  assert.equal(after.status, "answered");
  assert.equal(after.isPublic, true);
  assert.equal(after.answerBody, "Next Tuesday.");
  assert.equal(await countOpenQuestions(), 0);

  // The learner was emailed exactly once, addressed to them, linking the lesson.
  const mails = await db.select().from(emailOutbox).where(eq(emailOutbox.kind, "question_answered"));
  assert.equal(mails.length, 1);
  assert.equal(mails[0]!.toAddress, learnerA.email);
  assert.equal(mails[0]!.dedupeKey, `question_answered:${row.id}`);
  assert.ok(mails[0]!.subject.includes("was answered"));
  assert.ok(mails[0]!.textBody.includes(`/learn/courses/${courseSlug}/lessons/${lessonSlug}`));

  // Editing the answer later does not queue a second email.
  await asUser(adminCookie, () =>
    actions.answerLessonQuestionAction({ id: row.id, answerBody: "Next Wednesday.", isPublic: true }),
  );
  assert.equal(
    (await db.select().from(emailOutbox).where(eq(emailOutbox.kind, "question_answered"))).length,
    1,
  );

  // Close then reopen through the actions (stale expectations conflict).
  const closed = await asUser(adminCookie, () => actions.closeLessonQuestionAction(row.id, "answered"));
  assert.deepEqual(closed, { ok: true, data: { id: row.id, status: "closed" } });
  const stale = await asUser(adminCookie, () => actions.closeLessonQuestionAction(row.id, "answered"));
  assert.equal(stale.ok, false);
  const reopened = await asUser(adminCookie, () => actions.reopenLessonQuestionAction(row.id, "closed"));
  assert.deepEqual(reopened, { ok: true, data: { id: row.id, status: "open" } });
  const invalid = await asUser(adminCookie, () => actions.reopenLessonQuestionAction(row.id, "answered"));
  assert.equal(invalid.ok, false);

  // Audit rows carry bare facts only — never bodies, names or emails.
  const audits = await db
    .select()
    .from(adminAuditLog)
    .where(and(eq(adminAuditLog.entityType, "lesson_question"), eq(adminAuditLog.entityId, row.id)));
  assert.deepEqual(audits.map((r) => r.action).sort(), ["question.answer", "question.answer", "question.close", "question.reopen"]);
  for (const entry of audits) {
    assert.equal(entry.actorId, adminId);
    const payload = entry.details ?? "";
    assert.ok(!payload.includes("Wednesday"), "no answer body in audit");
    assert.ok(!payload.includes("live session"), "no question body in audit");
    assert.ok(!payload.includes(learnerA.email), "no email in audit");
  }

  // Answer validation and missing rows return results, not throws.
  const emptyAnswer = await asUser(adminCookie, () =>
    actions.answerLessonQuestionAction({ id: row.id, answerBody: "   ", isPublic: false }),
  );
  assert.equal(emptyAnswer.ok, false);
  const missing = await asUser(adminCookie, () =>
    actions.answerLessonQuestionAction({ id: "lq_missing", answerBody: "Hi.", isPublic: false }),
  );
  assert.equal(missing.ok, false);
});

test("service transitions: only open/answered -> closed and closed -> open", async () => {
  const db = await getDb();
  await db.delete(lessonQuestions);
  const row = await askLessonQuestion(learnerA.id, {
    courseSlug,
    lessonSlug,
    body: "Transition check",
    idempotencyKey: key(),
  });
  await assert.rejects(
    transitionQuestionStatus({ id: row.id, from: "closed", to: "open" }),
    (e: unknown) => e instanceof AppError && e.kind === "conflict",
  );
  await assert.rejects(
    transitionQuestionStatus({ id: row.id, from: "open", to: "open" }),
    (e: unknown) => e instanceof AppError && e.kind === "invalid",
  );
  const closed = await transitionQuestionStatus({ id: row.id, from: "open", to: "closed" });
  assert.equal(closed.status, "closed");
  await assert.rejects(
    answerLessonQuestion(adminId, { id: row.id, answerBody: "Too late.", isPublic: false }),
    (e: unknown) => e instanceof AppError && e.kind === "invalid",
  );
});

test("inbox lists open first, filters by status and course, paginates at 25", async () => {
  const db = await getDb();
  await db.delete(lessonQuestions);
  for (let i = 0; i < 27; i += 1) {
    await db.insert(lessonQuestions).values({
      id: `lq_seed_${i}_${uid()}`,
      lessonId,
      courseId,
      userId: learnerA.id,
      body: `Seed question ${i}`,
      status: "open",
      answerBody: null,
      answeredAt: null,
      answeredBy: null,
      isPublic: false,
      idempotencyKey: `seed-${i}-${uid()}`,
      createdAt: new Date(Date.UTC(2026, 0, 2, 0, 0, i)),
      updatedAt: new Date(Date.UTC(2026, 0, 2, 0, 0, i)),
    });
  }
  const answeredSeed = `lq_answered_${uid()}`;
  await db.insert(lessonQuestions).values({
    id: answeredSeed,
    lessonId,
    courseId,
    userId: learnerA.id,
    body: "Seed answered",
    status: "answered",
    answerBody: "Yes.",
    answeredAt: new Date(),
    answeredBy: adminId,
    isPublic: false,
    idempotencyKey: `seed-answered-${uid()}`,
    createdAt: new Date(Date.UTC(2026, 0, 3)),
    updatedAt: new Date(Date.UTC(2026, 0, 3)),
  });

  const page1 = await listAdminQuestions({});
  assert.equal(page1.total, 28);
  assert.equal(page1.pageCount, 2);
  assert.equal(page1.rows.length, 25);
  assert.ok(page1.rows.every((r) => r.status === "open"), "open rows first");
  // The Studio projection carries learner identity (admin-only surface).
  assert.equal(page1.rows[0]!.learnerEmail, learnerA.email);

  const page2 = await listAdminQuestions({ page: 99 });
  assert.equal(page2.page, 2);
  assert.equal(page2.rows.length, 3);
  assert.equal(page2.rows[2]!.status, "answered", "answered sorts after open");

  const onlyAnswered = await listAdminQuestions({ status: "answered" });
  assert.deepEqual(onlyAnswered.rows.map((r) => r.id), [answeredSeed]);
  assert.equal((await listAdminQuestions({ status: "bogus" })).total, 28, "invalid status ignored");
  assert.equal((await listAdminQuestions({ courseId: "course_missing" })).total, 0);
});

test("leaving a course keeps questions but blocks new ones until re-enrollment", async () => {
  const db = await getDb();
  await db.delete(lessonQuestions);
  const row = await askLessonQuestion(learnerA.id, {
    courseSlug,
    lessonSlug,
    body: "Kept after leaving?",
    idempotencyKey: key(),
  });
  await cancelMyEnrollment(learnerA.id, courseId);
  assert.ok(await getAdminQuestion(row.id), "question row survives the leave");
  await assert.rejects(
    askLessonQuestion(learnerA.id, { courseSlug, lessonSlug, body: "After leaving", idempotencyKey: key() }),
    (e: unknown) => e instanceof AppError && e.kind === "forbidden",
  );
});

test("people profile includes the person's questions in the timeline", async () => {
  await asUser(adminCookie, async () => {
    const profile = await getPersonProfile(learnerA.id);
    assert.ok(profile, "profile exists");
    assert.ok(profile.questions.length >= 1);
    const kinds = profile.timeline.map((item) => item.kind);
    assert.ok(kinds.includes("question"));
    const entry = profile.timeline.find((item) => item.kind === "question")!;
    assert.ok(entry.label.includes("Question on"));
    assert.ok(entry.href?.startsWith("/admin/questions/"));
  });
});

test("cancelled enrollment hides nothing from the admin inbox", async () => {
  const db = await getDb();
  const status = await db
    .select({ status: enrollments.status })
    .from(enrollments)
    .where(and(eq(enrollments.userId, learnerA.id), eq(enrollments.courseId, courseId)))
    .get();
  assert.equal(status?.status, "cancelled");
  const inbox = await listAdminQuestions({});
  assert.ok(inbox.total >= 1);
});
