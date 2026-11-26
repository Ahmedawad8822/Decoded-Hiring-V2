import { z } from "zod";
import type { LessonQuestion } from "@/lib/db";
import {
  normalizeQuestionBody,
  QUESTION_MAX_ANSWER,
  QUESTION_MAX_BODY,
} from "./constants";

export {
  normalizeQuestionBody,
  PUBLIC_QUESTIONS_LIMIT,
  QUESTION_MAX_ANSWER,
  QUESTION_MAX_BODY,
  QUESTION_MIN_BODY,
  QUESTIONS_PAGE_SIZE,
  QUESTIONS_PER_DAY,
} from "./constants";

// ============================================================================
// LESSON QUESTION DOMAIN TYPES
// ----------------------------------------------------------------------------
// Private learner -> instructor Q&A. Bodies are owner-only plain text like
// notes (NFC + trim, control characters rejected). Answers are admin-written
// plain text (max 5000). The learner panel never receives another learner's
// identity: the public projection carries no user id, name or email.
// ============================================================================

// Everything in the C0 range plus DEL, except TAB (0x09) and LF (0x0A).
const CONTROL_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F]/;

export const LESSON_QUESTION_STATUSES = ["open", "answered", "closed"] as const;
export type LessonQuestionStatus = (typeof LESSON_QUESTION_STATUSES)[number];

export function isLessonQuestionStatus(value: unknown): value is LessonQuestionStatus {
  return (LESSON_QUESTION_STATUSES as readonly unknown[]).includes(value);
}

const slugSchema = z.string().trim().min(1).max(200);

export const questionBodySchema = z
  .string()
  .transform((value) => normalizeQuestionBody(value))
  .refine((value) => value.length >= 1, {
    message: "Write your question first.",
  })
  .refine((value) => value.length <= QUESTION_MAX_BODY, {
    message: `Questions can be at most ${QUESTION_MAX_BODY.toLocaleString("en-US")} characters.`,
  })
  .refine((value) => !CONTROL_CHARS.test(value), {
    message: "Questions can contain plain text only (no control characters).",
  });

export const questionAnswerSchema = z
  .string()
  .transform((value) => normalizeQuestionBody(value))
  .refine((value) => value.length >= 1, {
    message: "Write the answer first.",
  })
  .refine((value) => value.length <= QUESTION_MAX_ANSWER, {
    message: `Answers can be at most ${QUESTION_MAX_ANSWER.toLocaleString("en-US")} characters.`,
  })
  .refine((value) => !CONTROL_CHARS.test(value), {
    message: "Answers can contain plain text only (no control characters).",
  });

const idempotencyKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9_-]+$/, "Invalid submission key.");

export const askQuestionSchema = z.object({
  courseSlug: slugSchema,
  lessonSlug: slugSchema,
  body: questionBodySchema,
  idempotencyKey: idempotencyKeySchema,
});

export const deleteQuestionSchema = z.object({
  id: z.string().min(1).max(80),
});

export const answerQuestionSchema = z.object({
  id: z.string().min(1).max(80),
  answerBody: questionAnswerSchema,
  /** "Publish on lesson": visible to every enrolled learner (no identities). */
  isPublic: z.boolean().default(false),
});

export type AskQuestionInput = z.infer<typeof askQuestionSchema>;
export type DeleteQuestionInput = z.infer<typeof deleteQuestionSchema>;
export type AnswerQuestionInput = z.infer<typeof answerQuestionSchema>;

export type LessonQuestionRow = LessonQuestion;

/** Identity-free public Q&A: the ONLY question shape other learners may see. */
export interface PublicLessonQuestion {
  id: string;
  body: string;
  answerBody: string;
  answeredAt: Date;
}

export interface AdminQuestionRow {
  id: string;
  body: string;
  status: LessonQuestionStatus;
  answerBody: string | null;
  answeredAt: Date | null;
  answeredBy: string | null;
  isPublic: boolean;
  createdAt: Date;
  updatedAt: Date;
  learnerId: string;
  learnerName: string;
  learnerEmail: string;
  courseId: string;
  courseTitle: string;
  courseSlug: string;
  lessonId: string;
  lessonTitle: string;
  lessonSlug: string;
}
