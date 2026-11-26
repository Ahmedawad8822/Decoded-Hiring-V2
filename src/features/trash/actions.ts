"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { toActionResult, type ActionResult } from "@/lib/action-result";
import { requireAdmin } from "@/lib/auth";
import { AppError } from "@/lib/errors";
import { recordAdminAudit } from "@/features/audit/service";
import { getTrashableType, type TrashMutationResult, type TrashTypeName } from "./service";
import { restoreGuideFromArchive } from "@/features/guides/service";
import { restoreFieldNoteFromArchive } from "@/features/field-notes/service";
import {
  getAdminCourseById,
  restoreCourseFromArchive,
  restoreLessonFromArchive,
} from "@/features/courses/service";

// ============================================================================
// TRASH SERVER ACTIONS (§1 lifecycle)
// ----------------------------------------------------------------------------
// Every mutation is admin-only (server-checked), audited and revalidates the
// affected public paths plus the sitemap. New actions use ActionResult via
// toActionResult (never throw out of the action).
// ============================================================================

const trashTypeSchema = z.enum(["guide", "field_note", "course", "lesson"]);

const trashItemSchema = z.object({
  type: trashTypeSchema,
  id: z.string().min(1, "Missing id."),
});

const deletePermanentlySchema = trashItemSchema.extend({
  confirmTitle: z.string().min(1, "Type the exact title to confirm permanent deletion."),
});

function revalidateTrashMutation(result: TrashMutationResult, oldSlugs: string[] = []): void {
  revalidatePath("/admin/trash");
  revalidatePath("/sitemap.xml");
  if (result.type === "guide") {
    revalidatePath("/guides");
    revalidatePath(`/guides/${result.slug}`);
    for (const old of oldSlugs) revalidatePath(`/guides/${old}`);
    revalidatePath("/admin/content");
  } else if (result.type === "field_note") {
    revalidatePath("/field-notes");
    revalidatePath(`/field-notes/${result.slug}`);
    for (const old of oldSlugs) revalidatePath(`/field-notes/${old}`);
    revalidatePath("/admin/content");
  } else if (result.type === "course") {
    revalidatePath("/admin/courses");
    if (result.courseId) revalidatePath(`/admin/courses/${result.courseId}/curriculum`);
    revalidatePath("/learn/courses");
    revalidatePath("/learn");
    revalidatePath(`/learn/courses/${result.slug}`);
    for (const old of oldSlugs) revalidatePath(`/learn/courses/${old}`);
  } else {
    if (result.courseId) revalidatePath(`/admin/courses/${result.courseId}/curriculum`);
    if (result.courseSlug) {
      revalidatePath(`/learn/courses/${result.courseSlug}`);
      revalidatePath(`/learn/courses/${result.courseSlug}/lessons/${result.slug}`);
      for (const old of oldSlugs) {
        revalidatePath(`/learn/courses/${result.courseSlug}/lessons/${old}`);
      }
    }
  }
}

function unknownType(type: string): never {
  throw new AppError("invalid", `Unknown content type "${type}".`);
}

export async function trashItemAction(input: unknown): Promise<ActionResult<{ type: string; id: string }>> {
  return toActionResult(async () => {
    const session = await requireAdmin();
    const parsed = trashItemSchema.parse(input);
    const trashable = getTrashableType(parsed.type);
    if (!trashable) unknownType(parsed.type);
    const result = await trashable!.trash(parsed.id);
    await recordAdminAudit({
      actorId: session.user.id,
      action: `${parsed.type}.trash`,
      entityType: parsed.type,
      entityId: parsed.id,
      details: { slug: result.slug, status: result.status ?? null },
    });
    revalidateTrashMutation(result);
    return { type: parsed.type, id: parsed.id };
  }, "Failed to move item to Trash");
}

export async function restoreArchivedItemAction(
  input: unknown
): Promise<ActionResult<{ type: string; id: string }>> {
  return toActionResult(async () => {
    const session = await requireAdmin();
    const parsed = trashItemSchema.parse(input);
    const type: TrashTypeName = parsed.type;
    if (type === "guide") {
      const restored = await restoreGuideFromArchive(parsed.id);
      await recordAdminAudit({ actorId: session.user.id, action: "guide.restore", entityType: "guide", entityId: parsed.id, details: { slug: restored.slug, status: "draft" } });
      revalidateTrashMutation({ type, id: parsed.id, slug: restored.slug, title: restored.title, status: "draft", courseId: null, courseSlug: null });
    } else if (type === "field_note") {
      const restored = await restoreFieldNoteFromArchive(parsed.id);
      await recordAdminAudit({ actorId: session.user.id, action: "field_note.restore", entityType: "field_note", entityId: parsed.id, details: { slug: restored.slug, status: "draft" } });
      revalidateTrashMutation({ type, id: parsed.id, slug: restored.slug, title: restored.title, status: "draft", courseId: null, courseSlug: null });
    } else if (type === "course") {
      const restored = await restoreCourseFromArchive(parsed.id);
      await recordAdminAudit({ actorId: session.user.id, action: "course.restore", entityType: "course", entityId: parsed.id, details: { slug: restored.slug, status: "draft" } });
      revalidateTrashMutation({ type, id: parsed.id, slug: restored.slug, title: restored.title, status: "draft", courseId: parsed.id, courseSlug: restored.slug });
    } else if (type === "lesson") {
      const restored = await restoreLessonFromArchive(parsed.id);
      await recordAdminAudit({ actorId: session.user.id, action: "lesson.restore", entityType: "lesson", entityId: parsed.id, details: { courseId: restored.courseId, slug: restored.slug, status: "draft" } });
      const course = await getAdminCourseById(restored.courseId);
      revalidateTrashMutation({ type, id: parsed.id, slug: restored.slug, title: restored.title, status: "draft", courseId: restored.courseId, courseSlug: course?.slug ?? null });
    } else {
      unknownType(type);
    }
    return { type: parsed.type, id: parsed.id };
  }, "Failed to restore item");
}

export async function restoreTrashedItemAction(
  input: unknown
): Promise<ActionResult<{ type: string; id: string }>> {
  return toActionResult(async () => {
    const session = await requireAdmin();
    const parsed = trashItemSchema.parse(input);
    const trashable = getTrashableType(parsed.type);
    if (!trashable) unknownType(parsed.type);
    // Audit happens inside the registry restore (actor-threaded).
    const result = await trashable!.restore(parsed.id, session.user.id);
    revalidateTrashMutation(result);
    return { type: parsed.type, id: parsed.id };
  }, "Failed to restore item from Trash");
}

export async function deletePermanentlyAction(
  input: unknown
): Promise<ActionResult<{ type: string; id: string }>> {
  return toActionResult(async () => {
    const session = await requireAdmin();
    const parsed = deletePermanentlySchema.parse(input);
    const trashable = getTrashableType(parsed.type);
    if (!trashable) unknownType(parsed.type);
    // Audit happens inside the registry delete (actor-threaded, with a
    // title/slug snapshot because the row is gone afterwards).
    const result = await trashable!.deletePermanently(parsed.id, session.user.id, parsed.confirmTitle);
    revalidateTrashMutation(result, result.oldSlugs);
    return { type: parsed.type, id: parsed.id };
  }, "Failed to delete item permanently");
}
