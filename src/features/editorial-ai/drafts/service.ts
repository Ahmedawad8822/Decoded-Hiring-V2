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
//   - Idempotency is owned by `editorial_publications` (one row per draft,
//     UNIQUE(draftId)): retries/simultaneous publishes resolve to the same
//     target — NOT by slug (slug is an unrelated-collision backstop).
//   - The target (Guide/Field Note) is created, PUBLISHED, and verified on the
//     public resolver BEFORE the editorial draft is marked PUBLISHED. A failure
//     at any step leaves the draft truthful (not PUBLISHED).
//   - Unrelated guide/field-note with the same slug → error, never relink.
//   - Crash recovery is anchored on entityId, set on the reservation
//     immediately after the target is created. A crashed publish leaves an
//     owned reservation; the next publishDraft resumes the EXACT target by ID
//     — never a slug that could collide with an unrelated guide/field note.
//
// D1 transaction note: Drizzle 0.45.2's D1 session exposes db.transaction()
// via BEGIN/COMMIT/ROLLBACK. However, createGuide/publishGuide/etc. each call
// getDb() independently and cannot share a transaction context. The reservation
// + CAS pattern below achieves equivalent atomicity at the application level:
// UNIQUE(draft_id) serializes concurrent publishes, CAS on status detects
// stale publishes, and finalizeOwnedPublication handles crash recovery by entityId.
// ============================================================================

import { getDb } from "@/lib/db";
import type { Database, EditorialPublication } from "@/lib/db";
import {
  editorial_drafts,
  editorial_draft_sources,
  editorial_publications,
  knowledge_sources,
  knowledge_chunks,
  users,
} from "@/lib/db";
import { eq, desc, and, inArray } from "drizzle-orm";
import type { LlmBlock, ContextChunk } from "../skills/types";
import type { LLMProvider } from "../providers";
import type { ContentBlock } from "@/features/publishing/types";
import { resolveProvider } from "../providers";
import { retrieveKnowledge } from "../knowledge/retrieval";
import { getActiveMemory } from "../memory/service";
import { logAudit } from "../audit/service";
import { createGuide, getAdminGuideById, publishGuide, unpublishGuide } from "@/features/guides/service";
import { createFieldNote, getAdminFieldNoteById, publishFieldNote, unpublishFieldNote } from "@/features/field-notes/service";
import { isUniqueConstraintError } from "@/lib/db/sqlite-errors";
import { AHA_AUTHORITY_V1, SKILL_VERSION, NoRelevantEvidenceError } from "../skills/aha-authority";
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
  actor: string,
  opts?: { provider?: LLMProvider }
): Promise<EditorialDraftWithSources> {
  // Provider boundary (Mission 07 §3): use the injected provider when
  // supplied (tests/dev), otherwise resolve from env — which throws
  // EditorialProviderNotConfiguredError when unset (fail-closed, no fake).
  const provider = opts?.provider ?? (await resolveProvider());

  // 1-2. Retrieve knowledge based on topic, audience, angle
  const searchQuery = [input.topic, input.audience, input.angle]
    .filter(Boolean)
    .join(" ");

  const retrievedChunks = await retrieveKnowledge({
    query: searchQuery,
    topK: 8,
    sourceIds: input.sourceIds,
  });

  // Evidence-first (Mission 07 §4): never generate a groundless draft. The
  // provider is only called when we actually have retrieved evidence.
  if (retrievedChunks.length === 0) {
    throw new NoRelevantEvidenceError();
  }

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

/** Shared assembler: turn a raw draft row + its provenance into the public type. */
function assembleDraft(
  draft: typeof editorial_drafts.$inferSelect,
  provenance: DraftSourceProvenance[],
): EditorialDraftWithSources {
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
    sources: provenance,
  };
}

/** Fetch provenance rows for a set of drafts in a single query (no N+1). */
async function fetchProvenanceForDrafts(
  db: Database,
  draftIds: string[],
): Promise<Map<string, DraftSourceProvenance[]>> {
  const result = new Map<string, DraftSourceProvenance[]>();
  draftIds.forEach((id) => result.set(id, []));
  if (draftIds.length === 0) return result;

  const rows = await db
    .select({
      draftId: editorial_draft_sources.draftId,
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
    .where(inArray(editorial_draft_sources.draftId, draftIds))
    .orderBy(editorial_draft_sources.rank);

  for (const row of rows) {
    const arr = result.get(row.draftId);
    if (arr) arr.push(row as unknown as DraftSourceProvenance);
  }
  return result;
}

export async function getDraft(id: string): Promise<EditorialDraftWithSources | null> {
  const db = await getDb();

  const draft = await db
    .select()
    .from(editorial_drafts)
    .where(eq(editorial_drafts.id, id))
    .get();

  if (!draft) return null;

  const provenance = await fetchProvenanceForDrafts(db, [id]);
  return assembleDraft(draft, provenance.get(id) ?? []);
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
      ? await db
          .select()
          .from(editorial_drafts)
          .where(and(...conditions))
          .orderBy(desc(editorial_drafts.updatedAt))
      : await db.select().from(editorial_drafts).orderBy(desc(editorial_drafts.updatedAt));

  if (drafts.length === 0) return [];

  // One round-trip for ALL provenance (fixes the N+1 in the old per-draft
  // getDraft loop — previously 2 queries per draft).
  const provenance = await fetchProvenanceForDrafts(
    db,
    drafts.map((d) => d.id),
  );

  return drafts.map((draft) => assembleDraft(draft, provenance.get(draft.id) ?? []));
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
  const draft = await getDraft(id);
  if (!draft) throw new Error(`Draft with id "${id}" not found`);

  const updates: Partial<typeof editorial_drafts.$inferInsert> = { updatedAt: now };
  if (input.title !== undefined) updates.title = input.title;
  if (input.slug !== undefined) updates.slug = input.slug;
  if (input.excerpt !== undefined) updates.excerpt = input.excerpt;
  if (input.body !== undefined) updates.body = JSON.stringify(input.body);
  if (input.metaTitle !== undefined) updates.metaTitle = input.metaTitle;
  if (input.metaDescription !== undefined) updates.metaDescription = input.metaDescription;

  // A meaningful content edit to an APPROVED draft invalidates its approval:
  // the content must flow through review again, so revert to DRAFT and clear
  // the approval/published fields. A no-op or absent-field patch does NOT revoke.
  const contentFields = ["title", "slug", "excerpt", "body", "metaTitle", "metaDescription"];
  const isContentEdit = contentFields.some((f) => (input as Record<string, unknown>)[f] !== undefined);
  if (draft.status === "APPROVED" && isContentEdit) {
    updates.status = "DRAFT" as DraftStatus;
    updates.approvedBy = null;
    updates.approvedAt = null;
    updates.reviewedBy = null;
    updates.publishedEntityId = null;
    updates.publishedEntityType = null;
    updates.publishedAt = null;
  }

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
  // CAS: only advance IN_REVIEW → APPROVED. A concurrent state change (e.g. a
  // send-back/reject) moves 0 rows, which the re-check below detects.
  await db
    .update(editorial_drafts)
    .set({
      status: "APPROVED" as DraftStatus,
      reviewedBy: actor,
      approvedBy: actor,
      approvedAt: now,
      updatedAt: now,
    })
    .where(and(eq(editorial_drafts.id, id), eq(editorial_drafts.status, "IN_REVIEW")));

  await logAudit({ actor, entityType: "editorial_draft", entityId: id, action: "draft_approved" });

  const updated = await getDraft(id);
  if (!updated || updated.status !== "APPROVED") {
    throw new Error(`Cannot approve draft — status was "${updated?.status ?? "unknown"}" during approval (concurrent modification).`);
  }
  return updated;
}

export async function rejectDraft(id: string, actor: string, reason?: string): Promise<EditorialDraftWithSources> {
  const draft = await getDraft(id);
  if (!draft) throw new Error(`Draft with id "${id}" not found`);
  if (draft.status !== "IN_REVIEW") {
    throw new Error(`Cannot reject draft in "${draft.status}" status. Not in IN_REVIEW status.`);
  }

  const db = await getDb();
  const now = new Date();
  // CAS: only advance IN_REVIEW → REJECTED.
  await db
    .update(editorial_drafts)
    .set({
      status: "REJECTED" as DraftStatus,
      reviewedBy: actor,
      rejectedAt: now,
      updatedAt: now,
    })
    .where(and(eq(editorial_drafts.id, id), eq(editorial_drafts.status, "IN_REVIEW")));

  await logAudit({
    actor,
    entityType: "editorial_draft",
    entityId: id,
    action: "draft_rejected",
    detail: reason ? { reason } : undefined,
  });

  const updated = await getDraft(id);
  if (!updated || updated.status !== "REJECTED") {
    throw new Error(`Cannot reject draft — status was "${updated?.status ?? "unknown"}" during rejection (concurrent modification).`);
  }
  return updated;
}

/**
 * APPROVED → PUBLISHED. Creates a Guide or Field Note, actually *publishes* it
 * on the public resolver, verifies it, and records the authoritative draft→target
 * link in `editorial_publications`.
 *
 * Idempotency & concurrency (Mission 07 §6):
 * - A publication record is INSERTED FIRST (reservation, entityId NULL). Its
 *   `draft_id` is UNIQUE, so concurrent publishes of the SAME draft collapse
 *   onto one target: the loser detects the reservation, waits, and resolves to
 *   the winner. Identity is owned by the draft — NOT by slug.
 * - Retries after partial failure find the owned record (entityId set) and
 *   finalize it by ID — never by slug.
 * - An UNRELATED guide/field-note sharing the draft's slug makes creation fail;
 *   the reservation is cleaned up and the error is propagated (no relink).
 * - The editorial draft is marked PUBLISHED only AFTER the target is verified
 *   public. Any earlier failure leaves the draft truthful (not PUBLISHED).
 *
 * `opts` exposes two injection hooks used to test the publish/verify/CAS paths
 * deterministically (production callers omit them, using the real publishers).
 */
export async function publishDraft(
  id: string,
  actor: string,
  opts?: {
    /** Publish the target entity (defaults to publishGuide/publishFieldNote). */
    publishTarget?: (entityType: "guide" | "field_note", entityId: string) => Promise<unknown>;
    /** Hook invoked after the target entity is created, before it is published. */
    onCreateTarget?: (entityType: "guide" | "field_note", entityId: string) => Promise<void>;
  },
): Promise<{ entityType: "guide" | "field_note"; entityId: string }> {
  const db = await getDb();
  const draft = await getDraft(id);
  if (!draft) throw new Error(`Draft with id "${id}" not found`);

  const entityType = entityTypeFor(draft.contentType);
  const now = new Date();
  const publishTargetFn = opts?.publishTarget ?? defaultPublishTarget;

  // 1. Idempotency / crash recovery: a publication record already exists.
  //    Ownership is anchored on entityId — NEVER on slug — so an unrelated
  //    guide/field note sharing the draft's slug can never be claimed.
  const existing = await getPublicationByDraftId(db, draft.id);
  if (existing) {
    if (existing.entityId) {
      // Owned by an exact target → resume/finalize by ID (covers both
      // idempotent re-publish and crash recovery).
      return await finalizeOwnedPublication(
        db,
        draft,
        actor,
        existing.entityType as "guide" | "field_note",
        existing.entityId,
        now,
        publishTargetFn,
      );
    }
    // entityId is NULL → a concurrent publish reserved this draft but has
    // not yet created its target. Wait for it to finish (or time out).
    return await waitForPublication(db, draft.id);
  }

  if (draft.status !== "APPROVED") {
    throw new Error(`Cannot publish draft in "${draft.status}" status. Not in APPROVED status.`);
  }

  // 2. Reserve a publication record (authoritative, draft-owned identity).
  //    UNIQUE(draft_id) serializes concurrent publishes of the SAME draft.
  try {
    await db
      .insert(editorial_publications)
      .values({
        id: `pub_${crypto.randomUUID().slice(0, 12)}`,
        draftId: draft.id,
        entityType,
        entityId: null,
        createdAt: now,
      });
  } catch (err) {
    if (!isUniqueConstraintError(err)) throw err;
    // Another publish already reserved/owns this draft's publication.
    return await waitForPublication(db, draft.id);
  }

  try {
    // 3. Create the target entity (fails fast on an unrelated slug collision).
    const authorName = await resolveAuthorName(actor);
    const { entityId } = await createTarget(draft, authorName);

    // OWN the reservation with the exact target identity IMMEDIATELY — slug is
    // never used for ownership. If we crash after this, the next publishDraft
    // recovers THIS exact target by entityId, never a slug-colliding one.
    await db
      .update(editorial_publications)
      .set({ entityId })
      .where(eq(editorial_publications.draftId, draft.id));

    // (test hook) observe the freshly-created target before publishing it.
    await opts?.onCreateTarget?.(entityType, entityId);

    // 4. Actually publish the target so it is genuinely public.
    await publishTargetFn(entityType, entityId);

    // 5. Verify by exact ID (NOT slug) that the target is public.
    if (!(await verifyTargetPublic(entityType, entityId))) {
      throw new Error("Publication verification failed: target is not publicly visible after publish.");
    }

    // 6. CAS the draft to PUBLISHED and audit-log (entityId already bound).
    return await markDraftPublished(db, draft, actor, entityType, entityId, now);
  } catch (err) {
    // Creation/verification failed (unrelated slug collision, verification
    // failure, etc.): clean up our reservation so the draft stays truthful
    // (APPROVED) and a retry can proceed cleanly. Do NOT mark PUBLISHED.
    await deletePublicationByDraftId(db, draft.id);
    throw err;
  }
}

const DEFAULT_PUBLISH_AUTHOR = "Decoded Editorial";

function entityTypeFor(contentType: DraftContentType): "guide" | "field_note" {
  return contentType === "GUIDE" ? "guide" : "field_note";
}

/** Resolve a display author for the target from the actor's user row; fall
 * back to the actor id, then a safe constant — never a hardcoded personal name. */
async function resolveAuthorName(actor: string): Promise<string> {
  const db = await getDb();
  const user = await db
    .select({ name: users.name })
    .from(users)
    .where(eq(users.id, actor))
    .get();
  return user?.name ?? actor ?? DEFAULT_PUBLISH_AUTHOR;
}

/** Create the target publishing entity (Guide/Field Note) from the draft. */
async function createTarget(
  draft: EditorialDraftWithSources,
  authorName: string,
): Promise<{ entityType: "guide" | "field_note"; entityId: string }> {
  const contentBlocks = toContentBlocks(draft.body);
  if (draft.contentType === "GUIDE") {
    const guide = await createGuide({
      title: draft.title,
      slug: draft.slug,
      excerpt: draft.excerpt ?? undefined,
      body: contentBlocks,
      metaTitle: draft.metaTitle ?? undefined,
      metaDescription: draft.metaDescription ?? undefined,
      author: authorName,
      coverImage: null,
    });
    return { entityType: "guide", entityId: guide.id };
  }
  const fieldNote = await createFieldNote({
    title: draft.title,
    slug: draft.slug,
    excerpt: draft.excerpt ?? undefined,
    body: contentBlocks,
    metaTitle: draft.metaTitle ?? undefined,
    metaDescription: draft.metaDescription ?? undefined,
    author: authorName,
    coverImage: null,
  });
  return { entityType: "field_note", entityId: fieldNote.id };
}

/** Publish (flip to "published") the target entity. */
async function defaultPublishTarget(entityType: "guide" | "field_note", entityId: string): Promise<unknown> {
  if (entityType === "guide") {
    return publishGuide(entityId);
  }
  return publishFieldNote(entityId);
}

/** Roll back a published target (undo publish) — used on stale-publish. */
async function rollbackPublication(entityType: "guide" | "field_note", entityId: string): Promise<void> {
  try {
    if (entityType === "guide") {
      await unpublishGuide(entityId);
    } else {
      await unpublishFieldNote(entityId);
    }
  } catch {
    // Best-effort rollback; the draft is already left truthful (not PUBLISHED).
  }
}

/** Resolve a target entity by exact ID (admin resolver, no public slug lookup). */
async function getTargetById(
  entityType: "guide" | "field_note",
  entityId: string,
): Promise<{ status: string } | null> {
  if (entityType === "guide") {
    const guide = await getAdminGuideById(entityId);
    return guide ? { status: guide.status } : null;
  }
  const note = await getAdminFieldNoteById(entityId);
  return note ? { status: note.status } : null;
}

/** Verify the target is genuinely public (status === "published") by exact ID.
 * The editorial draft must never report PUBLISHED unless this is true. */
async function verifyTargetPublic(entityType: "guide" | "field_note", entityId: string): Promise<boolean> {
  const target = await getTargetById(entityType, entityId);
  return !!target && target.status === "published";
}

/** Fetch the publication record for a draft (if any). */
async function getPublicationByDraftId(
  db: Database,
  draftId: string,
): Promise<EditorialPublication | undefined> {
  return await db
    .select()
    .from(editorial_publications)
    .where(eq(editorial_publications.draftId, draftId))
    .get();
}

/** Delete a draft's publication record (reservation or finalized). */
async function deletePublicationByDraftId(db: Database, draftId: string): Promise<void> {
  await db.delete(editorial_publications).where(eq(editorial_publications.draftId, draftId));
}

/** Poll (bounded) for a concurrent publish to finalize its publication record. */
async function waitForPublication(
  db: Database,
  draftId: string,
  timeoutMs = 2000,
  intervalMs = 20,
): Promise<{ entityType: "guide" | "field_note"; entityId: string }> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const pub = await getPublicationByDraftId(db, draftId);
    if (pub && pub.entityId) {
      return { entityType: pub.entityType as "guide" | "field_note", entityId: pub.entityId };
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Publication of draft ${draftId} is still in progress — please retry in a moment.`);
}

/**
 * Resume/finalize a publication whose reservation is already owned by an exact
 * target entityId (set immediately after the target was created). This covers
 * both idempotent re-publish and crash recovery, and NEVER uses the slug to
 * identify the target — an unrelated guide/field note sharing the draft's slug
 * can never be claimed.
 */
async function finalizeOwnedPublication(
  db: Database,
  draft: EditorialDraftWithSources,
  actor: string,
  entityType: "guide" | "field_note",
  entityId: string,
  now: Date,
  publishTargetFn: (entityType: "guide" | "field_note", entityId: string) => Promise<unknown>,
): Promise<{ entityType: "guide" | "field_note"; entityId: string }> {
  // If a crashed run created the target but never published it, resume the
  // publish now; otherwise the target is already public.
  if (!(await verifyTargetPublic(entityType, entityId))) {
    await publishTargetFn(entityType, entityId);
  }
  if (!(await verifyTargetPublic(entityType, entityId))) {
    throw new Error(`Publication record owns target ${entityId} but it is not publicly visible.`);
  }
  // Idempotency: an already-PUBLISHED draft with a verified target is done.
  if (draft.status === "PUBLISHED") {
    await logAudit({
      actor,
      entityType: "editorial_draft",
      entityId: draft.id,
      action: "draft_publish_recovered",
      detail: { entityType, entityId, recovered: true },
    });
    return { entityType, entityId };
  }
  return await markDraftPublished(db, draft, actor, entityType, entityId, now);
}

/**
 * Finalize publication: set entityId on the publication record, CAS-update the
 * draft to PUBLISHED (only if still APPROVED), verify, audit-log, and return.
 * On stale-publish (draft was modified concurrently), roll back the target
 * and clean up the reservation — fail closed.
 */
async function markDraftPublished(
  db: Database,
  draft: EditorialDraftWithSources,
  actor: string,
  entityType: "guide" | "field_note",
  entityId: string,
  now: Date,
): Promise<{ entityType: "guide" | "field_note"; entityId: string }> {
  // Finalize the publication record (set entityId).
  await db
    .update(editorial_publications)
    .set({ entityId })
    .where(eq(editorial_publications.draftId, draft.id));

  // CAS: mark draft PUBLISHED only if still APPROVED.
  // If a concurrent edit moved the draft off APPROVED, this matches nothing
  // and the draft is left truthful — then we roll the publish back.
  await db
    .update(editorial_drafts)
    .set({
      status: "PUBLISHED" as DraftStatus,
      publishedEntityId: entityId,
      publishedEntityType: entityType,
      publishedAt: now,
      updatedAt: now,
    })
    .where(and(eq(editorial_drafts.id, draft.id), eq(editorial_drafts.status, "APPROVED")));

  const after = await getDraft(draft.id);
  if (after?.status !== "PUBLISHED") {
    // Stale publish: the draft was edited/rejected while we were publishing.
    // The target was made public — roll it back so we fail closed.
    await rollbackPublication(entityType, entityId);
    await deletePublicationByDraftId(db, draft.id);
    throw new Error(`Stale publish: draft "${draft.id}" was modified (status="${after?.status ?? "unknown"}") during publication. Re-approve and retry.`);
  }

  await logAudit({
    actor,
    entityType: "editorial_draft",
    entityId: draft.id,
    action: "draft_published",
    detail: { entityType, entityId, verifiedPublic: true },
  });

  return { entityType, entityId };
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

  // CAS: only advance if the draft is still in expectedStatus. A concurrent
  // transition moves 0 rows, which the re-check below detects.
  await db
    .update(editorial_drafts)
    .set(updates)
    .where(and(eq(editorial_drafts.id, id), eq(editorial_drafts.status, expectedStatus)));

  await logAudit({
    actor,
    entityType: "editorial_draft",
    entityId: id,
    action: auditAction,
    detail: extraDetail,
  });

  const updated = await getDraft(id);
  if (!updated || updated.status !== newStatus) {
    throw new Error(`Cannot ${auditAction} draft — status was "${updated?.status ?? "unknown"}" during transition (concurrent modification).`);
  }
  return updated;
}

// Re-export types for convenience.
export type { EditorialDraftWithSources, DraftSourceProvenance };
