import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  getDb,
  courseSections,
  learnerTags,
  lessonQuizzes,
  quizAttempts,
  type Database,
  type Lesson,
  type LessonQuiz,
} from "@/lib/db";
import {
  getAdminLessonById,
  getLearnerCourseBySlug,
  getPublishedLessonBySlug,
} from "@/features/courses/service";
import { getLessonReadAccess } from "@/features/courses/lesson-access";
import { isLessonReleased } from "@/features/courses/release";
import { getEnrollment } from "@/features/enrollments/service";
import { hasLearnerAccess } from "@/features/enrollments/access";
import {
  completeLessonAndContinue,
  getEnrollmentProgress,
  getLessonContinuationHref,
  isLessonComplete,
} from "@/features/progress/service";
import { AppError } from "@/lib/errors";
import { gradeQuiz } from "./grading";
import {
  QUIZ_THROTTLE_MS,
  parseQuizQuestions,
  quizAnswersSchema,
  quizQuestionsSchema,
  serializeQuizQuestions,
  toLearnerQuiz,
  type LearnerQuiz,
  type LearnerQuizStats,
  type QuizAnswers,
  type QuizAttemptResult,
  type QuizDefinition,
  type QuizQuestion,
  type SaveQuizInput,
} from "./types";

// ============================================================================
// QUIZ SERVICE
// ----------------------------------------------------------------------------
// All answer-bearing data is resolved here on the server. Public learner reads
// use LearnerQuiz projections; admin reads use full QuizDefinition objects.
// ============================================================================

function newQuizKey(prefix: "quiz" | "q" | "o" | "attempt"): string {
  return `${prefix}_${crypto.randomUUID().slice(0, 12)}`;
}

function mapQuizRow(row: LessonQuiz): QuizDefinition {
  return {
    id: row.id,
    courseId: row.courseId,
    lessonId: row.lessonId,
    passPercent: row.passPercent,
    requirePass: row.requirePass,
    questions: parseQuizQuestions(row.questions) ?? [],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function getLessonQuiz(lessonId: string): Promise<QuizDefinition | null> {
  const db = await getDb();
  const row = await db
    .select()
    .from(lessonQuizzes)
    .where(eq(lessonQuizzes.lessonId, lessonId))
    .get();
  return row ? mapQuizRow(row) : null;
}

/** Learner-safe projection — never includes correctOptionIds or explanation. */
export async function getLearnerQuizForLesson(lessonId: string): Promise<LearnerQuiz | null> {
  const quiz = await getLessonQuiz(lessonId);
  if (!quiz || quiz.questions.length === 0) return null;
  return toLearnerQuiz(quiz);
}

/** One batched query per page for curriculum "Quiz" type hints. */
export async function getQuizLessonIds(courseId: string): Promise<Set<string>> {
  const db = await getDb();
  const rows = await db
    .select({ lessonId: lessonQuizzes.lessonId })
    .from(lessonQuizzes)
    .where(eq(lessonQuizzes.courseId, courseId));
  return new Set(rows.map((row) => row.lessonId));
}

/** Batched lookup when callers already hold lesson ids (chunked for D1). */
export async function getQuizzesByLessonIds(
  lessonIds: string[],
): Promise<Map<string, QuizDefinition>> {
  const out = new Map<string, QuizDefinition>();
  if (lessonIds.length === 0) return out;
  const db = await getDb();
  for (let index = 0; index < lessonIds.length; index += 90) {
    const rows = await db
      .select()
      .from(lessonQuizzes)
      .where(inArray(lessonQuizzes.lessonId, lessonIds.slice(index, index + 90)));
    for (const row of rows) out.set(row.lessonId, mapQuizRow(row));
  }
  return out;
}

/** Full quiz data for the Studio editor (one query per course). */
export async function listCourseQuizzes(courseId: string): Promise<QuizDefinition[]> {
  const db = await getDb();
  const rows = await db
    .select()
    .from(lessonQuizzes)
    .where(eq(lessonQuizzes.courseId, courseId));
  return rows.map(mapQuizRow);
}

/** Best score + attempt count + passed flag in ONE aggregate query. */
export async function getLearnerQuizStats(
  userId: string,
  quizId: string,
): Promise<LearnerQuizStats> {
  const db = await getDb();
  const row = await db
    .select({
      attemptCount: sql<number>`count(*)`,
      bestScore: sql<number | null>`max(${quizAttempts.scorePercent})`,
      passedCount: sql<number>`coalesce(sum(case when ${quizAttempts.passed} = 1 then 1 else 0 end), 0)`,
    })
    .from(quizAttempts)
    .where(and(eq(quizAttempts.userId, userId), eq(quizAttempts.quizId, quizId)))
    .get();

  const attemptCount = Number(row?.attemptCount ?? 0);
  return {
    bestScore: attemptCount > 0 ? Number(row?.bestScore ?? 0) : null,
    attemptCount,
    passed: Number(row?.passedCount ?? 0) > 0,
  };
}

export interface CourseQuizStats {
  attemptedLearners: number;
  passedLearners: number;
  passRate: number;
}

/** ONE aggregate query per course for Studio results summaries. */
export async function getCourseQuizStats(courseId: string): Promise<Map<string, CourseQuizStats>> {
  const db = await getDb();
  const rows = await db
    .select({
      quizId: lessonQuizzes.id,
      attemptedLearners: sql<number>`count(distinct ${quizAttempts.userId})`,
      passedLearners: sql<number>`count(distinct case when ${quizAttempts.passed} = 1 then ${quizAttempts.userId} end)`,
    })
    .from(lessonQuizzes)
    .leftJoin(quizAttempts, eq(quizAttempts.quizId, lessonQuizzes.id))
    .where(eq(lessonQuizzes.courseId, courseId))
    .groupBy(lessonQuizzes.id);

  return new Map(
    rows.map((row) => {
      const attemptedLearners = Number(row.attemptedLearners);
      const passedLearners = Number(row.passedLearners);
      return [
        row.quizId,
        {
          attemptedLearners,
          passedLearners,
          passRate: attemptedLearners > 0 ? Math.round((passedLearners / attemptedLearners) * 100) : 0,
        },
      ];
    }),
  );
}

function buildAdminQuestions(
  input: SaveQuizInput["questions"],
  existingQuestions: QuizQuestion[] | null,
): QuizQuestion[] {
  const existingQuestionIds = new Set(existingQuestions?.map((question) => question.id) ?? []);
  const existingOptionIds = new Set(
    existingQuestions?.flatMap((question) => question.options.map((option) => option.id)) ?? [],
  );
  const usedQuestionIds = new Set<string>();

  const questions = input.map((question) => {
    let questionId =
      question.id && existingQuestionIds.has(question.id) ? question.id : newQuizKey("q");
    while (usedQuestionIds.has(questionId)) questionId = newQuizKey("q");
    usedQuestionIds.add(questionId);

    const usedOptionIds = new Set<string>();
    const optionIdMap = new Map<string, string>();
    const options = question.options.map((option) => {
      let optionId =
        option.id && existingOptionIds.has(option.id) ? option.id : newQuizKey("o");
      while (usedOptionIds.has(optionId)) optionId = newQuizKey("o");
      usedOptionIds.add(optionId);
      if (option.id) optionIdMap.set(option.id, optionId);
      return { id: optionId, text: option.text, ...(option.tag ? { tag: option.tag } : {}) };
    });

    const correctOptionIds = question.correctOptionIds.map((inputId) => {
      const mapped = optionIdMap.get(inputId);
      if (!mapped) {
        throw new AppError(
          "invalid",
          "A correct option must reference an option in the same question.",
        );
      }
      return mapped;
    });

    const explanation = question.explanation?.trim();
    return {
      id: questionId,
      prompt: question.prompt,
      kind: question.kind,
      options,
      correctOptionIds,
      ...(explanation ? { explanation } : {}),
    };
  });

  const parsed = quizQuestionsSchema.safeParse(questions);
  if (!parsed.success) {
    throw new AppError(
      "invalid",
      parsed.error.issues.map((issue) => issue.message).join(", "),
    );
  }
  return parsed.data;
}

/** Create or replace a lesson's quiz, preserving ids that already existed. */
export async function upsertLessonQuiz(input: SaveQuizInput): Promise<QuizDefinition> {
  const lesson = await getAdminLessonById(input.lessonId);
  if (!lesson) throw new AppError("not_found", "Lesson not found.");

  const db = await getDb();
  const existing = await db
    .select()
    .from(lessonQuizzes)
    .where(eq(lessonQuizzes.lessonId, input.lessonId))
    .get();

  const existingQuestions = existing ? parseQuizQuestions(existing.questions) : null;
  const questions = buildAdminQuestions(input.questions, existingQuestions);
  const now = new Date();

  if (existing) {
    await db
      .update(lessonQuizzes)
      .set({
        questions: serializeQuizQuestions(questions),
        passPercent: input.passPercent,
        requirePass: input.requirePass,
        updatedAt: now,
      })
      .where(eq(lessonQuizzes.id, existing.id));
  } else {
    await db.insert(lessonQuizzes).values({
      id: newQuizKey("quiz"),
      courseId: lesson.courseId,
      lessonId: lesson.id,
      questions: serializeQuizQuestions(questions),
      passPercent: input.passPercent,
      requirePass: input.requirePass,
      createdAt: now,
      updatedAt: now,
    });
  }

  const saved = await getLessonQuiz(input.lessonId);
  if (!saved) throw new AppError("not_found", "Quiz could not be saved.");
  return saved;
}

/** Delete a lesson quiz. Attempts cascade at the database level. */
export async function deleteLessonQuiz(
  lessonId: string,
): Promise<{ id: string; lessonId: string; courseId: string }> {
  const db = await getDb();
  const existing = await db
    .select()
    .from(lessonQuizzes)
    .where(eq(lessonQuizzes.lessonId, lessonId))
    .get();
  if (!existing) throw new AppError("not_found", "Quiz not found.");
  await db.delete(lessonQuizzes).where(eq(lessonQuizzes.id, existing.id));
  return { id: existing.id, lessonId, courseId: existing.courseId };
}

function validateAnswers(answers: unknown) {
  const parsed = quizAnswersSchema.safeParse(answers);
  if (!parsed.success) {
    throw new AppError(
      "invalid",
      parsed.error.issues.map((issue) => issue.message).join(", "),
    );
  }
  return parsed.data;
}

/**
 * Batch I: insert a learner tag for every selected option that carries one.
 * ONE insert statement (ON CONFLICT DO NOTHING keeps re-submissions
 * idempotent and never overwrites an admin-set tag). Best-effort by design:
 * a tagging failure must never fail or slow the graded submission, so errors
 * are logged (no payload) and swallowed.
 */
async function awardQuizOptionTags(
  db: Database,
  input: { userId: string; quiz: QuizDefinition; answers: QuizAnswers },
): Promise<void> {
  const tags = new Set<string>();
  for (const question of input.quiz.questions) {
    const selected = new Set(input.answers[question.id] ?? []);
    for (const option of question.options) {
      if (option.tag && selected.has(option.id)) tags.add(option.tag);
    }
  }
  if (tags.size === 0) return;
  const now = new Date();
  try {
    await db
      .insert(learnerTags)
      .values(
        [...tags].map((tag) => ({
          id: `ltag_${crypto.randomUUID().slice(0, 12)}`,
          userId: input.userId,
          tag,
          source: "quiz" as const,
          sourceQuizId: input.quiz.id,
          createdAt: now,
        })),
      )
      .onConflictDoNothing({ target: [learnerTags.userId, learnerTags.tag] });
  } catch (error: unknown) {
    console.error("quiz_tag_award_failed", {
      quizId: input.quiz.id,
      tags: tags.size,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Grade and record an attempt. Authorization is resolved entirely server-side:
 * a signed-in user with an ACTIVE/COMPLETED enrollment on a readable lesson.
 * Preview-only readers cannot submit.
 */
export async function submitQuizAttempt(
  userId: string,
  input: { courseSlug: string; lessonSlug: string; answers: unknown },
): Promise<QuizAttemptResult> {
  const course = await getLearnerCourseBySlug(input.courseSlug, userId);
  if (!course) throw new AppError("not_found", "Course not found.");
  const lesson: Lesson | null = await getPublishedLessonBySlug(course.id, input.lessonSlug);
  if (!lesson) throw new AppError("not_found", "Lesson not found.");

  const enrollment = await getEnrollment(userId, course.id);
  const activeEnrollment = hasLearnerAccess(enrollment) ? enrollment : null;
  const access = getLessonReadAccess({
    signedIn: true,
    enrolled: Boolean(activeEnrollment),
    course,
    lesson,
  });
  if (access !== "enrolled" || !activeEnrollment) {
    throw new AppError("forbidden", "Enroll in this course to take the quiz.");
  }
  // DRIP (Batch J): locked lessons refuse quiz attempts (fetch and submit).
  const dbForRelease = await getDb();
  const quizSection = await dbForRelease
    .select()
    .from(courseSections)
    .where(eq(courseSections.id, lesson.sectionId))
    .get();
  if (!isLessonReleased(quizSection ?? null, lesson, activeEnrollment.enrolledAt)) {
    throw new AppError("forbidden", "This lesson has not unlocked yet.");
  }

  const quiz = await getLessonQuiz(lesson.id);
  if (!quiz || quiz.questions.length === 0) {
    throw new AppError("not_found", "This lesson has no quiz.");
  }

  const answers = validateAnswers(input.answers);
  const db = await getDb();

  // Flood control: reject a new attempt within 5 s of this learner's previous
  // attempt on the same quiz. Unlimited attempts remain allowed after that.
  const last = await db
    .select({ createdAt: quizAttempts.createdAt })
    .from(quizAttempts)
    .where(and(eq(quizAttempts.userId, userId), eq(quizAttempts.quizId, quiz.id)))
    .orderBy(desc(quizAttempts.createdAt))
    .limit(1)
    .get();
  if (last && Date.now() - last.createdAt.getTime() < QUIZ_THROTTLE_MS) {
    throw new AppError("conflict", "Please wait a few seconds before trying again.");
  }

  const grading = gradeQuiz(quiz.questions, answers, quiz.passPercent);

  await db.insert(quizAttempts).values({
    id: newQuizKey("attempt"),
    quizId: quiz.id,
    userId,
    enrollmentId: activeEnrollment.id,
    lessonId: lesson.id,
    answers: JSON.stringify(answers),
    scorePercent: grading.scorePercent,
    correctCount: grading.correctCount,
    totalCount: grading.totalCount,
    passed: grading.passed,
    createdAt: new Date(),
  });

  // Batch I: tag the learner for quiz answers that carry tags. Best-effort —
  // never throws, so the graded submission above always stands.
  await awardQuizOptionTags(db, { userId, quiz, answers });

  const shouldComplete = grading.passed || !quiz.requirePass;
  if (shouldComplete) {
    const completion = await completeLessonAndContinue(userId, activeEnrollment.id, lesson.id);
    return {
      ...grading,
      quizId: quiz.id,
      lessonId: lesson.id,
      nextHref: completion.nextHref,
      lessonCompleted: true,
    };
  }

  // A failed attempt does not revoke an EXISTING completion. If this lesson was
  // already complete before the quiz gate, still offer the server-owned target.
  const alreadyComplete = await isLessonComplete(activeEnrollment.id, lesson.id);
  let nextHref: string | null = null;
  if (alreadyComplete) {
    const progress = await getEnrollmentProgress(activeEnrollment);
    nextHref = getLessonContinuationHref(
      course,
      lesson.id,
      progress.publishedLessons,
      progress.completedLessonIds,
    );
  }

  return {
    ...grading,
    quizId: quiz.id,
    lessonId: lesson.id,
    nextHref,
    lessonCompleted: alreadyComplete,
  };
}
