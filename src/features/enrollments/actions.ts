"use server";

import { publicErrorMessage } from "@/lib/errors";
import { requireUser } from "@/lib/auth";
import { revalidatePath } from "next/cache";
import { enrollFree } from "./service";
import { getAdminCourseById } from "@/features/courses/service";

export type ActionState<T = unknown> = {
  ok: boolean;
  data?: T;
  error?: string;
};

/** Learner FREE enrollment — authenticated user, idempotent. */
export async function enrollFreeAction(
  courseId: string
): Promise<ActionState<{ enrollmentId: string; courseSlug: string }>> {
  try {
    const session = await requireUser();
    const enrollment = await enrollFree(session.user.id, courseId);
    const course = await getAdminCourseById(courseId);
    if (course) {
      revalidatePath(`/learn/courses/${course.slug}`);
      revalidatePath("/learn");
      revalidatePath("/learn/courses");
    }
    return {
      ok: true,
      data: { enrollmentId: enrollment.id, courseSlug: course?.slug ?? "" },
    };
  } catch (err: unknown) {
    return { ok: false, error: publicErrorMessage(err, "Enrollment failed") };
  }
}
