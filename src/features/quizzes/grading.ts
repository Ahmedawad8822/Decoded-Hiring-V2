import type {
  QuizAnswers,
  QuizGradedQuestion,
  QuizGradingResult,
  QuizQuestion,
} from "./types";

// ============================================================================
// QUIZ GRADING — pure, deterministic and server-only.
// ----------------------------------------------------------------------------
// Single- and multiple-choice questions use the SAME exact-set rule: the set
// of recognised selected option ids must equal the correct set. Multiple-choice
// is therefore all-or-nothing. Unknown question ids, unknown option ids and
// missing answers are ignored/wrong — they never earn credit.
// ============================================================================

function sameSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

export function gradeQuizQuestion(question: QuizQuestion, selected: unknown): QuizGradedQuestion {
  const knownOptions = new Set(question.options.map((option) => option.id));
  const chosen = new Set(
    (Array.isArray(selected) ? selected : [])
      .filter((id): id is string => typeof id === "string")
      .filter((id) => knownOptions.has(id)),
  );
  const correct = sameSet(chosen, new Set(question.correctOptionIds));
  return {
    id: question.id,
    correct,
    correctOptionIds: [...question.correctOptionIds],
    ...(question.explanation ? { explanation: question.explanation } : {}),
  };
}

export function gradeQuiz(
  questions: QuizQuestion[],
  answers: QuizAnswers,
  passPercent: number,
): QuizGradingResult {
  const results = questions.map((question) => gradeQuizQuestion(question, answers[question.id]));
  const totalCount = questions.length;
  const correctCount = results.filter((result) => result.correct).length;
  const scorePercent = totalCount === 0 ? 0 : Math.round((correctCount / totalCount) * 100);
  return {
    scorePercent,
    correctCount,
    totalCount,
    passed: scorePercent >= passPercent,
    questions: results,
  };
}
