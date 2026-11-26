"use server";

import { revalidatePath } from "next/cache";

import { toActionResult, type ActionResult } from "@/lib/action-result";
import { requireAdmin } from "@/lib/auth";
import { recordAdminAudit } from "@/features/audit/service";
import * as landingService from "./service";
import type { CreateLandingPageInput, UpdateLandingPageInput } from "./types";

// ============================================================================
// LANDING PAGE ADMIN ACTIONS (Studio, admin-only, audited)
// ----------------------------------------------------------------------------
// Every mutation checks requireAdmin on the server and writes the admin audit
// trail, like existing Studio actions. Results return ActionResult via
// toActionResult (never throw: Next would replace the message with a digest).
// ============================================================================

function revalidateLanding(slug: string) {
  revalidatePath(`/go/${slug}`);
  revalidatePath("/sitemap.xml");
  revalidatePath("/admin/content");
}

export async function createLandingPageAction(
  input: CreateLandingPageInput,
): Promise<ActionResult<{ id: string; slug: string }>> {
  return toActionResult(async () => {
    const session = await requireAdmin();
    const created = await landingService.createLandingPage(input);
    await recordAdminAudit({
      actorId: session.user.id,
      action: "landing_page.create",
      entityType: "landing_page",
      entityId: created.id,
      details: { slug: created.slug, campaign: created.campaignName },
    });
    revalidateLanding(created.slug);
    return { id: created.id, slug: created.slug };
  }, "Failed to create landing page");
}

export async function updateLandingPageAction(
  input: UpdateLandingPageInput,
): Promise<ActionResult<{ id: string; slug: string }>> {
  return toActionResult(async () => {
    const session = await requireAdmin();
    const before = await landingService.getAdminLandingPageById(input.id);
    const updated = await landingService.updateLandingPage(input.id, input);
    await recordAdminAudit({
      actorId: session.user.id,
      action: "landing_page.update",
      entityType: "landing_page",
      entityId: updated.id,
      details: { oldSlug: before?.slug ?? null, newSlug: updated.slug },
    });
    revalidateLanding(updated.slug);
    if (before && before.slug !== updated.slug) revalidateLanding(before.slug);
    return { id: updated.id, slug: updated.slug };
  }, "Failed to update landing page");
}

export async function publishLandingPageAction(id: string): Promise<ActionResult<{ slug: string }>> {
  return toActionResult(async () => {
    const session = await requireAdmin();
    const published = await landingService.publishLandingPage(id);
    await recordAdminAudit({
      actorId: session.user.id,
      action: "landing_page.publish",
      entityType: "landing_page",
      entityId: id,
      details: { slug: published.slug, status: "published" },
    });
    revalidateLanding(published.slug);
    return { slug: published.slug };
  }, "Failed to publish landing page");
}

export async function unpublishLandingPageAction(id: string): Promise<ActionResult<{ slug: string }>> {
  return toActionResult(async () => {
    const session = await requireAdmin();
    const draft = await landingService.unpublishLandingPage(id);
    await recordAdminAudit({
      actorId: session.user.id,
      action: "landing_page.unpublish",
      entityType: "landing_page",
      entityId: id,
      details: { slug: draft.slug, status: "draft" },
    });
    revalidateLanding(draft.slug);
    return { slug: draft.slug };
  }, "Failed to unpublish landing page");
}

export async function archiveLandingPageAction(id: string): Promise<ActionResult<{ slug: string }>> {
  return toActionResult(async () => {
    const session = await requireAdmin();
    const archived = await landingService.archiveLandingPage(id);
    await recordAdminAudit({
      actorId: session.user.id,
      action: "landing_page.archive",
      entityType: "landing_page",
      entityId: id,
      details: { slug: archived.slug, status: "archived" },
    });
    revalidateLanding(archived.slug);
    return { slug: archived.slug };
  }, "Failed to archive landing page");
}

export async function restoreArchivedLandingPageAction(
  id: string,
): Promise<ActionResult<{ slug: string }>> {
  return toActionResult(async () => {
    const session = await requireAdmin();
    const draft = await landingService.restoreArchivedLandingPage(id);
    await recordAdminAudit({
      actorId: session.user.id,
      action: "landing_page.restore_from_archive",
      entityType: "landing_page",
      entityId: id,
      details: { slug: draft.slug, status: "draft" },
    });
    revalidateLanding(draft.slug);
    return { slug: draft.slug };
  }, "Failed to restore landing page");
}

export async function moveLandingPageToTrashAction(
  id: string,
): Promise<ActionResult<{ slug: string }>> {
  return toActionResult(async () => {
    const session = await requireAdmin();
    const trashed = await landingService.moveLandingPageToTrash(id);
    await recordAdminAudit({
      actorId: session.user.id,
      action: "landing_page.move_to_trash",
      entityType: "landing_page",
      entityId: id,
      details: { slug: trashed.slug, fromStatus: trashed.trashedFromStatus ?? null },
    });
    revalidateLanding(trashed.slug);
    return { slug: trashed.slug };
  }, "Failed to move landing page to Trash");
}

export async function restoreLandingPageFromTrashAction(
  id: string,
): Promise<ActionResult<{ slug: string }>> {
  return toActionResult(async () => {
    const session = await requireAdmin();
    // Audit is written inside the service (it owns the actor in its signature
    // for the shared Trash page the coordinator wires).
    const restored = await landingService.restoreLandingPageFromTrash(id, session.user.id);
    revalidateLanding(restored.slug);
    return { slug: restored.slug };
  }, "Failed to restore landing page from Trash");
}

export async function deleteLandingPagePermanentlyAction(
  id: string,
  confirmTitle: string,
): Promise<ActionResult<{ id: string }>> {
  return toActionResult(async () => {
    const session = await requireAdmin();
    const current = await landingService.getAdminLandingPageById(id);
    // Audit (with the title/slug/id snapshot) is written inside the service.
    await landingService.deleteLandingPagePermanently(id, session.user.id, confirmTitle);
    if (current) revalidateLanding(current.slug);
    return { id };
  }, "Failed to permanently delete landing page");
}
