"use server";

import { publicErrorMessage } from "@/lib/errors";
import { requireAdmin } from "@/lib/auth";
import { recordAdminAudit } from "@/features/audit/service";
import { revalidatePath } from "next/cache";
import * as fieldNoteService from "./service";
import { createFieldNoteSchema, updateFieldNoteSchema, CreateFieldNoteInput, UpdateFieldNoteInput } from "./types";
import type { FieldNoteRevision } from "@/lib/db";

export type ActionState<T = unknown> = {
  ok: boolean;
  data?: T;
  error?: string;
};

function revalidateFieldNotes(slug: string, previousSlug?: string) {
  revalidatePath("/field-notes");
  revalidatePath("/sitemap.xml");
  revalidatePath(`/field-notes/${slug}`);
  // /field-notes/[slug] is static/ISR: after a rename the cached page at the
  // OLD slug must re-render as a 308 to the new one.
  if (previousSlug && previousSlug !== slug) {
    revalidatePath(`/field-notes/${previousSlug}`);
  }
  revalidatePath("/admin/content");
}

export async function createFieldNoteAction(
  input: CreateFieldNoteInput
): Promise<ActionState<{ id: string; slug: string }>> {
  try {
    const session = await requireAdmin();

    const parsed = createFieldNoteSchema.safeParse(input);
    if (!parsed.success) {
      return {
        ok: false,
        error: parsed.error.issues.map((i) => i.message).join(", "),
      };
    }

    const created = await fieldNoteService.createFieldNote(parsed.data);

    revalidateFieldNotes(created.slug);
    await recordAdminAudit({ actorId: session.user.id, action: "field_note.create", entityType: "field_note", entityId: created.id, details: { slug: created.slug } });

    return {
      ok: true,
      data: { id: created.id, slug: created.slug },
    };
  } catch (err: unknown) {
    return {
      ok: false,
      error: publicErrorMessage(err, "Failed to create field note"),
    };
  }
}

export async function updateFieldNoteAction(
  input: UpdateFieldNoteInput
): Promise<ActionState<{ id: string; slug: string }>> {
  try {
    const session = await requireAdmin();

    const parsed = updateFieldNoteSchema.safeParse(input);
    if (!parsed.success) {
      return {
        ok: false,
        error: parsed.error.issues.map((i) => i.message).join(", "),
      };
    }

    const before = await fieldNoteService.getAdminFieldNoteById(parsed.data.id);
    const updated = await fieldNoteService.updateFieldNote(parsed.data.id, parsed.data, {
      createdBy: session.user.id,
    });

    revalidateFieldNotes(updated.slug, before?.slug);
    await recordAdminAudit({ actorId: session.user.id, action: "field_note.update", entityType: "field_note", entityId: updated.id, details: { oldSlug: before?.slug ?? null, newSlug: updated.slug } });

    return {
      ok: true,
      data: { id: updated.id, slug: updated.slug },
    };
  } catch (err: unknown) {
    return {
      ok: false,
      error: publicErrorMessage(err, "Failed to update field note"),
    };
  }
}

export async function publishFieldNoteAction(id: string): Promise<ActionState<{ slug: string }>> {
  try {
    const session = await requireAdmin();

    const published = await fieldNoteService.publishFieldNote(id, {
      createdBy: session.user.id,
    });

    revalidateFieldNotes(published.slug);
    await recordAdminAudit({ actorId: session.user.id, action: "field_note.publish", entityType: "field_note", entityId: id, details: { slug: published.slug, status: "published" } });

    return {
      ok: true,
      data: { slug: published.slug },
    };
  } catch (err: unknown) {
    return {
      ok: false,
      error: publicErrorMessage(err, "Failed to publish field note"),
    };
  }
}

export async function unpublishFieldNoteAction(id: string): Promise<ActionState<{ slug: string }>> {
  try {
    const session = await requireAdmin();

    const draft = await fieldNoteService.unpublishFieldNote(id, {
      createdBy: session.user.id,
    });

    revalidateFieldNotes(draft.slug);
    await recordAdminAudit({ actorId: session.user.id, action: "field_note.unpublish", entityType: "field_note", entityId: id, details: { slug: draft.slug, status: "draft" } });

    return {
      ok: true,
      data: { slug: draft.slug },
    };
  } catch (err: unknown) {
    return {
      ok: false,
      error: publicErrorMessage(err, "Failed to unpublish field note"),
    };
  }
}

export async function archiveFieldNoteAction(id: string): Promise<ActionState<{ slug: string }>> {
  try {
    const session = await requireAdmin();

    const archived = await fieldNoteService.archiveFieldNote(id, {
      createdBy: session.user.id,
    });

    revalidateFieldNotes(archived.slug);
    await recordAdminAudit({ actorId: session.user.id, action: "field_note.archive", entityType: "field_note", entityId: id, details: { slug: archived.slug, status: "archived" } });

    return {
      ok: true,
      data: { slug: archived.slug },
    };
  } catch (err: unknown) {
    return {
      ok: false,
      error: publicErrorMessage(err, "Failed to archive field note"),
    };
  }
}

export async function getFieldNoteRevisionsAction(
  id: string
): Promise<ActionState<FieldNoteRevision[]>> {
  try {
    await requireAdmin();
    const revisions = await fieldNoteService.getFieldNoteRevisions(id);
    return { ok: true, data: revisions };
  } catch (err: unknown) {
    return {
      ok: false,
      error: publicErrorMessage(err, "Failed to load revision history"),
    };
  }
}
