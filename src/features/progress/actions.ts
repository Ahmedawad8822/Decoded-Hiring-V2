"use server";

import { requireUser } from "@/lib/auth";
import { revalidatePath } from "next/cache";
import { markLessonComplete } from "./service";
import { getAdminLessonById, getAdminCourseById } from "@/features/courses/service";

export type ActionState<T = unknown> = {
  ok: boolean;
  data?: T;
  error?: string;
};

/** Learner mark-lesson-complete — authenticated, enrollment-owned, idempotent. */
export async function markLessonCompleteAction(
  enrollmentId: string,
  lessonId: string
): Promise<ActionState<{ percent: number; completed: boolean; alreadyComplete: boolean }>> {
  try {
    const session = await requireUser();
    const { progress, alreadyComplete } = await markLessonComplete(
      session.user.id,
      enrollmentId,
      lessonId
    );
    const lesson = await getAdminLessonById(lessonId);
    if (lesson) {
      const course = await getAdminCourseById(lesson.courseId);
      if (course) {
        revalidatePath(`/learn/courses/${course.slug}`);
        revalidatePath(`/learn/courses/${course.slug}/lessons/${lesson.slug}`);
        revalidatePath("/learn");
      }
    }
    return {
      ok: true,
      data: {
        percent: progress.percent,
        completed: progress.completed,
        alreadyComplete,
      },
    };
  } catch (err: unknown) {
    return { ok: false, error: (err as Error).message || "Could not mark lesson complete" };
  }
}
