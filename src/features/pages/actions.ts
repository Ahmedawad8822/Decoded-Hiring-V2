"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth";
import { recordAdminAudit } from "@/features/audit/service";
import { toActionResult, type ActionResult } from "@/lib/action-result";
import * as pageService from "./service";
import {
  createPageSchema,
  deletePageSchema,
  updatePageSchema,
  type CreatePageInput,
  type DeletePageInput,
  type UpdatePageInput,
} from "./types";

// ============================================================================
// STANDARD PAGE ACTIONS (§3, lifecycle §1)
// ----------------------------------------------------------------------------
// New actions use ActionResult via toActionResult (never throw). Every
// mutation is admin-only (server-checked) and writes an admin audit row, and
// revalidates the public page, the previous slug on rename,
// the sitemap and the Studio list.
// ============================================================================

function revalidatePages(slug: string, previousSlug?: string) {
  revalidatePath("/sitemap.xml");
  revalidatePath(`/${slug}`);
  // After a rename the cached page at the OLD slug must re-render as a 308
  // to the new one.
  if (previousSlug && previousSlug !== slug) {
    revalidatePath(`/${previousSlug}`);
  }
  revalidatePath("/admin/content");
}

export async function createPageAction(
  input: CreatePageInput
): Promise<ActionResult<{ id: string; slug: string }>> {
  return toActionResult(async () => {
    const session = await requireAdmin();
    const parsed = createPageSchema.parse(input);
    const created = await pageService.createPage(parsed);
    revalidatePages(created.slug);
    await recordAdminAudit({
      actorId: session.user.id,
      action: "page.create",
      entityType: "page",
      entityId: created.id,
      details: { slug: created.slug },
    });
    return { id: created.id, slug: created.slug };
  }, "Failed to create page");
}

export async function updatePageAction(
  input: UpdatePageInput
): Promise<ActionResult<{ id: string; slug: string }>> {
  return toActionResult(async () => {
    const session = await requireAdmin();
    const parsed = updatePageSchema.parse(input);
    const before = await pageService.getAdminPageById(parsed.id);
    const updated = await pageService.updatePage(parsed.id, parsed, {
      createdBy: session.user.id,
    });
    revalidatePages(updated.slug, before?.slug);
    await recordAdminAudit({
      actorId: session.user.id,
      action: "page.update",
      entityType: "page",
      entityId: updated.id,
      details: { oldSlug: before?.slug ?? null, newSlug: updated.slug },
    });
    return { id: updated.id, slug: updated.slug };
  }, "Failed to update page");
}

export async function publishPageAction(id: string): Promise<ActionResult<{ slug: string }>> {
  return toActionResult(async () => {
    const session = await requireAdmin();
    const published = await pageService.publishPage(id, { createdBy: session.user.id });
    revalidatePages(published.slug);
    await recordAdminAudit({
      actorId: session.user.id,
      action: "page.publish",
      entityType: "page",
      entityId: id,
      details: { slug: published.slug, status: "published" },
    });
    return { slug: published.slug };
  }, "Failed to publish page");
}

export async function unpublishPageAction(id: string): Promise<ActionResult<{ slug: string }>> {
  return toActionResult(async () => {
    const session = await requireAdmin();
    const draft = await pageService.unpublishPage(id, { createdBy: session.user.id });
    revalidatePages(draft.slug);
    await recordAdminAudit({
      actorId: session.user.id,
      action: "page.unpublish",
      entityType: "page",
      entityId: id,
      details: { slug: draft.slug, status: "draft" },
    });
    return { slug: draft.slug };
  }, "Failed to unpublish page");
}

export async function archivePageAction(id: string): Promise<ActionResult<{ slug: string }>> {
  return toActionResult(async () => {
    const session = await requireAdmin();
    const archived = await pageService.archivePage(id, { createdBy: session.user.id });
    revalidatePages(archived.slug);
    await recordAdminAudit({
      actorId: session.user.id,
      action: "page.archive",
      entityType: "page",
      entityId: id,
      details: { slug: archived.slug, status: "archived" },
    });
    return { slug: archived.slug };
  }, "Failed to archive page");
}

export async function restorePageAction(id: string): Promise<ActionResult<{ slug: string }>> {
  return toActionResult(async () => {
    const session = await requireAdmin();
    const draft = await pageService.restorePageFromArchive(id, { createdBy: session.user.id });
    revalidatePages(draft.slug);
    await recordAdminAudit({
      actorId: session.user.id,
      action: "page.restore",
      entityType: "page",
      entityId: id,
      details: { slug: draft.slug, status: "draft" },
    });
    return { slug: draft.slug };
  }, "Failed to restore page");
}

export async function trashPageAction(id: string): Promise<ActionResult<{ slug: string }>> {
  return toActionResult(async () => {
    const session = await requireAdmin();
    const trashed = await pageService.movePageToTrash(id);
    revalidatePages(trashed.slug);
    await recordAdminAudit({
      actorId: session.user.id,
      action: "page.trash",
      entityType: "page",
      entityId: id,
      details: { slug: trashed.slug, status: trashed.status },
    });
    return { slug: trashed.slug };
  }, "Failed to move page to Trash");
}

export async function restorePageFromTrashAction(
  id: string
): Promise<ActionResult<{ slug: string }>> {
  return toActionResult(async () => {
    const session = await requireAdmin();
    const restored = await pageService.restorePageFromTrash(id, session.user.id);
    revalidatePages(restored.slug);
    await recordAdminAudit({
      actorId: session.user.id,
      action: "page.restore_trash",
      entityType: "page",
      entityId: id,
      details: { slug: restored.slug, status: restored.status },
    });
    return { slug: restored.slug };
  }, "Failed to restore page from Trash");
}

export async function deletePagePermanentlyAction(
  input: DeletePageInput
): Promise<ActionResult<{ slug: string }>> {
  return toActionResult(async () => {
    const session = await requireAdmin();
    const parsed = deletePageSchema.parse(input);
    const before = await pageService.getAdminPageById(parsed.id);
    const snapshot = await pageService.deletePagePermanently(
      parsed.id,
      session.user.id,
      parsed.confirmTitle
    );
    revalidatePages(snapshot.slug);
    await recordAdminAudit({
      actorId: session.user.id,
      action: "page.delete_permanent",
      entityType: "page",
      entityId: snapshot.id,
      details: { slug: snapshot.slug, title: before?.title ?? snapshot.title },
    });
    return { slug: snapshot.slug };
  }, "Failed to permanently delete page");
}

export async function getPageRevisionsAction(
  id: string
): Promise<ActionResult<Awaited<ReturnType<typeof pageService.getPageRevisions>>>> {
  return toActionResult(async () => {
    await requireAdmin();
    return pageService.getPageRevisions(id);
  }, "Failed to load revision history");
}
