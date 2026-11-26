import { z } from "zod";
import type { QuizAttempt } from "@/lib/db";

// ============================================================================
// LESSON QUIZ DOMAIN TYPES
// ----------------------------------------------------------------------------
// SECURITY BOUNDARY: QuizQuestion (with correctOptionIds + explanation) is the
// SERVER-ONLY shape. LearnerQuiz is the projection that may cross into RSC
// props / the browser; it has no answer or explanation fields at all.
// ============================================================================

export const QUIZ_MAX_QUESTIONS = 30;
export const QUIZ_MIN_OPTIONS = 2;
export const QUIZ_MAX_OPTIONS = 8;
export const QUIZ_MAX_PROMPT = 500;
export const QUIZ_MAX_OPTION_TEXT = 200;
export const QUIZ_MAX_EXPLANATION = 1000;
export const QUIZ_MAX_ANSWER_KEYS = 100;
export const QUIZ_THROTTLE_MS = 5_000;

const quizIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^[A-Za-z0-9_-]+$/, "Ids may contain only letters, numbers, _ and -");

// ============================================================================
// LEARNER TAGS on quiz options (Batch I)
// ----------------------------------------------------------------------------
// An option may carry a slug tag ("Tag learners who pick this"). Graded
// submissions insert the tag for every selected option that has one. The tag
// is SERVER-ONLY like correctOptionIds/explanations: toLearnerQuiz never
// projects it and grading results never echo it. Old quizzes without tags
// keep parsing (the field is optional; a blank input normalizes to absent).
// ============================================================================

export const LEARNER_TAG_MAX_LENGTH = 40;
export const LEARNER_TAG_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;

function emptyTagToUndefined(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().toLowerCase();
  return trimmed === "" ? undefined : trimmed;
}

export const quizOptionTagSchema = z.preprocess(
  emptyTagToUndefined,
  z
    .string()
    .regex(
      LEARNER_TAG_PATTERN,
      "Tag must be a lowercase slug: letters, numbers and dashes, up to 40 characters.",
    )
    .optional(),
);

export const quizOptionSchema = z.object({
  id: quizIdSchema,
  text: z.string().trim().min(1, "Option text is required").max(QUIZ_MAX_OPTION_TEXT),
  tag: quizOptionTagSchema,
});

export const quizQuestionSchema = z
  .object({
    id: quizIdSchema,
    prompt: z.string().trim().min(1, "Question prompt is required").max(QUIZ_MAX_PROMPT),
    kind: z.enum(["single", "multiple"]),
    options: z.array(quizOptionSchema).min(QUIZ_MIN_OPTIONS).max(QUIZ_MAX_OPTIONS),
    correctOptionIds: z.array(quizIdSchema).min(1).max(QUIZ_MAX_OPTIONS),
    explanation: z.string().trim().max(QUIZ_MAX_EXPLANATION).optional(),
  })
  .superRefine((question, ctx) => {
    const optionIds = question.options.map((option) => option.id);
    if (new Set(optionIds).size !== optionIds.length) {
      ctx.addIssue({
        code: "custom",
        path: ["options"],
        message: "Option ids must be unique within a question.",
      });
    }
    const known = new Set(optionIds);
    if (question.correctOptionIds.some((id) => !known.has(id))) {
      ctx.addIssue({
        code: "custom",
        path: ["correctOptionIds"],
        message: "Correct options must reference this question's options.",
      });
    }
    if (new Set(question.correctOptionIds).size !== question.correctOptionIds.length) {
      ctx.addIssue({
        code: "custom",
        path: ["correctOptionIds"],
        message: "Correct option ids must be unique.",
      });
    }
    if (question.kind === "single" && question.correctOptionIds.length !== 1) {
      ctx.addIssue({
        code: "custom",
        path: ["correctOptionIds"],
        message: "A single-choice question needs exactly one correct option.",
      });
    }
  });

export const quizQuestionsSchema = z
  .array(quizQuestionSchema)
  .min(1, "A quiz needs at least one question.")
  .max(QUIZ_MAX_QUESTIONS)
  .superRefine((questions, ctx) => {
    const ids = questions.map((question) => question.id);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({
        code: "custom",
        message: "Question ids must be unique within a quiz.",
      });
    }
  });

/** Learner-submitted answers: question id -> selected option ids. */
export const quizAnswersSchema = z
  .record(
    z.string().trim().min(1).max(40),
    z.array(z.string().trim().min(1).max(40)).max(QUIZ_MAX_OPTIONS),
  )
  .refine((answers) => Object.keys(answers).length <= QUIZ_MAX_ANSWER_KEYS, {
    message: "Too many answers submitted.",
  });

// Studio input: ids are optional. Existing ids are preserved on edit; the
// server generates ids for new questions/options.
const adminOptionalId = z.string().trim().max(40).optional().nullable();
export const adminQuizOptionSchema = z.object({
  id: adminOptionalId,
  text: z.string().trim().min(1, "Option text is required").max(QUIZ_MAX_OPTION_TEXT),
  tag: quizOptionTagSchema,
});
export const adminQuizQuestionSchema = z.object({
  id: adminOptionalId,
  prompt: z.string().trim().min(1, "Question prompt is required").max(QUIZ_MAX_PROMPT),
  kind: z.enum(["single", "multiple"]),
  options: z.array(adminQuizOptionSchema).min(QUIZ_MIN_OPTIONS).max(QUIZ_MAX_OPTIONS),
  correctOptionIds: z.array(z.string().trim().min(1).max(40)).min(1).max(QUIZ_MAX_OPTIONS),
  explanation: z.string().trim().max(QUIZ_MAX_EXPLANATION).optional().nullable(),
});
export const saveQuizSchema = z.object({
  lessonId: z.string().min(1),
  passPercent: z.number().int().min(0).max(100).default(70),
  requirePass: z.boolean().default(false),
  questions: z.array(adminQuizQuestionSchema).min(1).max(QUIZ_MAX_QUESTIONS),
});
export const deleteQuizSchema = z.object({
  lessonId: z.string().min(1),
});
export const submitQuizInputSchema = z.object({
  courseSlug: z.string().trim().min(1).max(200),
  lessonSlug: z.string().trim().min(1).max(200),
  answers: quizAnswersSchema,
});

export type QuizOption = z.infer<typeof quizOptionSchema>;
export type QuizQuestion = z.infer<typeof quizQuestionSchema>;
export type QuizAnswers = z.infer<typeof quizAnswersSchema>;
export type SaveQuizInput = z.infer<typeof saveQuizSchema>;
export type SubmitQuizInput = z.infer<typeof submitQuizInputSchema>;

export interface QuizDefinition {
  id: string;
  courseId: string;
  lessonId: string;
  passPercent: number;
  requirePass: boolean;
  questions: QuizQuestion[];
  createdAt: Date;
  updatedAt: Date;
}

export interface LearnerQuizOption {
  id: string;
  text: string;
}

export interface LearnerQuizQuestion {
  id: string;
  prompt: string;
  kind: "single" | "multiple";
  options: LearnerQuizOption[];
}

/** The ONLY quiz shape allowed to reach an unsubmitted learner. */
export interface LearnerQuiz {
  id: string;
  courseId: string;
  lessonId: string;
  passPercent: number;
  requirePass: boolean;
  questions: LearnerQuizQuestion[];
}

export interface LearnerQuizStats {
  bestScore: number | null;
  attemptCount: number;
  passed: boolean;
}

export interface QuizGradedQuestion {
  id: string;
  correct: boolean;
  correctOptionIds: string[];
  explanation?: string;
}

export interface QuizGradingResult {
  scorePercent: number;
  correctCount: number;
  totalCount: number;
  passed: boolean;
  questions: QuizGradedQuestion[];
}

export interface QuizAttemptResult extends QuizGradingResult {
  quizId: string;
  lessonId: string;
  nextHref: string | null;
  lessonCompleted: boolean;
}

export type QuizAttemptRow = QuizAttempt;

/** Parse stored JSON defensively; null means the stored quiz is unusable. */
export function parseQuizQuestions(raw: string | null | undefined): QuizQuestion[] | null {
  if (!raw) return null;
  try {
    const parsed = quizQuestionsSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function serializeQuizQuestions(questions: QuizQuestion[]): string {
  return JSON.stringify(questions);
}

/** Strip every answer-bearing field before rendering/serializing for a learner. */
export function toLearnerQuiz(quiz: QuizDefinition): LearnerQuiz {
  return {
    id: quiz.id,
    courseId: quiz.courseId,
    lessonId: quiz.lessonId,
    passPercent: quiz.passPercent,
    requirePass: quiz.requirePass,
    questions: quiz.questions.map((question) => ({
      id: question.id,
      prompt: question.prompt,
      kind: question.kind,
      options: question.options.map((option) => ({ id: option.id, text: option.text })),
    })),
  };
}
