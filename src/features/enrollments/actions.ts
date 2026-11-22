"use server";

import { publicErrorMessage } from "@/lib/errors";
import { requireUser } from "@/lib/auth";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { cancelMyEnrollment, enrollFree } from "./service";
import { getAdminCourseById, getAdminCourseBySlug } from "@/features/courses/service";

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

const leaveCourseSchema = z.object({
  courseSlug: z.string().trim().min(1, "Course is required.").max(200, "Course is required."),
});

/** Learner leaves a course: enrollment -> cancelled, record kept. */
export async function leaveCourseAction(
  input: unknown
): Promise<ActionState<{ courseSlug: string }>> {
  try {
    const session = await requireUser();
    const parsed = leaveCourseSchema.safeParse(input);
    if (!parsed.success) {
      return { ok: false, error: parsed.error.issues.map((issue) => issue.message).join(", ") };
    }
    // Resolved by slug (any status — archived courses stay leaveable while
    // entitled); cancelMyEnrollment scopes the write to the caller's row.
    const course = await getAdminCourseBySlug(parsed.data.courseSlug);
    if (!course) return { ok: false, error: "Course not found." };
    await cancelMyEnrollment(session.user.id, course.id);
    revalidatePath("/learn");
    revalidatePath("/learn/courses");
    // Layout revalidation covers the course page plus its lessons/notes children.
    revalidatePath(`/learn/courses/${course.slug}`, "layout");
    return { ok: true, data: { courseSlug: course.slug } };
  } catch (err: unknown) {
    return { ok: false, error: publicErrorMessage(err, "Could not leave this course") };
  }
}
