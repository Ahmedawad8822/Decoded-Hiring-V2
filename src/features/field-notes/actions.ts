"use server";

import { requireAdmin } from "@/lib/auth";
import { revalidatePath } from "next/cache";
import * as fieldNoteService from "./service";
import { createFieldNoteSchema, updateFieldNoteSchema, CreateFieldNoteInput, UpdateFieldNoteInput } from "./types";
import type { FieldNoteRevision } from "@/lib/db";

export type ActionState<T = unknown> = {
  ok: boolean;
  data?: T;
  error?: string;
};

function revalidateFieldNotes(slug: string) {
  revalidatePath("/field-notes");
  revalidatePath(`/field-notes/${slug}`);
  revalidatePath("/admin/content");
}

export async function createFieldNoteAction(
  input: CreateFieldNoteInput
): Promise<ActionState<{ id: string; slug: string }>> {
  try {
    await requireAdmin();

    const parsed = createFieldNoteSchema.safeParse(input);
    if (!parsed.success) {
      return {
        ok: false,
        error: parsed.error.issues.map((i) => i.message).join(", "),
      };
    }

    const created = await fieldNoteService.createFieldNote(parsed.data);

    revalidateFieldNotes(created.slug);

    return {
      ok: true,
      data: { id: created.id, slug: created.slug },
    };
  } catch (err: unknown) {
    return {
      ok: false,
      error: (err as Error).message || "Failed to create field note",
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

    const updated = await fieldNoteService.updateFieldNote(parsed.data.id, parsed.data, {
      createdBy: session.user.id,
    });

    revalidateFieldNotes(updated.slug);

    return {
      ok: true,
      data: { id: updated.id, slug: updated.slug },
    };
  } catch (err: unknown) {
    return {
      ok: false,
      error: (err as Error).message || "Failed to update field note",
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

    return {
      ok: true,
      data: { slug: published.slug },
    };
  } catch (err: unknown) {
    return {
      ok: false,
      error: (err as Error).message || "Failed to publish field note",
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

    return {
      ok: true,
      data: { slug: draft.slug },
    };
  } catch (err: unknown) {
    return {
      ok: false,
      error: (err as Error).message || "Failed to unpublish field note",
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

    return {
      ok: true,
      data: { slug: archived.slug },
    };
  } catch (err: unknown) {
    return {
      ok: false,
      error: (err as Error).message || "Failed to archive field note",
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
      error: (err as Error).message || "Failed to load revision history",
    };
  }
}
