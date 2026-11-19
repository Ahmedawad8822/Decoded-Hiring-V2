/**
 * LESSON QUIZ DOMAIN TESTS
 * ---------------------------------------------------------------------------
 * - schema caps / correct-count / duplicate-id rules;
 * - pure grading edge cases;
 * - learner projection never carries answers or explanations;
 * - submit authorization matrix; 5 s flood control; auto-complete on pass;
 * - requirePass completion gate + non-retroactive completion policy;
 * - course completion and certificate eligibility gated by the pass;
 * - admin-only upsert/delete with content-free audit.
 *
 * Runs through tsx via `npm test` (no Playwright).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { and, desc, eq } from "drizzle-orm";
import "./helpers/env"; // MUST be first: fake TEST-ONLY secret before any app module.

import { adminAuditLog, enrollments, getDb, lessonProgress, quizAttempts, users } from "../src/lib/db";
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
import { enrollFree } from "../src/features/enrollments/service";
import {
  completeLessonAndContinue,
  getEnrollmentProgress,
  isLessonComplete,
  markLessonComplete,
} from "../src/features/progress/service";
import { getCourseCompletionState } from "../src/features/progress/completion";
import { claimCertificate } from "../src/features/certificates/service";
import { gradeQuiz } from "../src/features/quizzes/grading";
import {
  deleteLessonQuiz,
  getLearnerQuizForLesson,
  getLessonQuiz,
  submitQuizAttempt,
  upsertLessonQuiz,
} from "../src/features/quizzes/service";
import {
  quizAnswersSchema,
  quizQuestionsSchema,
  toLearnerQuiz,
  type QuizDefinition,
  type QuizQuestion,
} from "../src/features/quizzes/types";

process.env.ADMIN_REQUIRE_2FA = "false";

const nodeRequire = createRequire(__filename);
const uid = () => crypto.randomUUID().slice(0, 10);
let cookieHeader = "";
let learnerCookie = "";
let adminCookie = "";
let learnerId = "";
let adminId = "";
let actions: typeof import("../src/features/quizzes/actions");

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
  const email = `quiz-${uid()}@example.test`;
  const password = `Fixture-${crypto.randomUUID()}`;
  const created = await auth.api.signUpEmail({ body: { email, password, name: "Quiz Learner" } });
  if (admin) {
    await (await getDb()).update(users).set({ role: "admin" }).where(eq(users.id, created.user.id));
  }
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
  const learner = await account(false);
  learnerId = learner.id;
  learnerCookie = learner.cookie;
  const admin = await account(true);
  adminId = admin.id;
  adminCookie = admin.cookie;
  actions = await import("../src/features/quizzes/actions");
});

test.after(async () => {
  await disposeCloudflareBindings();
});

async function makeCourse(options: { preview?: boolean; certificate?: boolean } = {}) {
  const course = await createCourse({
    title: "Quiz course",
    slug: `quiz-course-${uid()}`,
    certificateEnabled: options.certificate ?? false,
  });
  const section = await createSection({ courseId: course.id, title: "Quiz section" });
  const lesson = await createLesson({
    courseId: course.id,
    sectionId: section.id,
    title: "Quiz lesson",
    slug: `quiz-lesson-${uid()}`,
    required: true,
    isPreview: options.preview ?? false,
  });
  await publishLesson(lesson.id);
  await publishCourse(course.id);
  return { course, section, lesson };
}

function quizInput(lessonId: string, overrides: { requirePass?: boolean; passPercent?: number } = {}) {
  return {
    lessonId,
    passPercent: overrides.passPercent ?? 70,
    requirePass: overrides.requirePass ?? true,
    questions: [
      {
        id: "input-q1",
        prompt: "Single choice prompt",
        kind: "single" as const,
        options: [
          { id: "input-a", text: "Alpha" },
          { id: "input-b", text: "Beta" },
        ],
        correctOptionIds: ["input-a"],
        explanation: "Alpha is correct because it is first.",
      },
      {
        id: "input-q2",
        prompt: "Multiple choice prompt",
        kind: "multiple" as const,
        options: [
          { id: "input-c", text: "Charlie" },
          { id: "input-d", text: "Delta" },
          { id: "input-e", text: "Echo" },
        ],
        correctOptionIds: ["input-c", "input-e"],
        explanation: "Charlie and Echo are both required.",
      },
    ],
  };
}

async function makeQuiz(
  lessonId: string,
  overrides: { requirePass?: boolean; passPercent?: number } = {},
): Promise<QuizDefinition> {
  return upsertLessonQuiz(quizInput(lessonId, overrides));
}

function allCorrect(quiz: QuizDefinition) {
  return Object.fromEntries(quiz.questions.map((question) => [question.id, [...question.correctOptionIds]]));
}

function allWrong(quiz: QuizDefinition) {
  return Object.fromEntries(quiz.questions.map((question) => [question.id, []]));
}

async function clearThrottle(userId: string, quizId: string) {
  const db = await getDb();
  await db
    .update(quizAttempts)
    .set({ createdAt: new Date(Date.now() - 6000) })
    .where(and(eq(quizAttempts.userId, userId), eq(quizAttempts.quizId, quizId)));
}

function baseQuestion(): QuizQuestion {
  return {
    id: "q1",
    prompt: "Prompt",
    kind: "single",
    options: [
      { id: "o1", text: "One" },
      { id: "o2", text: "Two" },
    ],
    correctOptionIds: ["o1"],
  };
}

// ---------------------------------------------------------------- schema rules

test("quiz schema accepts valid single/multiple questions", () => {
  assert.equal(quizQuestionsSchema.safeParse([baseQuestion()]).success, true);
  assert.equal(
    quizQuestionsSchema.safeParse([
      { ...baseQuestion(), kind: "multiple", correctOptionIds: ["o1", "o2"] },
    ]).success,
    true,
  );
});

test("quiz schema enforces caps for questions, options, prompt, option text and explanation", () => {
  const tooManyQuestions = Array.from({ length: 31 }, (_, index) => ({
    ...baseQuestion(),
    id: `q${index}`,
  }));
  assert.equal(quizQuestionsSchema.safeParse(tooManyQuestions).success, false);
  assert.equal(quizQuestionsSchema.safeParse([]).success, false);
  assert.equal(
    quizQuestionsSchema.safeParse([{ ...baseQuestion(), options: [baseQuestion().options[0]] }]).success,
    false,
  );
  assert.equal(
    quizQuestionsSchema.safeParse([
      { ...baseQuestion(), options: Array.from({ length: 9 }, (_, index) => ({ id: `o${index}`, text: `O${index}` })) },
    ]).success,
    false,
  );
  assert.equal(quizQuestionsSchema.safeParse([{ ...baseQuestion(), prompt: "x".repeat(501) }]).success, false);
  assert.equal(
    quizQuestionsSchema.safeParse([
      { ...baseQuestion(), options: [{ id: "o1", text: "x".repeat(201) }, baseQuestion().options[1]] },
    ]).success,
    false,
  );
  assert.equal(
    quizQuestionsSchema.safeParse([{ ...baseQuestion(), explanation: "x".repeat(1001) }]).success,
    false,
  );
});

test("quiz schema enforces correct-count rules and unique ids", () => {
  assert.equal(
    quizQuestionsSchema.safeParse([{ ...baseQuestion(), correctOptionIds: ["o1", "o2"] }]).success,
    false,
    "single choice needs exactly one correct option",
  );
  assert.equal(
    quizQuestionsSchema.safeParse([{ ...baseQuestion(), kind: "multiple", correctOptionIds: ["o1", "o2"] }]).success,
    true,
  );
  assert.equal(
    quizQuestionsSchema.safeParse([{ ...baseQuestion(), kind: "multiple", correctOptionIds: [] }]).success,
    false,
    "multiple choice needs at least one correct option",
  );
  assert.equal(
    quizQuestionsSchema.safeParse([{ ...baseQuestion(), correctOptionIds: ["o9"] }]).success,
    false,
    "correct option must exist",
  );
  assert.equal(
    quizQuestionsSchema.safeParse([
      { ...baseQuestion(), options: [baseQuestion().options[0], baseQuestion().options[0]] },
    ]).success,
    false,
    "option ids unique within a question",
  );
  assert.equal(
    quizQuestionsSchema.safeParse([baseQuestion(), { ...baseQuestion() }]).success,
    false,
    "question ids unique within a quiz",
  );
});

test("answer payload validation bounds shape and size", () => {
  assert.equal(quizAnswersSchema.safeParse({ q1: ["o1"] }).success, true);
  assert.equal(quizAnswersSchema.safeParse({ q1: ["o1", "o2"] }).success, true);
  assert.equal(quizAnswersSchema.safeParse({ q1: "o1" }).success, false);
  assert.equal(quizAnswersSchema.safeParse({ q1: Array.from({ length: 9 }, (_, i) => `o${i}`) }).success, false);
  assert.equal(quizAnswersSchema.safeParse({ "": ["o1"] }).success, false);
  const tooMany = Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`q${i}`, []]));
  assert.equal(quizAnswersSchema.safeParse(tooMany).success, false);
});

// ---------------------------------------------------------------- grading

test("grading uses exact-set semantics for single and multiple questions", () => {
  const single = baseQuestion();
  const multiple: QuizQuestion = {
    ...baseQuestion(),
    id: "q2",
    kind: "multiple",
    correctOptionIds: ["o1", "o2"],
  };
  const result = gradeQuiz(
    [single, multiple],
    { q1: ["o1"], q2: ["o1"] },
    70,
  );
  assert.equal(result.correctCount, 1, "multiple choice is all-or-nothing");
  assert.equal(result.scorePercent, 50);
  assert.equal(result.passed, false);
  assert.deepEqual(result.questions[1].correctOptionIds, ["o1", "o2"]);
});

test("grading ignores unknown ids and counts missing answers as wrong", () => {
  const quiz = [baseQuestion()];
  assert.equal(gradeQuiz(quiz, {}, 0).correctCount, 0);
  assert.equal(gradeQuiz(quiz, { q1: ["unknown"] }, 0).correctCount, 0);
  assert.equal(gradeQuiz(quiz, { q1: ["o1", "unknown"] }, 0).correctCount, 1);
  assert.equal(gradeQuiz(quiz, { q1: ["o1", "o2"] }, 0).correctCount, 0, "extra known option makes the set wrong");
  assert.equal(gradeQuiz(quiz, { q1: ["o1", "o1"] }, 0).correctCount, 1, "set semantics ignore duplicate selections");
  assert.equal(gradeQuiz(quiz, { other: ["o1"], q1: ["o1"] }, 0).correctCount, 1);
});

test("grading rounds percentages and applies the pass mark", () => {
  const questions: QuizQuestion[] = Array.from({ length: 3 }, (_, index) => ({
    ...baseQuestion(),
    id: `q${index}`,
  }));
  const answers = { q0: ["o1"], q1: ["o1"], q2: [] };
  const sixtySeven = gradeQuiz(questions, answers, 67);
  assert.equal(sixtySeven.scorePercent, 67);
  assert.equal(sixtySeven.passed, true);
  assert.equal(gradeQuiz(questions, answers, 68).passed, false);
});

test("grading exposes per-question feedback with answers and explanations", () => {
  const question = { ...baseQuestion(), explanation: "Because." };
  const result = gradeQuiz([question], { q1: ["o2"] }, 100);
  assert.deepEqual(result.questions[0], {
    id: "q1",
    correct: false,
    correctOptionIds: ["o1"],
    explanation: "Because.",
  });
});

// ---------------------------------------------------------------- projection

test("the learner projection omits correct answers and explanations", async () => {
  const { lesson } = await makeCourse();
  const quiz = await makeQuiz(lesson.id, { requirePass: true });
  const projected = toLearnerQuiz(quiz);
  const serialized = JSON.stringify(projected);
  assert.ok(!serialized.includes("correctOptionIds"));
  assert.ok(!serialized.includes("explanation"));
  assert.ok(!serialized.includes("Alpha is correct"));
  assert.ok(!serialized.includes("Charlie and Echo"));
  assert.equal(projected.questions.length, 2);
  assert.equal(projected.questions[0].options.length, 2);

  const fromService = await getLearnerQuizForLesson(lesson.id);
  assert.equal(fromService?.id, quiz.id);
  assert.ok(!JSON.stringify(fromService).includes("correctOptionIds"));
});

// ---------------------------------------------------------------- authorization

test("submit authorization matrix: signed out, unenrolled, preview, cancelled, enrolled", async () => {
  const { course, lesson } = await makeCourse();
  const quiz = await makeQuiz(lesson.id, { requirePass: false });
  const answers = allCorrect(quiz);

  cookieHeader = "";
  const signedOut = await actions.submitQuizAttemptAction({
    courseSlug: course.slug,
    lessonSlug: lesson.slug,
    answers,
  });
  assert.equal(signedOut.ok, false, "signed-out submissions are refused");

  await assert.rejects(
    () => submitQuizAttempt(adminId, { courseSlug: course.slug, lessonSlug: lesson.slug, answers }),
    /Enroll in this course/,
    "unenrolled users are refused",
  );

  const preview = await makeCourse({ preview: true });
  const previewQuiz = await makeQuiz(preview.lesson.id, { requirePass: false });
  await assert.rejects(
    () => submitQuizAttempt(adminId, {
      courseSlug: preview.course.slug,
      lessonSlug: preview.lesson.slug,
      answers: allCorrect(previewQuiz),
    }),
    /Enroll in this course/,
    "preview-only readers are refused",
  );

  const cancelledFixture = await makeCourse();
  const cancelledQuiz = await makeQuiz(cancelledFixture.lesson.id, { requirePass: false });
  const cancelledEnrollment = await enrollFree(learnerId, cancelledFixture.course.id);
  await (await getDb()).update(enrollments).set({ status: "cancelled" }).where(eq(enrollments.id, cancelledEnrollment.id));
  await assert.rejects(
    () => submitQuizAttempt(learnerId, {
      courseSlug: cancelledFixture.course.slug,
      lessonSlug: cancelledFixture.lesson.slug,
      answers: allCorrect(cancelledQuiz),
    }),
    /Enroll in this course/,
    "cancelled enrollments are refused",
  );

  await enrollFree(learnerId, course.id);
  const enrolled = await submitQuizAttempt(learnerId, {
    courseSlug: course.slug,
    lessonSlug: lesson.slug,
    answers,
  });
  assert.equal(enrolled.passed, true);
  assert.equal(enrolled.lessonCompleted, true);
});

// ---------------------------------------------------------------- throttle

test("a second attempt within 5 s is rejected; later attempts are allowed", async () => {
  const { course, lesson } = await makeCourse();
  const quiz = await makeQuiz(lesson.id, { requirePass: false });
  await enrollFree(learnerId, course.id);
  const answers = allCorrect(quiz);

  await submitQuizAttempt(learnerId, { courseSlug: course.slug, lessonSlug: lesson.slug, answers });
  await assert.rejects(
    () => submitQuizAttempt(learnerId, { courseSlug: course.slug, lessonSlug: lesson.slug, answers }),
    /wait a few seconds/,
  );

  await clearThrottle(learnerId, quiz.id);
  const later = await submitQuizAttempt(learnerId, { courseSlug: course.slug, lessonSlug: lesson.slug, answers });
  assert.equal(later.passed, true);
});

// ---------------------------------------------------------------- completion

test("a passing attempt auto-completes the lesson; a failing one does not", async () => {
  const { course, lesson } = await makeCourse();
  const quiz = await makeQuiz(lesson.id, { requirePass: true, passPercent: 70 });
  const enrollment = await enrollFree(learnerId, course.id);
  assert.equal(await isLessonComplete(enrollment.id, lesson.id), false);

  const failed = await submitQuizAttempt(learnerId, {
    courseSlug: course.slug,
    lessonSlug: lesson.slug,
    answers: allWrong(quiz),
  });
  assert.equal(failed.passed, false);
  assert.equal(failed.lessonCompleted, false);
  assert.equal(await isLessonComplete(enrollment.id, lesson.id), false);

  await clearThrottle(learnerId, quiz.id);
  const passed = await submitQuizAttempt(learnerId, {
    courseSlug: course.slug,
    lessonSlug: lesson.slug,
    answers: allCorrect(quiz),
  });
  assert.equal(passed.passed, true);
  assert.equal(passed.lessonCompleted, true);
  assert.equal(passed.nextHref, `/learn/courses/${course.slug}/complete`);
  assert.equal(await isLessonComplete(enrollment.id, lesson.id), true);
});

test("requirePass gates manual completion until a passing attempt exists", async () => {
  const { course, lesson } = await makeCourse();
  const quiz = await makeQuiz(lesson.id, { requirePass: true });
  const enrollment = await enrollFree(learnerId, course.id);

  await assert.rejects(
    () => markLessonComplete(learnerId, enrollment.id, lesson.id),
    /Pass the quiz/,
    "manual completion is blocked before the pass",
  );
  await assert.rejects(
    () => completeLessonAndContinue(learnerId, enrollment.id, lesson.id),
    /Pass the quiz/,
  );
  assert.equal(await isLessonComplete(enrollment.id, lesson.id), false);

  await submitQuizAttempt(learnerId, {
    courseSlug: course.slug,
    lessonSlug: lesson.slug,
    answers: allCorrect(quiz),
  });
  const repeat = await markLessonComplete(learnerId, enrollment.id, lesson.id);
  assert.equal(repeat.alreadyComplete, true);
});

test("requirePass=false allows manual completion without an attempt", async () => {
  const { course, lesson } = await makeCourse();
  await makeQuiz(lesson.id, { requirePass: false });
  const enrollment = await enrollFree(learnerId, course.id);
  const result = await markLessonComplete(learnerId, enrollment.id, lesson.id);
  assert.equal(result.alreadyComplete, false);
  assert.equal(await isLessonComplete(enrollment.id, lesson.id), true);
});

test("adding a quiz or enabling requirePass never revokes an existing completion", async () => {
  const { course, lesson } = await makeCourse();
  const enrollment = await enrollFree(learnerId, course.id);
  await markLessonComplete(learnerId, enrollment.id, lesson.id);
  assert.equal((await getEnrollmentProgress(enrollment)).completed, true);

  await makeQuiz(lesson.id, { requirePass: true });
  const progress = await getEnrollmentProgress(enrollment);
  assert.equal(progress.completed, true, "existing completion stands after the quiz is added");

  const repeat = await markLessonComplete(learnerId, enrollment.id, lesson.id);
  assert.equal(repeat.alreadyComplete, true, "idempotent completion is not re-gated");

  const state = await getCourseCompletionState(learnerId, course.slug);
  assert.equal(state.kind, "complete");
});

test("course completion and certificate eligibility stay blocked until the quiz is passed", async () => {
  const { course, lesson } = await makeCourse({ certificate: true });
  const quiz = await makeQuiz(lesson.id, { requirePass: true });
  await enrollFree(learnerId, course.id);

  assert.equal((await getCourseCompletionState(learnerId, course.slug)).kind, "incomplete");
  await assert.rejects(
    () => claimCertificate(learnerId, course.slug, "Quiz Learner"),
    /Complete this course/,
  );

  await submitQuizAttempt(learnerId, {
    courseSlug: course.slug,
    lessonSlug: lesson.slug,
    answers: allCorrect(quiz),
  });
  assert.equal((await getCourseCompletionState(learnerId, course.slug)).kind, "complete");
  const certificate = await claimCertificate(learnerId, course.slug, "Quiz Learner");
  assert.equal(certificate.courseId, course.id);
});

// ---------------------------------------------------------------- studio / audit

test("only admins can save or delete a quiz; audits record counts but no content", async () => {
  const { course, lesson } = await makeCourse();
  const payload = quizInput(lesson.id, { requirePass: true, passPercent: 80 });
  payload.questions[0].prompt = "SECRET_PROMPT_TEXT";

  cookieHeader = learnerCookie;
  assert.equal((await actions.saveQuizAction(payload)).ok, false, "learner save is refused");
  assert.equal((await actions.deleteQuizAction({ lessonId: lesson.id })).ok, false, "learner delete is refused");

  cookieHeader = adminCookie;
  const saved = await actions.saveQuizAction(payload);
  assert.equal(saved.ok, true, JSON.stringify(saved));
  assert.ok(saved.data?.id);
  const quiz = await getLessonQuiz(lesson.id);
  assert.ok(quiz);

  const db = await getDb();
  const upsertAudit = await db
    .select()
    .from(adminAuditLog)
    .where(and(eq(adminAuditLog.action, "quiz.upsert"), eq(adminAuditLog.entityId, quiz!.id)))
    .get();
  assert.ok(upsertAudit);
  assert.equal(upsertAudit!.actorId, adminId);
  const upsertDetails = JSON.parse(upsertAudit!.details!);
  assert.deepEqual(
    { questionCount: upsertDetails.questionCount, passPercent: upsertDetails.passPercent, requirePass: upsertDetails.requirePass },
    { questionCount: 2, passPercent: 80, requirePass: true },
  );
  assert.ok(!JSON.stringify(upsertDetails).includes("SECRET_PROMPT_TEXT"), "audit never stores question content");
  assert.ok(!JSON.stringify(upsertDetails).includes("Alpha"));

  // Edits preserve existing question and option ids.
  const edited = await actions.saveQuizAction({
    lessonId: lesson.id,
    passPercent: 90,
    requirePass: false,
    questions: quiz!.questions.map((question) => ({
      id: question.id,
      prompt: `${question.prompt} edited`,
      kind: question.kind,
      options: question.options.map((option) => ({ id: option.id, text: option.text })),
      correctOptionIds: question.correctOptionIds,
      explanation: question.explanation,
    })),
  });
  assert.equal(edited.ok, true);
  const afterEdit = await getLessonQuiz(lesson.id);
  assert.deepEqual(
    afterEdit!.questions.map((question) => question.id),
    quiz!.questions.map((question) => question.id),
  );
  assert.deepEqual(
    afterEdit!.questions.map((question) => question.options.map((option) => option.id)),
    quiz!.questions.map((question) => question.options.map((option) => option.id)),
  );

  // Create an attempt, then delete through the admin action: attempts cascade.
  await enrollFree(learnerId, course.id);
  await submitQuizAttempt(learnerId, {
    courseSlug: course.slug,
    lessonSlug: lesson.slug,
    answers: allCorrect(afterEdit!),
  });
  assert.ok((await db.select().from(quizAttempts).where(eq(quizAttempts.quizId, quiz!.id))).length > 0);

  const deleted = await actions.deleteQuizAction({ lessonId: lesson.id });
  assert.equal(deleted.ok, true, JSON.stringify(deleted));
  assert.equal(await getLessonQuiz(lesson.id), null);
  assert.equal((await db.select().from(quizAttempts).where(eq(quizAttempts.quizId, quiz!.id))).length, 0);
  const deleteAudit = await db
    .select()
    .from(adminAuditLog)
    .where(and(eq(adminAuditLog.action, "quiz.delete"), eq(adminAuditLog.entityId, quiz!.id)))
    .orderBy(desc(adminAuditLog.createdAt))
    .get();
  assert.ok(deleteAudit);
  assert.equal(deleteAudit!.actorId, adminId);
});

test("service-level delete removes the quiz and its attempts", async () => {
  const { lesson } = await makeCourse();
  const quiz = await makeQuiz(lesson.id, { requirePass: false });
  const deleted = await deleteLessonQuiz(lesson.id);
  assert.equal(deleted.id, quiz.id);
  assert.equal(await getLessonQuiz(lesson.id), null);
});

test("lesson progress rows stay intact for lessons without quizzes", async () => {
  const { course, lesson } = await makeCourse();
  const enrollment = await enrollFree(learnerId, course.id);
  const result = await markLessonComplete(learnerId, enrollment.id, lesson.id);
  assert.equal(result.alreadyComplete, false);
  const db = await getDb();
  assert.equal(
    (await db.select().from(lessonProgress).where(eq(lessonProgress.lessonId, lesson.id))).length,
    1,
  );
});
