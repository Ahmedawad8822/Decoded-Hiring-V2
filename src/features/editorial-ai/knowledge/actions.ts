// ============================================================================
// KNOWLEDGE — SERVER ACTIONS
// ----------------------------------------------------------------------------
// Server Actions for knowledge source operations: ingest, archive,
// re-ingest, and delete. File upload is handled via the API route
// /api/editorial-ai/knowledge/upload (multipart form data).
// ============================================================================

"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth";
import { toActionResult } from "@/lib/action-result";
import { ingestKnowledgeSource, archiveKnowledgeSource, reingestKnowledgeSource } from "./service";
import { deleteKnowledgeSource } from "./storage";

export async function ingestKnowledgeAction(sourceId: string) {
  return toActionResult(async () => {
    const session = await requireAdmin();
    const result = await ingestKnowledgeSource(sourceId, session.user.id);
    revalidatePath("/admin/knowledge");
    revalidatePath(`/admin/knowledge/${sourceId}`);
    return result;
  }, "Failed to ingest knowledge source");
}

export async function archiveKnowledgeAction(sourceId: string) {
  return toActionResult(async () => {
    const session = await requireAdmin();
    const result = await archiveKnowledgeSource(sourceId, session.user.id);
    revalidatePath("/admin/knowledge");
    revalidatePath(`/admin/knowledge/${sourceId}`);
    return result;
  }, "Failed to archive knowledge source");
}

export async function reingestKnowledgeAction(sourceId: string) {
  return toActionResult(async () => {
    const session = await requireAdmin();
    const result = await reingestKnowledgeSource(sourceId, session.user.id);
    revalidatePath("/admin/knowledge");
    revalidatePath(`/admin/knowledge/${sourceId}`);
    return result;
  }, "Failed to re-ingest knowledge source");
}

export async function deleteKnowledgeAction(sourceId: string) {
  return toActionResult(async () => {
    await requireAdmin();
    await deleteKnowledgeSource(sourceId);
    revalidatePath("/admin/knowledge");
    return { success: true, id: sourceId };
  }, "Failed to delete knowledge source");
}
