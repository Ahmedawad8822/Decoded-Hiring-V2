import { and, eq } from "drizzle-orm";
import { getDb, lessonQuizzes, quizAttempts } from "@/lib/db";
import { AppError } from "@/lib/errors";

// ============================================================================
// QUIZ COMPLETION GATE — server-authoritative.
// ----------------------------------------------------------------------------
// A manual lesson completion is refused when the lesson's quiz has
// requirePass=true and the enrollment has no passed attempt. This lives in the
// service path (not the UI), so the complete button, completeLessonAndContinue
// and any future caller are all gated.
//
// RETROACTIVE POLICY: existing lesson_progress rows are never revoked. The
// gate is only consulted for a NEW completion (markLessonComplete checks the
// existing row first), so adding a quiz or turning requirePass on cannot
// retroactively un-complete earlier learners.
// ============================================================================

/**
 * One query: resolve the lesson quiz and, when required, whether this
 * enrollment already has a passed attempt.
 */
export async function assertManualLessonCompletionAllowed(
  enrollmentId: string,
  lessonId: string,
): Promise<void> {
  const db = await getDb();
  const row = await db
    .select({
      quizId: lessonQuizzes.id,
      requirePass: lessonQuizzes.requirePass,
      passedAttemptId: quizAttempts.id,
    })
    .from(lessonQuizzes)
    .leftJoin(
      quizAttempts,
      and(
        eq(quizAttempts.quizId, lessonQuizzes.id),
        eq(quizAttempts.enrollmentId, enrollmentId),
        eq(quizAttempts.passed, true),
      ),
    )
    .where(eq(lessonQuizzes.lessonId, lessonId))
    .limit(1)
    .get();

  if (!row || !row.requirePass) return;
  if (!row.passedAttemptId) {
    throw new AppError("forbidden", "Pass the quiz to complete this lesson.");
  }
}

export async function hasPassedQuizAttempt(enrollmentId: string, quizId: string): Promise<boolean> {
  const db = await getDb();
  const row = await db
    .select({ id: quizAttempts.id })
    .from(quizAttempts)
    .where(
      and(
        eq(quizAttempts.enrollmentId, enrollmentId),
        eq(quizAttempts.quizId, quizId),
        eq(quizAttempts.passed, true),
      ),
    )
    .limit(1)
    .get();
  return Boolean(row);
}
