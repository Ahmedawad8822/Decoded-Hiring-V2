"use server";

import { publicErrorMessage } from "@/lib/errors";
import { requireAdmin } from "@/lib/auth";
import { revalidatePath } from "next/cache";
import * as guideService from "./service";
import { createGuideSchema, updateGuideSchema, CreateGuideInput, UpdateGuideInput } from "./types";

export type ActionState<T = unknown> = {
  ok: boolean;
  data?: T;
  error?: string;
};

export async function createGuideAction(
  input: CreateGuideInput
): Promise<ActionState<{ id: string; slug: string }>> {
  try {
    await requireAdmin();

    const parsed = createGuideSchema.safeParse(input);
    if (!parsed.success) {
      return {
        ok: false,
        error: parsed.error.issues.map((i) => i.message).join(", "),
      };
    }

    const created = await guideService.createGuide(parsed.data);

    revalidatePath("/guides");
    revalidatePath(`/guides/${created.slug}`);
    revalidatePath("/admin/content");

    return {
      ok: true,
      data: { id: created.id, slug: created.slug },
    };
  } catch (err: unknown) {
    return {
      ok: false,
      error: publicErrorMessage(err, "Failed to create guide"),
    };
  }
}

export async function updateGuideAction(
  input: UpdateGuideInput
): Promise<ActionState<{ id: string; slug: string }>> {
  try {
    await requireAdmin();

    const parsed = updateGuideSchema.safeParse(input);
    if (!parsed.success) {
      return {
        ok: false,
        error: parsed.error.issues.map((i) => i.message).join(", "),
      };
    }

    // /guides/[slug] is static/ISR: a rename must also drop the cached page
    // at the OLD slug so it re-renders as a 308 to the new one.
    const before = await guideService.getAdminGuideById(parsed.data.id);
    const updated = await guideService.updateGuide(parsed.data.id, parsed.data);

    revalidatePath("/guides");
    revalidatePath(`/guides/${updated.slug}`);
    if (before && before.slug !== updated.slug) {
      revalidatePath(`/guides/${before.slug}`);
    }
    revalidatePath("/admin/content");

    return {
      ok: true,
      data: { id: updated.id, slug: updated.slug },
    };
  } catch (err: unknown) {
    return {
      ok: false,
      error: publicErrorMessage(err, "Failed to update guide"),
    };
  }
}

export async function publishGuideAction(id: string): Promise<ActionState<{ slug: string }>> {
  try {
    await requireAdmin();

    const published = await guideService.publishGuide(id);

    revalidatePath("/guides");
    revalidatePath(`/guides/${published.slug}`);
    revalidatePath("/admin/content");

    return {
      ok: true,
      data: { slug: published.slug },
    };
  } catch (err: unknown) {
    return {
      ok: false,
      error: publicErrorMessage(err, "Failed to publish guide"),
    };
  }
}

export async function unpublishGuideAction(id: string): Promise<ActionState<{ slug: string }>> {
  try {
    await requireAdmin();

    const draft = await guideService.unpublishGuide(id);

    revalidatePath("/guides");
    revalidatePath(`/guides/${draft.slug}`);
    revalidatePath("/admin/content");

    return {
      ok: true,
      data: { slug: draft.slug },
    };
  } catch (err: unknown) {
    return {
      ok: false,
      error: publicErrorMessage(err, "Failed to unpublish guide"),
    };
  }
}

export async function archiveGuideAction(id: string): Promise<ActionState<{ slug: string }>> {
  try {
    await requireAdmin();

    const archived = await guideService.archiveGuide(id);

    revalidatePath("/guides");
    revalidatePath(`/guides/${archived.slug}`);
    revalidatePath("/admin/content");

    return {
      ok: true,
      data: { slug: archived.slug },
    };
  } catch (err: unknown) {
    return {
      ok: false,
      error: publicErrorMessage(err, "Failed to archive guide"),
    };
  }
}
