"use server";

import { AppError, publicErrorMessage } from "@/lib/errors";
import { toActionResult, type ActionResult } from "@/lib/action-result";
import { requireUser } from "@/lib/auth";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { cancelMyEnrollment, enrollFree, restartMyEnrollment } from "./service";
import {
  getAdminCourseById,
  getAdminCourseBySlug,
  getPublishedCourseLessons,
} from "@/features/courses/service";

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

const restartCourseSchema = z.object({
  courseSlug: z.string().trim().min(1, "Course is required.").max(200, "Course is required."),
});

/**
 * Learner restarts a course: lesson progress and video resume positions are
 * cleared, the enrollment returns to active, and the learner is sent to the
 * first lesson. Quiz attempts, notes, certificates and the enrollment record
 * are kept. Enrolled-only. New actions use ActionResult via toActionResult.
 */
export async function restartCourseAction(
  input: unknown
): Promise<ActionResult<{ courseSlug: string; firstLessonHref: string }>> {
  return toActionResult(async () => {
    const session = await requireUser();
    // Zod failures are flattened to messages by toActionResult.
    const parsed = restartCourseSchema.parse(input);
    // Resolved by slug (any status — archived courses stay restartable while
    // entitled); restartMyEnrollment scopes the write to the caller's row.
    const course = await getAdminCourseBySlug(parsed.courseSlug);
    if (!course) {
      throw new AppError("not_found", "Course not found.");
    }
    await restartMyEnrollment(session.user.id, course.id);
    revalidatePath("/learn");
    revalidatePath("/learn/courses");
    // Layout revalidation covers the course page plus its lessons/notes children.
    revalidatePath(`/learn/courses/${course.slug}`, "layout");
    const first = (await getPublishedCourseLessons(course.id))[0] ?? null;
    return {
      courseSlug: course.slug,
      firstLessonHref: first
        ? `/learn/courses/${course.slug}/lessons/${first.slug}`
        : `/learn/courses/${course.slug}`,
    };
  }, "Could not restart this course");
}

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
