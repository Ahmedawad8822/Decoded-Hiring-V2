// ============================================================================
// EDITORIAL AI — DRAFT SERVICE
// ----------------------------------------------------------------------------
// Full lifecycle: generate → review → approve → publish (→ Guide / Field Note).
//
// Generation pipeline (Mission 07 §5):
//   1. Build retrieval query from topic + audience + angle.
//   2. FTS5 retrieve knowledge chunks (bounded to topK=8).
//   3. Retrieve active editorial memory.
//   4. Assemble bounded GenerationContext.
//   5. Call the LLM provider with AHA_AUTHORITY_V1 skill prompt.
//   6. Validate structured output against LLMDraftOutputSchema.
//   7. Save draft + provenance (chunk→source mapping) in D1.
//   8. Audit-log: draft_generated.
//
// Publishing (Mission 07 §6):
//   - APPROVED drafts can be published once.
//   - Idempotency: slug uniqueness on guides/field_notes prevents duplicates.
//   - If the target entity already exists (retry after partial failure), the
//     draft is relinked — no duplicate entity is created.
// ============================================================================

import { getDb } from "@/lib/db";
import {
  editorial_drafts,
  editorial_draft_sources,
  knowledge_sources,
  knowledge_chunks,
  guides,
  fieldNotes,
} from "@/lib/db";
import { eq, desc, and } from "drizzle-orm";
import type { LlmBlock, ContextChunk } from "../skills/types";
import type { ContentBlock } from "@/features/publishing/types";
import { resolveProvider } from "../providers";
import { retrieveKnowledge } from "../knowledge/retrieval";
import { getActiveMemory } from "../memory/service";
import { logAudit } from "../audit/service";
import { createGuide } from "@/features/guides/service";
import { createFieldNote } from "@/features/field-notes/service";
import { isUniqueConstraintError } from "@/lib/db/sqlite-errors";
import { AHA_AUTHORITY_V1, SKILL_VERSION } from "../skills/aha-authority";
import type {
  DraftContentType,
  DraftStatus,
  GenerateDraftInput,
  UpdateDraftInput,
  EditorialDraftWithSources,
  DraftSourceProvenance,
} from "./types";

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

export async function generateDraft(
  input: GenerateDraftInput,
  actor: string
): Promise<EditorialDraftWithSources> {
  const provider = await resolveProvider();

  // 1-2. Retrieve knowledge based on topic, audience, angle
  const searchQuery = [input.topic, input.audience, input.angle]
    .filter(Boolean)
    .join(" ");

  const retrievedChunks = await retrieveKnowledge({
    query: searchQuery,
    topK: 8,
    sourceIds: input.sourceIds,
  });

  // 3. Retrieve active editorial memory
  const memory = await getActiveMemory();

  // 4. Assemble bounded context
  const contextChars = retrievedChunks.reduce((sum, c) => sum + c.content.length, 0);
  const context = {
    retrievedChunks: retrievedChunks.map((c) => ({
      chunkId: c.chunkId,
      sourceId: c.sourceId,
      sourceTitle: c.sourceTitle,
      heading: c.heading,
      ordinal: c.ordinal,
      content: c.content,
      rank: c.rank,
    })),
    memory: memory.map((m) => ({ category: m.category, content: m.content })),
    contextChars,
  };

  // 5-6. Call LLM provider (validates output internally)
  const llmOutput = await provider.generateDraft({
    skillId: AHA_AUTHORITY_V1.id,
    context: {
      retrievedChunks: context.retrievedChunks as ContextChunk[],
      memory: context.memory,
      contextChars,
    },
    params: {
      contentType: input.contentType,
      topic: input.topic,
      workingTitle: input.workingTitle,
      audience: input.audience,
      angle: input.angle,
      objective: input.objective,
      notes: input.notes,
    },
  });

  // 7. Save draft + provenance
  const db = await getDb();
  const now = new Date();
  const draftId = `draft_${crypto.randomUUID().slice(0, 12)}`;

  await db.insert(editorial_drafts).values({
    id: draftId,
    contentType: input.contentType,
    title: "Draft: " + llmOutput.title,
    slug: llmOutput.slugSuggestion,
    excerpt: llmOutput.excerpt,
    body: JSON.stringify(llmOutput.contentBlocks),
    metaTitle: llmOutput.metaTitle,
    metaDescription: llmOutput.metaDescription,
    status: "DRAFT" as DraftStatus,
    skillId: AHA_AUTHORITY_V1.id,
    skillVersion: SKILL_VERSION,
    provider: provider.name,
    model: process.env.EDITORIAL_MODEL_NAME ?? "fake",
    createdBy: actor,
    createdAt: now,
    updatedAt: now,
  });

  // Save source provenance (chunk → source mapping with rank)
  for (let i = 0; i < retrievedChunks.length; i++) {
    const chunk = retrievedChunks[i]!;
    await db.insert(editorial_draft_sources).values({
      id: `eds_${crypto.randomUUID().slice(0, 12)}`,
      draftId,
      sourceId: chunk.sourceId,
      chunkId: chunk.chunkId,
      rank: i,
      createdAt: now,
    });
  }

  await logAudit({
    actor,
    entityType: "editorial_draft",
    entityId: draftId,
    action: "draft_generated",
    detail: {
      contentType: input.contentType,
      topic: input.topic,
      chunkCount: retrievedChunks.length,
      provider: provider.name,
    },
  });

  const draft = await getDraft(draftId);
  if (!draft) throw new Error("Failed to retrieve generated draft");
  return draft;
}

// ---------------------------------------------------------------------------
// Retrieval
// ---------------------------------------------------------------------------

export async function getDraft(id: string): Promise<EditorialDraftWithSources | null> {
  const db = await getDb();

  const draft = await db
    .select()
    .from(editorial_drafts)
    .where(eq(editorial_drafts.id, id))
    .get();

  if (!draft) return null;

  const provenanceRows = await db
    .select({
      sourceId: knowledge_sources.id,
      sourceTitle: knowledge_sources.title,
      chunkId: editorial_draft_sources.chunkId,
      heading: knowledge_chunks.heading,
      ordinal: knowledge_chunks.ordinal,
      content: knowledge_chunks.content,
      rank: editorial_draft_sources.rank,
    })
    .from(editorial_draft_sources)
    .innerJoin(knowledge_sources, eq(knowledge_sources.id, editorial_draft_sources.sourceId))
    .innerJoin(knowledge_chunks, eq(knowledge_chunks.id, editorial_draft_sources.chunkId))
    .where(eq(editorial_draft_sources.draftId, id))
    .orderBy(editorial_draft_sources.rank);

  let body: LlmBlock[] = [];
  try {
    body = JSON.parse(draft.body || "[]");
  } catch {
    body = [];
  }

  return {
    id: draft.id,
    contentType: draft.contentType as DraftContentType,
    title: draft.title,
    slug: draft.slug,
    excerpt: draft.excerpt,
    body,
    metaTitle: draft.metaTitle,
    metaDescription: draft.metaDescription,
    status: draft.status as DraftStatus,
    skillId: draft.skillId,
    skillVersion: draft.skillVersion,
    provider: draft.provider,
    model: draft.model,
    createdBy: draft.createdBy,
    reviewedBy: draft.reviewedBy,
    approvedBy: draft.approvedBy,
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt,
    submittedAt: draft.submittedAt,
    approvedAt: draft.approvedAt,
    rejectedAt: draft.rejectedAt,
    publishedAt: draft.publishedAt,
    publishedEntityId: draft.publishedEntityId,
    publishedEntityType: draft.publishedEntityType as "guide" | "field_note" | null,
    sources: provenanceRows as DraftSourceProvenance[],
  };
}

export async function listDrafts(opts?: {
  status?: DraftStatus;
  contentType?: DraftContentType;
}): Promise<EditorialDraftWithSources[]> {
  const db = await getDb();

  const conditions: Parameters<typeof and>[0][] = [];
  if (opts?.status) conditions.push(eq(editorial_drafts.status, opts.status));
  if (opts?.contentType) conditions.push(eq(editorial_drafts.contentType, opts.contentType));

  const drafts =
    conditions.length > 0
      ? await db.select().from(editorial_drafts).where(and(...conditions)).orderBy(desc(editorial_drafts.updatedAt))
      : await db.select().from(editorial_drafts).orderBy(desc(editorial_drafts.updatedAt));

  const results: EditorialDraftWithSources[] = [];
  for (const draft of drafts) {
    const withSources = await getDraft(draft.id);
    if (withSources) results.push(withSources);
  }
  return results;
}

// ---------------------------------------------------------------------------
// Edits
// ---------------------------------------------------------------------------

export async function updateDraft(
  id: string,
  input: UpdateDraftInput,
  actor: string
): Promise<EditorialDraftWithSources> {
  const db = await getDb();
  const now = new Date();

  const updates: Partial<typeof editorial_drafts.$inferInsert> = { updatedAt: now };
  if (input.title !== undefined) updates.title = input.title;
  if (input.slug !== undefined) updates.slug = input.slug;
  if (input.excerpt !== undefined) updates.excerpt = input.excerpt;
  if (input.body !== undefined) updates.body = JSON.stringify(input.body);
  if (input.metaTitle !== undefined) updates.metaTitle = input.metaTitle;
  if (input.metaDescription !== undefined) updates.metaDescription = input.metaDescription;

  await db.update(editorial_drafts).set(updates).where(eq(editorial_drafts.id, id));

  await logAudit({
    actor,
    entityType: "editorial_draft",
    entityId: id,
    action: "draft_edited",
    detail: { changedFields: Object.keys(updates).filter((k) => k !== "updatedAt") },
  });

  const updated = await getDraft(id);
  if (!updated) throw new Error("Failed to retrieve updated draft");
  return updated;
}

// ---------------------------------------------------------------------------
// Lifecycle transitions
// ---------------------------------------------------------------------------

export async function submitForReview(id: string, actor: string): Promise<EditorialDraftWithSources> {
  return transitionDraft(id, "DRAFT", "IN_REVIEW", actor, "draft_submitted", undefined);
}

export async function sendBack(id: string, actor: string, note?: string): Promise<EditorialDraftWithSources> {
  return transitionDraft(id, "IN_REVIEW", "DRAFT", actor, "draft_sent_back", note ? { note } : undefined);
}

export async function approve(id: string, actor: string): Promise<EditorialDraftWithSources> {
  const draft = await getDraft(id);
  if (!draft) throw new Error(`Draft with id "${id}" not found`);
  if (draft.status !== "IN_REVIEW") {
    throw new Error(`Cannot approve draft in "${draft.status}" status. Not in IN_REVIEW status.`);
  }

  const db = await getDb();
  const now = new Date();
  await db
    .update(editorial_drafts)
    .set({
      status: "APPROVED" as DraftStatus,
      reviewedBy: actor,
      approvedBy: actor,
      approvedAt: now,
      updatedAt: now,
    })
    .where(eq(editorial_drafts.id, id));

  await logAudit({ actor, entityType: "editorial_draft", entityId: id, action: "draft_approved" });

  const updated = await getDraft(id);
  return updated!;
}

export async function rejectDraft(id: string, actor: string, reason?: string): Promise<EditorialDraftWithSources> {
  const draft = await getDraft(id);
  if (!draft) throw new Error(`Draft with id "${id}" not found`);

  const db = await getDb();
  const now = new Date();
  await db
    .update(editorial_drafts)
    .set({
      status: "REJECTED" as DraftStatus,
      reviewedBy: actor,
      rejectedAt: now,
      updatedAt: now,
    })
    .where(eq(editorial_drafts.id, id));

  await logAudit({
    actor,
    entityType: "editorial_draft",
    entityId: id,
    action: "draft_rejected",
    detail: reason ? { reason } : undefined,
  });

  const updated = await getDraft(id);
  return updated!;
}

/**
 * APPROVED → PUBLISHED. Creates a Guide or Field Note and links the draft.
 *
 * Idempotency strategy (Mission 07 §6):
 * - If already PUBLISHED → return existing entity (no-op).
 * - Slug uniqueness on guides/field_notes is the authoritative backstop.
 * - On slug conflict (concurrent/retry), look up the existing entity and relink.
 */
export async function publishDraft(id: string, actor: string): Promise<{ entityType: "guide" | "field_note"; entityId: string }> {
  const draft = await getDraft(id);
  if (!draft) throw new Error(`Draft with id "${id}" not found`);

  // Idempotency: already published → return existing entity (no-op)
  if (draft.publishedEntityId && draft.publishedEntityType) {
    return { entityType: draft.publishedEntityType, entityId: draft.publishedEntityId };
  }

  if (draft.status !== "APPROVED") {
    throw new Error(`Cannot publish draft in "${draft.status}" status. Not in APPROVED status.`);
  }

  const contentBlocks = toContentBlocks(draft.body);
  const now = new Date();

  try {
    if (draft.contentType === "GUIDE") {
      const guide = await createGuide({
        title: draft.title,
        slug: draft.slug,
        excerpt: draft.excerpt ?? undefined,
        body: contentBlocks,
        metaTitle: draft.metaTitle ?? undefined,
        metaDescription: draft.metaDescription ?? undefined,
        author: "Ahmed Awad",
        coverImage: null,
      });
      await linkPublishedDraft(id, "guide", guide.id, actor, now);
      return { entityType: "guide", entityId: guide.id };
    } else {
      const fieldNote = await createFieldNote({
        title: draft.title,
        slug: draft.slug,
        excerpt: draft.excerpt ?? undefined,
        body: contentBlocks,
        metaTitle: draft.metaTitle ?? undefined,
        metaDescription: draft.metaDescription ?? undefined,
        author: "Ahmed Awad",
        coverImage: null,
      });
      await linkPublishedDraft(id, "field_note", fieldNote.id, actor, now);
      return { entityType: "field_note", entityId: fieldNote.id };
    }
  } catch (err) {
    // Slug conflict → look up existing entity and relink
    if (isUniqueConstraintError(err)) {
      const { entityType, entityId } = await findExistingEntity(draft.contentType, draft.slug);
      if (entityType && entityId) {
        await linkPublishedDraft(id, entityType, entityId, actor, now);
        return { entityType, entityId };
      }
    }
    throw err;
  }
}

async function linkPublishedDraft(
  draftId: string,
  entityType: "guide" | "field_note",
  entityId: string,
  actor: string,
  now: Date
): Promise<void> {
  const db = await getDb();
  await db
    .update(editorial_drafts)
    .set({
      status: "PUBLISHED" as DraftStatus,
      publishedEntityId: entityId,
      publishedEntityType: entityType,
      publishedAt: now,
      updatedAt: now,
    })
    .where(eq(editorial_drafts.id, draftId));

  await logAudit({
    actor,
    entityType: "editorial_draft",
    entityId: draftId,
    action: "draft_published",
    detail: { entityType, entityId },
  });
}

async function findExistingEntity(
  contentType: DraftContentType,
  slug: string
): Promise<{ entityType: "guide" | "field_note"; entityId: string } | { entityType: null; entityId: null }> {
  const db = await getDb();
  if (contentType === "GUIDE") {
    const guide = await db.select({ id: guides.id }).from(guides).where(eq(guides.slug, slug)).get();
    if (guide) return { entityType: "guide", entityId: guide.id };
  } else {
    const fn = await db.select({ id: fieldNotes.id }).from(fieldNotes).where(eq(fieldNotes.slug, slug)).get();
    if (fn) return { entityType: "field_note", entityId: fn.id };
  }
  return { entityType: null, entityId: null };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toContentBlocks(blocks: LlmBlock[]): ContentBlock[] {
  return blocks.map((b) => {
    const id = `cb_${crypto.randomUUID().slice(0, 12)}`;
    if (b.type === "heading") {
      return {
        id,
        type: "heading",
        level: b.level,
        text: b.text,
        anchor: slugifyHeading(b.text),
      } as ContentBlock;
    }
    return { id, ...b } as ContentBlock;
  });
}

function slugifyHeading(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function transitionDraft(
  id: string,
  expectedStatus: DraftStatus,
  newStatus: DraftStatus,
  actor: string,
  auditAction: string,
  extraDetail?: Record<string, unknown>
): Promise<EditorialDraftWithSources> {
  const draft = await getDraft(id);
  if (!draft) throw new Error(`Draft with id "${id}" not found`);
  // Terminal state guard — PUBLISHED drafts cannot transition further.
  if (draft.status === "PUBLISHED") {
    throw new Error(`Cannot ${auditAction} draft — already PUBLISHED.`);
  }
  if (draft.status !== expectedStatus) {
    throw new Error(
      `Cannot ${auditAction} draft in "${draft.status}" status. Not in ${expectedStatus} status.`
    );
  }

  const db = await getDb();
  const now = new Date();
  const updates: Partial<typeof editorial_drafts.$inferInsert> = {
    status: newStatus,
    updatedAt: now,
  };

  if (newStatus === "IN_REVIEW") updates.submittedAt = now;
  if (newStatus === "APPROVED") {
    updates.reviewedBy = actor;
    updates.approvedBy = actor;
    updates.approvedAt = now;
  }

  await db.update(editorial_drafts).set(updates).where(eq(editorial_drafts.id, id));

  await logAudit({
    actor,
    entityType: "editorial_draft",
    entityId: id,
    action: auditAction,
    detail: extraDetail,
  });

  const updated = await getDraft(id);
  return updated!;
}

// Re-export types for convenience.
export type { EditorialDraftWithSources, DraftSourceProvenance };
