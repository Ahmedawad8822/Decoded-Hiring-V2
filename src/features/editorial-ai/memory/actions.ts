// ============================================================================
// EDITORIAL AI — MEMORY SERVER ACTIONS
// ----------------------------------------------------------------------------
// Server Actions for CRUD on editorial_memory.
// ============================================================================

"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth";
import { createMemory, updateMemory, archiveMemory, unarchiveMemory } from "./service";
import type { CreateMemoryInput, UpdateMemoryInput } from "./types";

export async function createMemoryAction(input: CreateMemoryInput) {
  const session = await requireAdmin();
  const result = await createMemory(input, session.user.id);
  revalidatePath("/admin/editorial/memory");
  return result;
}

export async function updateMemoryAction(id: string, input: UpdateMemoryInput) {
  const session = await requireAdmin();
  const result = await updateMemory(id, input, session.user.id);
  revalidatePath("/admin/editorial/memory");
  return result;
}

export async function archiveMemoryAction(id: string) {
  const session = await requireAdmin();
  const result = await archiveMemory(id, session.user.id);
  revalidatePath("/admin/editorial/memory");
  return result;
}

export async function unarchiveMemoryAction(id: string) {
  const session = await requireAdmin();
  const result = await unarchiveMemory(id, session.user.id);
  revalidatePath("/admin/editorial/memory");
  return result;
}
