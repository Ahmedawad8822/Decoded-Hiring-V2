"use server";

import { requireAdmin, requireUser } from "@/lib/auth";
import { publicErrorMessage } from "@/lib/errors";
import { recordAdminAudit } from "@/features/audit/service";
import { revalidateCourseSales } from "@/features/courses/actions";
import { revalidatePath } from "next/cache";
import {
  deleteLessonQuiz,
  submitQuizAttempt,
  upsertLessonQuiz,
} from "./service";
import {
  deleteQuizSchema,
  saveQuizSchema,
  submitQuizInputSchema,
} from "./types";

export type QuizActionState<T = unknown> = {
  ok: boolean;
  data?: T;
  error?: string;
};

function fail(error: unknown, fallback: string): QuizActionState<never> {
  return { ok: false, error: publicErrorMessage(error, fallback) };
}

/** Admin-only quiz create/update. Audited without any question content. */
export async function saveQuizAction(input: unknown): Promise<QuizActionState<{ id: string; lessonId: string }>> {
  try {
    const session = await requireAdmin();
    const parsed = saveQuizSchema.safeParse(input);
    if (!parsed.success) {
      return { ok: false, error: parsed.error.issues.map((issue) => issue.message).join(", ") };
    }
    const quiz = await upsertLessonQuiz(parsed.data);
    await recordAdminAudit({
      actorId: session.user.id,
      action: "quiz.upsert",
      entityType: "lesson_quiz",
      entityId: quiz.id,
      details: {
        lessonId: quiz.lessonId,
        courseId: quiz.courseId,
        questionCount: quiz.questions.length,
        passPercent: quiz.passPercent,
        requirePass: quiz.requirePass,
      },
    });
    revalidatePath(`/admin/courses/${quiz.courseId}/curriculum`);
    // The sales page renders a quiz badge per lesson.
    await revalidateCourseSales(quiz.courseId);
    return { ok: true, data: { id: quiz.id, lessonId: quiz.lessonId } };
  } catch (err: unknown) {
    return fail(err, "Could not save the quiz");
  }
}

/** Admin-only quiz delete. Attempts cascade; the audit records counts only. */
export async function deleteQuizAction(input: unknown): Promise<QuizActionState<{ id: string }>> {
  try {
    const session = await requireAdmin();
    const parsed = deleteQuizSchema.safeParse(input);
    if (!parsed.success) {
      return { ok: false, error: parsed.error.issues.map((issue) => issue.message).join(", ") };
    }
    const deleted = await deleteLessonQuiz(parsed.data.lessonId);
    await recordAdminAudit({
      actorId: session.user.id,
      action: "quiz.delete",
      entityType: "lesson_quiz",
      entityId: deleted.id,
      details: { lessonId: deleted.lessonId, courseId: deleted.courseId },
    });
    revalidatePath(`/admin/courses/${deleted.courseId}/curriculum`);
    // The sales page renders a quiz badge per lesson.
    await revalidateCourseSales(deleted.courseId);
    return { ok: true, data: { id: deleted.id } };
  } catch (err: unknown) {
    return fail(err, "Could not delete the quiz");
  }
}

/** Learner submission. Answers are graded server-side; answers stay secret. */
export async function submitQuizAttemptAction(input: unknown): Promise<QuizActionState<{
  scorePercent: number;
  correctCount: number;
  totalCount: number;
  passed: boolean;
  questions: { id: string; correct: boolean; correctOptionIds: string[]; explanation?: string }[];
  nextHref: string | null;
  lessonCompleted: boolean;
}>> {
  try {
    const session = await requireUser();
    const parsed = submitQuizInputSchema.safeParse(input);
    if (!parsed.success) {
      return { ok: false, error: parsed.error.issues.map((issue) => issue.message).join(", ") };
    }
    const result = await submitQuizAttempt(session.user.id, parsed.data);
    revalidatePath(`/learn/courses/${parsed.data.courseSlug}`);
    revalidatePath(`/learn/courses/${parsed.data.courseSlug}/lessons/${parsed.data.lessonSlug}`);
    revalidatePath(`/learn/courses/${parsed.data.courseSlug}/complete`);
    revalidatePath("/learn");
    return { ok: true, data: result };
  } catch (err: unknown) {
    return fail(err, "Could not submit the quiz");
  }
}
