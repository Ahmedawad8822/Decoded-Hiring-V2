// ============================================================================
// EDITORIAL AI — MEMORY SERVER ACTIONS
// ----------------------------------------------------------------------------
// Server Actions for CRUD on editorial_memory.
// ============================================================================

"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth";
import { toActionResult } from "@/lib/action-result";
import { createMemory, updateMemory, archiveMemory, unarchiveMemory } from "./service";
import type { CreateMemoryInput, UpdateMemoryInput } from "./types";
import { createMemorySchema, updateMemorySchema } from "./types";

export async function createMemoryAction(input: CreateMemoryInput) {
  return toActionResult(async () => {
    const session = await requireAdmin();
    const parsedInput = createMemorySchema.parse(input);
    const result = await createMemory(parsedInput, session.user.id);
    revalidatePath("/admin/editorial/memory");
    return result;
  }, "Failed to create memory item");
}

export async function updateMemoryAction(id: string, input: UpdateMemoryInput) {
  return toActionResult(async () => {
    const session = await requireAdmin();
    const parsedInput = updateMemorySchema.parse(input);
    const result = await updateMemory(id, parsedInput, session.user.id);
    revalidatePath("/admin/editorial/memory");
    return result;
  }, "Failed to update memory item");
}

export async function archiveMemoryAction(id: string) {
  return toActionResult(async () => {
    const session = await requireAdmin();
    const result = await archiveMemory(id, session.user.id);
    revalidatePath("/admin/editorial/memory");
    return result;
  }, "Failed to archive memory item");
}

export async function unarchiveMemoryAction(id: string) {
  return toActionResult(async () => {
    const session = await requireAdmin();
    const result = await unarchiveMemory(id, session.user.id);
    revalidatePath("/admin/editorial/memory");
    return result;
  }, "Failed to restore memory item");
}
