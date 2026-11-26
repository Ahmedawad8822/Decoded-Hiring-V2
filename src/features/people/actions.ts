"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth";
import { publicErrorMessage } from "@/lib/errors";
import { recordAdminAudit } from "@/features/audit/service";
import { addPersonTag, removePersonTag, savePersonNote } from "./service";

// ============================================================================
// PEOPLE ACTIONS (Batch I)
// ----------------------------------------------------------------------------
// Admin-only tag/note mutations. The service validates (slug rule, 5000-char
// note cap, person must be role 'user'); the audit rows below carry bare
// facts only — tag slugs, never note bodies or emails.
// ============================================================================

export type PersonActionState<T = unknown> = {
  ok: boolean;
  data?: T;
  error?: string;
};

function fail(error: unknown, fallback: string): PersonActionState<never> {
  return { ok: false, error: publicErrorMessage(error, fallback) };
}

const tagActionSchema = z.object({
  userId: z.string().min(1),
  tag: z.string().trim().min(1).max(40),
});

const noteActionSchema = z.object({
  userId: z.string().min(1),
  body: z.string(),
});

function personPaths(userId: string): [string, string] {
  return [`/admin/people/${userId}`, "/admin/people"];
}

export async function addPersonTagAction(input: unknown): Promise<PersonActionState<{ tag: string }>> {
  try {
    const session = await requireAdmin();
    const parsed = tagActionSchema.safeParse(input);
    if (!parsed.success) {
      return { ok: false, error: parsed.error.issues.map((issue) => issue.message).join(", ") };
    }
    const { tag } = await addPersonTag(parsed.data.userId, parsed.data.tag);
    await recordAdminAudit({
      actorId: session.user.id,
      action: "person.tag_add",
      entityType: "person",
      entityId: parsed.data.userId,
      details: { tag },
    });
    for (const path of personPaths(parsed.data.userId)) revalidatePath(path);
    return { ok: true, data: { tag } };
  } catch (err: unknown) {
    return fail(err, "Could not add the tag");
  }
}

export async function removePersonTagAction(
  input: unknown,
): Promise<PersonActionState<{ tag: string }>> {
  try {
    const session = await requireAdmin();
    const parsed = tagActionSchema.safeParse(input);
    if (!parsed.success) {
      return { ok: false, error: parsed.error.issues.map((issue) => issue.message).join(", ") };
    }
    const { tag } = await removePersonTag(parsed.data.userId, parsed.data.tag);
    await recordAdminAudit({
      actorId: session.user.id,
      action: "person.tag_remove",
      entityType: "person",
      entityId: parsed.data.userId,
      details: { tag },
    });
    for (const path of personPaths(parsed.data.userId)) revalidatePath(path);
    return { ok: true, data: { tag } };
  } catch (err: unknown) {
    return fail(err, "Could not remove the tag");
  }
}

export async function savePersonNoteAction(
  input: unknown,
): Promise<PersonActionState<{ cleared: boolean }>> {
  try {
    const session = await requireAdmin();
    const parsed = noteActionSchema.safeParse(input);
    if (!parsed.success) {
      return { ok: false, error: parsed.error.issues.map((issue) => issue.message).join(", ") };
    }
    const result = await savePersonNote(parsed.data.userId, parsed.data.body, session.user.id);
    // No body in the audit details — bare fact only.
    await recordAdminAudit({
      actorId: session.user.id,
      action: "person.note_save",
      entityType: "person",
      entityId: parsed.data.userId,
    });
    revalidatePath(`/admin/people/${parsed.data.userId}`);
    return { ok: true, data: result };
  } catch (err: unknown) {
    return fail(err, "Could not save the note");
  }
}
