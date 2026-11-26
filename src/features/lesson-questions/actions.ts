"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin, requireUser } from "@/lib/auth";
import { toActionResult, type ActionResult } from "@/lib/action-result";
import { AppError } from "@/lib/errors";
import { recordAdminAudit } from "@/features/audit/service";
import {
  answerLessonQuestion,
  askLessonQuestion,
  deleteMyLessonQuestion,
  transitionQuestionStatus,
} from "./service";
import {
  answerQuestionSchema,
  askQuestionSchema,
  deleteQuestionSchema,
  isLessonQuestionStatus,
  type LessonQuestionStatus,
} from "./types";

// ============================================================================
// LESSON QUESTION ACTIONS
// ----------------------------------------------------------------------------
// Learner asks/deletes return ActionResult via toActionResult (new actions
// must use it). Admin mutations write an audit row with bare facts only —
// never question or answer bodies.
// ============================================================================

function learnerPaths(courseSlug: string, lessonSlug: string): string[] {
  return [
    `/learn/courses/${courseSlug}/lessons/${lessonSlug}`,
    `/learn/courses/${courseSlug}`,
  ];
}

/** Enrolled learner asks the instructor a question on a lesson. */
export async function askLessonQuestionAction(input: unknown): Promise<
  ActionResult<{ id: string; status: string }>
> {
  return toActionResult(async () => {
    const session = await requireUser();
    const parsed = askQuestionSchema.safeParse(input);
    if (!parsed.success) {
      throw new AppError(
        "invalid",
        parsed.error.issues.map((issue) => issue.message).join(", "),
      );
    }
    const row = await askLessonQuestion(session.user.id, parsed.data);
    for (const path of learnerPaths(parsed.data.courseSlug, parsed.data.lessonSlug)) {
      revalidatePath(path);
    }
    return { id: row.id, status: row.status };
  }, "Could not send your question");
}

/** Learner deletes their own open question. */
export async function deleteLessonQuestionAction(
  input: unknown,
): Promise<ActionResult<{ deleted: boolean }>> {
  return toActionResult(async () => {
    const session = await requireUser();
    const parsed = deleteQuestionSchema.safeParse(input);
    if (!parsed.success) {
      throw new AppError(
        "invalid",
        parsed.error.issues.map((issue) => issue.message).join(", "),
      );
    }
    return deleteMyLessonQuestion(session.user.id, parsed.data.id);
  }, "Could not delete your question");
}

async function runAdminTransition(
  action: string,
  id: unknown,
  expected: unknown,
  to: LessonQuestionStatus,
): Promise<{ id: string; status: LessonQuestionStatus }> {
  const session = await requireAdmin();
  if (typeof id !== "string" || !id || !isLessonQuestionStatus(expected)) {
    throw new AppError("invalid", "Invalid question request");
  }
  const row = await transitionQuestionStatus({ id, from: expected, to });
  // Audit details: status change only. Never question or answer bodies.
  await recordAdminAudit({
    actorId: session.user.id,
    action,
    entityType: "lesson_question",
    entityId: row.id,
    details: { from: expected, to: row.status },
  });
  revalidatePath("/admin/questions");
  revalidatePath(`/admin/questions/${row.id}`);
  return { id: row.id, status: row.status };
}

/** Admin answers (or re-answers) a question, optionally publishing it. */
export async function answerLessonQuestionAction(input: unknown): Promise<
  ActionResult<{ id: string; status: LessonQuestionStatus; isPublic: boolean }>
> {
  return toActionResult(async () => {
    const session = await requireAdmin();
    const parsed = answerQuestionSchema.safeParse(input);
    if (!parsed.success) {
      throw new AppError(
        "invalid",
        parsed.error.issues.map((issue) => issue.message).join(", "),
      );
    }
    const row = await answerLessonQuestion(session.user.id, parsed.data);
    await recordAdminAudit({
      actorId: session.user.id,
      action: "question.answer",
      entityType: "lesson_question",
      entityId: row.id,
      details: { status: row.status, isPublic: row.isPublic },
    });
    revalidatePath("/admin/questions");
    revalidatePath(`/admin/questions/${row.id}`);
    revalidatePath(`/learn/courses/${row.courseSlug}/lessons/${row.lessonSlug}`);
    return { id: row.id, status: row.status, isPublic: row.isPublic };
  }, "Could not save the answer");
}

/** Admin closes an open or answered question. */
export async function closeLessonQuestionAction(
  id: string,
  expectedStatus: string,
): Promise<ActionResult<{ id: string; status: LessonQuestionStatus }>> {
  return toActionResult(
    () => runAdminTransition("question.close", id, expectedStatus, "closed"),
    "Could not close the question",
  );
}

/** Admin reopens a closed question. */
export async function reopenLessonQuestionAction(
  id: string,
  expectedStatus: string,
): Promise<ActionResult<{ id: string; status: LessonQuestionStatus }>> {
  return toActionResult(
    () => runAdminTransition("question.reopen", id, expectedStatus, "open"),
    "Could not reopen the question",
  );
}
