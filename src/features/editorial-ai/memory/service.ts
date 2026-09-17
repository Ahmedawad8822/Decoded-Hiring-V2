// ============================================================================
// EDITORIAL AI — MEMORY SERVICE
// ----------------------------------------------------------------------------
// CRUD for editorial_memory rows. Active, non-archived items are injected
// into every generation prompt. Admin manages the full lifecycle.
// ============================================================================

import { getDb, editorial_memory, type EditorialMemory } from "@/lib/db";
import { eq, and, isNull, desc } from "drizzle-orm";
import type { ActiveMemoryItem } from "../skills/types";
import type { CreateMemoryInput, UpdateMemoryInput } from "./types";
import { logAudit } from "../audit/service";

/**
 * Return active, non-archived memory items for generation context.
 * Only these items are ever passed to the LLM.
 */
export async function getActiveMemory(): Promise<ActiveMemoryItem[]> {
  const db = await getDb();
  const rows = await db
    .select({
      category: editorial_memory.category,
      content: editorial_memory.content,
    })
    .from(editorial_memory)
    .where(and(eq(editorial_memory.active, true), isNull(editorial_memory.archivedAt)))
    .orderBy(editorial_memory.category, editorial_memory.createdAt);

  return rows.map((r) => ({ category: r.category, content: r.content }));
}

/**
 * Return ALL memory items (including archived) for admin management.
 */
export async function getAllMemory(): Promise<EditorialMemory[]> {
  const db = await getDb();
  return db.select().from(editorial_memory).orderBy(desc(editorial_memory.createdAt));
}

export async function getMemory(id: string): Promise<EditorialMemory | null> {
  const db = await getDb();
  const row = await db.select().from(editorial_memory).where(eq(editorial_memory.id, id)).get();
  return row || null;
}

export async function createMemory(input: CreateMemoryInput, actor: string): Promise<EditorialMemory> {
  const db = await getDb();
  const now = new Date();
  const id = `mem_${crypto.randomUUID().slice(0, 12)}`;

  await db.insert(editorial_memory).values({
    id,
    category: input.category,
    content: input.content,
    active: true,
    createdBy: actor,
    createdAt: now,
    updatedAt: now,
  });

  await logAudit({
    actor,
    entityType: "editorial_memory",
    entityId: id,
    action: "memory_created",
    detail: { category: input.category },
  });

  const created = await getMemory(id);
  if (!created) throw new Error("Failed to retrieve created memory item");
  return created;
}

export async function updateMemory(id: string, input: UpdateMemoryInput, actor: string): Promise<EditorialMemory> {
  const db = await getDb();
  const now = new Date();

  const updates: Record<string, unknown> = { updatedAt: now };
  if (input.category !== undefined) updates.category = input.category;
  if (input.content !== undefined) updates.content = input.content;
  if (input.active !== undefined) updates.active = input.active;

  await db.update(editorial_memory).set(updates).where(eq(editorial_memory.id, id));

  await logAudit({
    actor,
    entityType: "editorial_memory",
    entityId: id,
    action: "memory_updated",
    detail: { changedFields: Object.keys(updates).filter((k) => k !== "updatedAt") },
  });

  const updated = await getMemory(id);
  if (!updated) throw new Error("Failed to retrieve updated memory item");
  return updated;
}

export async function archiveMemory(id: string, actor: string): Promise<EditorialMemory> {
  const db = await getDb();
  const now = new Date();
  await db
    .update(editorial_memory)
    .set({ active: false, archivedAt: now, updatedAt: now })
    .where(eq(editorial_memory.id, id));

  await logAudit({
    actor,
    entityType: "editorial_memory",
    entityId: id,
    action: "memory_archived",
  });

  const updated = await getMemory(id);
  if (!updated) throw new Error("Failed to retrieve archived memory item");
  return updated;
}

export async function unarchiveMemory(id: string, actor: string): Promise<EditorialMemory> {
  const db = await getDb();
  const now = new Date();
  await db
    .update(editorial_memory)
    .set({ active: true, archivedAt: null, updatedAt: now })
    .where(eq(editorial_memory.id, id));

  await logAudit({
    actor,
    entityType: "editorial_memory",
    entityId: id,
    action: "memory_restored",
  });

  const updated = await getMemory(id);
  if (!updated) throw new Error("Failed to retrieve restored memory item");
  return updated;
}
