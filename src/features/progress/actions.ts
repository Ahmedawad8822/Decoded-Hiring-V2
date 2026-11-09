"use server";

import { publicErrorMessage } from "@/lib/errors";
import { requireUser } from "@/lib/auth";
import { revalidatePath } from "next/cache";
import { completeLessonAndContinue } from "./service";

export type ActionState<T = unknown> = {
  ok: boolean;
  data?: T;
  error?: string;
};

/** Learner mark-lesson-complete — authenticated, enrollment-owned, idempotent. */
export async function markLessonCompleteAction(
  enrollmentId: string,
  lessonId: string
): Promise<ActionState<{ percent: number; completed: boolean; alreadyComplete: boolean; nextHref: string }>> {
  try {
    const session = await requireUser();
    const { progress, alreadyComplete, course, nextHref } = await completeLessonAndContinue(
      session.user.id, enrollmentId, lessonId
    );
    revalidatePath(`/learn/courses/${course.slug}`);
    revalidatePath(`/learn/courses/${course.slug}/complete`);
    const lesson = progress.publishedLessons.find((entry) => entry.id === lessonId);
    if (lesson) revalidatePath(`/learn/courses/${course.slug}/lessons/${lesson.slug}`);
    revalidatePath("/learn");
    return {
      ok: true,
      data: {
        percent: progress.percent,
        completed: progress.completed,
        alreadyComplete,
        nextHref,
      },
    };
  } catch (err: unknown) {
    return { ok: false, error: publicErrorMessage(err, "Could not mark lesson complete") };
  }
}
