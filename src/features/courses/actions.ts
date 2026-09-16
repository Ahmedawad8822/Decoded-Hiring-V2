"use server";

import { requireAdmin } from "@/lib/auth";
import { revalidatePath } from "next/cache";
import * as courseService from "./service";
import {
  createCourseSchema,
  updateCourseSchema,
  createSectionSchema,
  renameSectionSchema,
  createLessonSchema,
  updateLessonSchema,
} from "./types";

export type ActionState<T = unknown> = {
  ok: boolean;
  data?: T;
  error?: string;
};

function fail(error: unknown, fallback: string): ActionState<never> {
  return { ok: false, error: (error as Error).message || fallback };
}

export async function createCourseAction(
  input: unknown
): Promise<ActionState<{ id: string; slug: string }>> {
  try {
    await requireAdmin();
    const parsed = createCourseSchema.safeParse(input);
    if (!parsed.success) {
      return { ok: false, error: parsed.error.issues.map((i) => i.message).join(", ") };
    }
    const created = await courseService.createCourse(parsed.data);
    revalidatePath("/admin/courses");
    return { ok: true, data: { id: created.id, slug: created.slug } };
  } catch (err: unknown) {
    return fail(err, "Failed to create course");
  }
}

export async function updateCourseAction(
  input: unknown
): Promise<ActionState<{ id: string; slug: string }>> {
  try {
    await requireAdmin();
    const parsed = updateCourseSchema.safeParse(input);
    if (!parsed.success) {
      return { ok: false, error: parsed.error.issues.map((i) => i.message).join(", ") };
    }
    const updated = await courseService.updateCourse(parsed.data.id, parsed.data);
    revalidatePath("/admin/courses");
    revalidatePath(`/learn/courses/${updated.slug}`);
    return { ok: true, data: { id: updated.id, slug: updated.slug } };
  } catch (err: unknown) {
    return fail(err, "Failed to update course");
  }
}

export async function publishCourseAction(id: string): Promise<ActionState<{ slug: string }>> {
  try {
    await requireAdmin();
    const course = await courseService.publishCourse(id);
    revalidatePath("/admin/courses");
    revalidatePath(`/learn/courses/${course.slug}`);
    return { ok: true, data: { slug: course.slug } };
  } catch (err: unknown) {
    return fail(err, "Failed to publish course");
  }
}

export async function unpublishCourseAction(id: string): Promise<ActionState<{ slug: string }>> {
  try {
    await requireAdmin();
    const course = await courseService.unpublishCourse(id);
    revalidatePath("/admin/courses");
    return { ok: true, data: { slug: course.slug } };
  } catch (err: unknown) {
    return fail(err, "Failed to unpublish course");
  }
}

export async function archiveCourseAction(id: string): Promise<ActionState<{ slug: string }>> {
  try {
    await requireAdmin();
    const course = await courseService.archiveCourse(id);
    revalidatePath("/admin/courses");
    return { ok: true, data: { slug: course.slug } };
  } catch (err: unknown) {
    return fail(err, "Failed to archive course");
  }
}

export async function createSectionAction(
  input: unknown
): Promise<ActionState<{ id: string }>> {
  try {
    await requireAdmin();
    const parsed = createSectionSchema.safeParse(input);
    if (!parsed.success) {
      return { ok: false, error: parsed.error.issues.map((i) => i.message).join(", ") };
    }
    const section = await courseService.createSection(parsed.data);
    revalidatePath(`/admin/courses/${section.courseId}/curriculum`);
    return { ok: true, data: { id: section.id } };
  } catch (err: unknown) {
    return fail(err, "Failed to create section");
  }
}

export async function renameSectionAction(
  input: unknown
): Promise<ActionState<{ id: string }>> {
  try {
    await requireAdmin();
    const parsed = renameSectionSchema.safeParse(input);
    if (!parsed.success) {
      return { ok: false, error: parsed.error.issues.map((i) => i.message).join(", ") };
    }
    const section = await courseService.renameSection(parsed.data.id, parsed.data.title);
    revalidatePath(`/admin/courses/${section.courseId}/curriculum`);
    return { ok: true, data: { id: section.id } };
  } catch (err: unknown) {
    return fail(err, "Failed to rename section");
  }
}

export async function moveSectionAction(
  id: string,
  direction: "up" | "down"
): Promise<ActionState<null>> {
  try {
    await requireAdmin();
    if (direction !== "up" && direction !== "down") {
      return { ok: false, error: "Direction must be 'up' or 'down'." };
    }
    await courseService.moveSection(id, direction);
    return { ok: true, data: null };
  } catch (err: unknown) {
    return fail(err, "Failed to move section");
  }
}

export async function createLessonAction(
  input: unknown
): Promise<ActionState<{ id: string; slug: string }>> {
  try {
    await requireAdmin();
    const parsed = createLessonSchema.safeParse(input);
    if (!parsed.success) {
      return { ok: false, error: parsed.error.issues.map((i) => i.message).join(", ") };
    }
    const lesson = await courseService.createLesson(parsed.data);
    revalidatePath(`/admin/courses/${lesson.courseId}/curriculum`);
    return { ok: true, data: { id: lesson.id, slug: lesson.slug } };
  } catch (err: unknown) {
    return fail(err, "Failed to create lesson");
  }
}

export async function updateLessonAction(
  input: unknown
): Promise<ActionState<{ id: string; slug: string }>> {
  try {
    await requireAdmin();
    const parsed = updateLessonSchema.safeParse(input);
    if (!parsed.success) {
      return { ok: false, error: parsed.error.issues.map((i) => i.message).join(", ") };
    }
    const lesson = await courseService.updateLesson(parsed.data.id, parsed.data);
    revalidatePath(`/admin/courses/${lesson.courseId}/curriculum`);
    return { ok: true, data: { id: lesson.id, slug: lesson.slug } };
  } catch (err: unknown) {
    return fail(err, "Failed to update lesson");
  }
}

export async function publishLessonAction(id: string): Promise<ActionState<{ slug: string }>> {
  try {
    await requireAdmin();
    const lesson = await courseService.publishLesson(id);
    revalidatePath(`/admin/courses/${lesson.courseId}/curriculum`);
    return { ok: true, data: { slug: lesson.slug } };
  } catch (err: unknown) {
    return fail(err, "Failed to publish lesson");
  }
}

export async function unpublishLessonAction(id: string): Promise<ActionState<{ slug: string }>> {
  try {
    await requireAdmin();
    const lesson = await courseService.unpublishLesson(id);
    revalidatePath(`/admin/courses/${lesson.courseId}/curriculum`);
    return { ok: true, data: { slug: lesson.slug } };
  } catch (err: unknown) {
    return fail(err, "Failed to unpublish lesson");
  }
}

export async function moveLessonAction(
  id: string,
  direction: "up" | "down"
): Promise<ActionState<null>> {
  try {
    await requireAdmin();
    if (direction !== "up" && direction !== "down") {
      return { ok: false, error: "Direction must be 'up' or 'down'." };
    }
    await courseService.moveLesson(id, direction);
    return { ok: true, data: null };
  } catch (err: unknown) {
    return fail(err, "Failed to move lesson");
  }
}
