"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { publicErrorMessage } from "@/lib/errors";
import { deleteMyLessonNote, saveMyLessonNote } from "./service";
import { deleteLessonNoteSchema, saveLessonNoteSchema } from "./types";

export type NoteActionState<T = unknown> = {
  ok: boolean;
  data?: T;
  error?: string;
};

function fail(error: unknown, fallback: string): NoteActionState<never> {
  return { ok: false, error: publicErrorMessage(error, fallback) };
}

function revalidateLearnerNotePaths(courseSlug: string, lessonSlug: string) {
  revalidatePath(`/learn/courses/${courseSlug}`);
  revalidatePath(`/learn/courses/${courseSlug}/lessons/${lessonSlug}`);
  revalidatePath(`/learn/courses/${courseSlug}/notes`);
}

/** Save the signed-in learner's note. Empty bodies delete it server-side. */
export async function saveLessonNoteAction(
  input: unknown,
): Promise<NoteActionState<{ updatedAt: string | null }>> {
  try {
    const session = await requireUser();
    const parsed = saveLessonNoteSchema.safeParse(input);
    if (!parsed.success) {
      return { ok: false, error: parsed.error.issues.map((issue) => issue.message).join(", ") };
    }
    const result = await saveMyLessonNote(session.user.id, parsed.data);
    revalidateLearnerNotePaths(parsed.data.courseSlug, parsed.data.lessonSlug);
    return {
      ok: true,
      data: { updatedAt: result.updatedAt ? result.updatedAt.toISOString() : null },
    };
  } catch (error: unknown) {
    return fail(error, "Could not save your note");
  }
}

/** Delete the signed-in learner's note for a lesson. */
export async function deleteLessonNoteAction(
  input: unknown,
): Promise<NoteActionState<{ deleted: boolean }>> {
  try {
    const session = await requireUser();
    const parsed = deleteLessonNoteSchema.safeParse(input);
    if (!parsed.success) {
      return { ok: false, error: parsed.error.issues.map((issue) => issue.message).join(", ") };
    }
    const result = await deleteMyLessonNote(session.user.id, parsed.data);
    revalidateLearnerNotePaths(parsed.data.courseSlug, parsed.data.lessonSlug);
    return { ok: true, data: result };
  } catch (error: unknown) {
    return fail(error, "Could not delete your note");
  }
}
