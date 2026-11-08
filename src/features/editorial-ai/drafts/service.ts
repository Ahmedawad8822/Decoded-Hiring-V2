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
// D1 transaction note: ordinary interactive BEGIN/COMMIT transactions are
// not available through the Workers D1 driver. Mission 07 therefore relies on
// database-enforced uniqueness plus exact lease/CAS writes: UNIQUE(draft_id)
// serializes publication ownership, the publication row id is the lease token,
// and status/entity CAS checks make stale or crashed work fail closed.
// ============================================================================

import { getDb } from "@/lib/db";
import { getD1Database } from "@/lib/cloudflare/bindings";
import type { Database, EditorialPublication } from "@/lib/db";
import {
  editorial_drafts,
  editorial_draft_sources,
  editorial_publications,
  knowledge_sources,
  knowledge_chunks,
  users,
} from "@/lib/db";
import { eq, desc, and, inArray, isNull } from "drizzle-orm";
import type { LlmBlock, ContextChunk } from "../skills/types";
import type { LLMProvider } from "../providers";
import type { ContentBlock } from "@/features/publishing/types";
import { logAudit } from "../audit/service";
import { createGuide, discardGuideDraft, getAdminGuideById, publishGuide, unpublishGuide } from "@/features/guides/service";
import { createFieldNote, discardFieldNoteDraft, getAdminFieldNoteById, publishFieldNote, unpublishFieldNote } from "@/features/field-notes/service";
import { isUniqueConstraintError } from "@/lib/db/sqlite-errors";
import type {
  DraftContentType,
  DraftStatus,
  GenerateDraftInput,
  UpdateDraftInput,
  EditorialDraftWithSources,
  DraftSourceProvenance,
  DraftSummary,
} from "./types";
import { AppError } from "@/lib/errors";

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

export async function generateDraft(
  input: GenerateDraftInput,
  actor: string,
  opts?: {
    provider?: LLMProvider;
    /** Test seam: runs after retrieval/generation but before the atomic D1 persist batch. */
    onBeforePersist?: (context: { draftId: string; chunkIds: string[] }) => Promise<void>;
  }
): Promise<EditorialDraftWithSources> {
  // Generation-only code must not initialize when listing or reading drafts.
  const { generateDraftSchema } = await import("./types");
  input = generateDraftSchema.parse(input);
  const { resolveProvider } = await import("../providers");
  const { retrieveKnowledge } = await import("../knowledge/retrieval");
  const { getActiveMemory } = await import("../memory/service");
  const { AHA_AUTHORITY_V1, SKILL_VERSION, NoRelevantEvidenceError } = await import("../skills/aha-authority");
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

  // 7. Save draft + provenance atomically.
  //
  // A draft without its complete provenance is not a valid generated asset.
  // D1 batch() executes the statements as one transaction: if any provenance
  // INSERT fails (for example because a retrieved chunk disappeared), the
  // draft INSERT rolls back too. This removes the crash/error window where a
  // usable-looking draft could exist with partial evidence history.
  const d1 = await getD1Database();
  const now = new Date();
  const nowSec = Math.floor(now.getTime() / 1000);
  const draftId = `draft_${crypto.randomUUID().slice(0, 12)}`;

  const statements = [
    d1
      .prepare(
        `INSERT INTO editorial_drafts
          (id, content_type, title, slug, excerpt, body, meta_title, meta_description,
           status, skill_id, skill_version, provider, model, created_by, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'DRAFT', ?9, ?10, ?11, ?12, ?13, ?14, ?15)`,
      )
      .bind(
        draftId,
        input.contentType,
        "Draft: " + llmOutput.title,
        llmOutput.slugSuggestion,
        llmOutput.excerpt ?? null,
        JSON.stringify(llmOutput.contentBlocks),
        llmOutput.metaTitle ?? null,
        llmOutput.metaDescription ?? null,
        AHA_AUTHORITY_V1.id,
        SKILL_VERSION,
        provider.name,
        process.env.EDITORIAL_MODEL_NAME ?? "fake",
        actor,
        nowSec,
        nowSec,
      ),
  ];

  for (let i = 0; i < retrievedChunks.length; i++) {
    const chunk = retrievedChunks[i]!;
    statements.push(
      d1
        .prepare(
          `INSERT INTO editorial_draft_sources
            (id, draft_id, source_id, chunk_id, rank, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
        )
        .bind(
          `eds_${crypto.randomUUID().slice(0, 12)}`,
          draftId,
          chunk.sourceId,
          chunk.chunkId,
          i,
          nowSec,
        ),
    );
  }

  await opts?.onBeforePersist?.({
    draftId,
    chunkIds: retrievedChunks.map((chunk) => chunk.chunkId),
  });
  await d1.batch(statements);

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
}): Promise<DraftSummary[]> {
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

  // The list view does NOT join knowledge_chunks.content — only draft-level
  // fields are needed for the table. Fetching full chunk text per draft was
  // an O(N × chunk_size) bandwidth waste on the listing page. getDraft()
  // (detail view) still loads full provenance via fetchProvenanceForDrafts.
  // DraftSummary = Omit<EditorialDraftWithSources, "sources">, so the
  // full assembled object is assignable without a separate destructure.
  return drafts.map((draft) => assembleDraft(draft, []) as DraftSummary);
}

// ---------------------------------------------------------------------------
// Edits
// ---------------------------------------------------------------------------

export async function updateDraft(
  id: string,
  input: UpdateDraftInput,
  actor: string,
  opts?: {
    /** Test seam used to force a lifecycle transition after validation and before the CAS write. */
    onValidated?: () => Promise<void>;
  },
): Promise<EditorialDraftWithSources> {
  const { updateDraftSchema } = await import("./types");
  input = updateDraftSchema.parse(input);
  const db = await getDb();
  const now = new Date();
  const draft = await getDraft(id);
  if (!draft) throw new AppError("not_found", `Draft with id "${id}" not found`);
  if (draft.status !== "DRAFT") {
    throw new AppError("invalid", `Cannot edit draft in "${draft.status}" status. Only DRAFT content can be edited; return it to DRAFT before changing content.`);
  }

  const updates: Partial<typeof editorial_drafts.$inferInsert> = { updatedAt: now };
  if (input.title !== undefined) updates.title = input.title;
  if (input.slug !== undefined) updates.slug = input.slug;
  if (input.excerpt !== undefined) updates.excerpt = input.excerpt;
  if (input.body !== undefined) updates.body = JSON.stringify(input.body);
  if (input.metaTitle !== undefined) updates.metaTitle = input.metaTitle;
  if (input.metaDescription !== undefined) updates.metaDescription = input.metaDescription;


  await opts?.onValidated?.();

  // The status check above is advisory for a clear error message. This CAS is
  // authoritative: if submission/review wins after the read, the edit moves
  // zero rows and cannot mutate content that is already under review.
  const written = await db
    .update(editorial_drafts)
    .set(updates)
    .where(and(eq(editorial_drafts.id, id), eq(editorial_drafts.status, "DRAFT")))
    .returning({ id: editorial_drafts.id })
    .get();

  if (!written) {
    const current = await getDraft(id);
    throw new AppError("conflict",
      `Cannot edit draft — status changed to "${current?.status ?? "unknown"}" while the edit was being saved. Return it to DRAFT and retry.`,
    );
  }

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
  if (!draft) throw new AppError("not_found", `Draft with id "${id}" not found`);
  if (draft.status !== "IN_REVIEW") {
    throw new AppError("invalid", `Cannot approve draft in "${draft.status}" status. Not in IN_REVIEW status.`);
  }

  const db = await getDb();
  const now = new Date();
  // CAS: only advance IN_REVIEW → APPROVED. A concurrent state change (e.g. a
  // send-back/reject) moves 0 rows, which the re-check below detects.
  const approved = await db
    .update(editorial_drafts)
    .set({
      status: "APPROVED" as DraftStatus,
      reviewedBy: actor,
      approvedBy: actor,
      approvedAt: now,
      updatedAt: now,
    })
    .where(and(eq(editorial_drafts.id, id), eq(editorial_drafts.status, "IN_REVIEW")))
    .returning({ id: editorial_drafts.id })
    .get();

  if (!approved) {
    const current = await getDraft(id);
    throw new AppError("conflict", `Cannot approve draft — status changed to "${current?.status ?? "unknown"}" during approval.`);
  }

  // Audit only a transition this caller actually won.
  await logAudit({ actor, entityType: "editorial_draft", entityId: id, action: "draft_approved" });

  const updated = await getDraft(id);
  if (!updated) throw new Error("Approved draft disappeared after transition.");
  return updated;
}

export async function rejectDraft(id: string, actor: string, reason?: string): Promise<EditorialDraftWithSources> {
  const draft = await getDraft(id);
  if (!draft) throw new AppError("not_found", `Draft with id "${id}" not found`);
  if (draft.status !== "IN_REVIEW") {
    throw new AppError("invalid", `Cannot reject draft in "${draft.status}" status. Not in IN_REVIEW status.`);
  }

  const db = await getDb();
  const now = new Date();
  // CAS: only advance IN_REVIEW → REJECTED.
  const rejected = await db
    .update(editorial_drafts)
    .set({
      status: "REJECTED" as DraftStatus,
      reviewedBy: actor,
      rejectedAt: now,
      updatedAt: now,
    })
    .where(and(eq(editorial_drafts.id, id), eq(editorial_drafts.status, "IN_REVIEW")))
    .returning({ id: editorial_drafts.id })
    .get();

  if (!rejected) {
    const current = await getDraft(id);
    throw new AppError("conflict", `Cannot reject draft — status changed to "${current?.status ?? "unknown"}" during rejection.`);
  }

  await logAudit({
    actor,
    entityType: "editorial_draft",
    entityId: id,
    action: "draft_rejected",
    detail: reason ? { reason } : undefined,
  });

  const updated = await getDraft(id);
  if (!updated) throw new Error("Rejected draft disappeared after transition.");
  return updated;
}

/**
 * REJECTED → DRAFT (recover a rejected draft for re-editing).
 * Uses the same CAS-protected transitionDraft() with expectedStatus="REJECTED".
 * PUBLISHED remains terminal (guarded inside transitionDraft).
 */
export async function recoverRejected(id: string, actor: string, note?: string): Promise<EditorialDraftWithSources> {
  return transitionDraft(id, "REJECTED", "DRAFT", actor, "draft_recovered", note ? { note } : undefined, ["rejectedAt", "reviewedBy"]);
}

/**
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
    /** Hook invoked after the target entity is bound to the publication lease. */
    onCreateTarget?: (entityType: "guide" | "field_note", entityId: string) => Promise<void>;
    /** Test hook: bounded wait for a concurrent publisher. */
    waitTimeoutMs?: number;
    /** Test hook: age after which an unbound reservation may be reclaimed. */
    staleReservationMs?: number;
  },
): Promise<{ entityType: "guide" | "field_note"; entityId: string }> {
  const db = await getDb();
  const draft = await getDraft(id);
  if (!draft) throw new AppError("not_found", `Draft with id "${id}" not found`);

  const entityType = entityTypeFor(draft.contentType);
  const now = new Date();
  const publishTargetFn = opts?.publishTarget ?? defaultPublishTarget;
  const waitTimeoutMs = opts?.waitTimeoutMs ?? 2000;
  const staleReservationMs = opts?.staleReservationMs ?? 5 * 60 * 1000;

  // 1. Idempotency / crash recovery.
  const existing = await getPublicationByDraftId(db, draft.id);
  if (existing) {
    // A bound entityId is still potentially owned by a LIVE publisher that is
    // between target creation and draft finalization. Always give the owner a
    // bounded chance to finish before considering crash recovery.
    if (
      draft.status === "PUBLISHED" &&
      existing.entityId &&
      draft.publishedEntityId === existing.entityId &&
      (await verifyTargetPublic(existing.entityType as "guide" | "field_note", existing.entityId))
    ) {
      return {
        entityType: existing.entityType as "guide" | "field_note",
        entityId: existing.entityId,
      };
    }

    try {
      return await waitForCompletedPublication(db, draft.id, waitTimeoutMs);
    } catch (waitError) {
      // A timeout is NOT proof of abandonment. Recovery is allowed only when
      // the exact lease is old enough to be considered stale.
      const current = await getPublicationByDraftId(db, draft.id);
      if (!current) {
        // The owner cleaned up between our polls; continue and reserve below.
      } else {
        const ageMs = Date.now() - current.createdAt.getTime();
        if (ageMs < staleReservationMs) throw waitError;

        if (current.entityId) {
          // Stale BOUND lease: resume the exact target by ID.
          return await finalizeOwnedPublication(
            db,
            draft,
            actor,
            current.id,
            current.entityType as "guide" | "field_note",
            current.entityId,
            new Date(),
            publishTargetFn,
          );
        }

        // Stale UNBOUND lease: reclaim only if it is still the exact NULL
        // reservation observed above.
        const reclaimed = await deletePublicationReservation(db, current.id, draft.id, true);
        if (!reclaimed) {
          throw new AppError("conflict", `Publication reservation for draft ${draft.id} changed while stale recovery was attempted. Retry.`);
        }
      }
    }
  }

  if (draft.status !== "APPROVED") {
    throw new AppError("invalid", `Cannot publish draft in "${draft.status}" status. Not in APPROVED status.`);
  }

  // 2. Reserve a publication row. Its row id is the lease/ownership token.
  const reservationId = `pub_${crypto.randomUUID().slice(0, 12)}`;
  try {
    await db.insert(editorial_publications).values({
      id: reservationId,
      draftId: draft.id,
      entityType,
      entityId: null,
      createdAt: now,
    });
  } catch (err) {
    if (!isUniqueConstraintError(err)) throw err;
    // A concurrent publisher owns the row. Never delete or take over a fresh
    // lease merely because our bounded wait expires.
    return await waitForCompletedPublication(db, draft.id, waitTimeoutMs);
  }

  let createdEntityId: string | null = null;
  let targetBoundToLease = false;

  try {
    // 3. Create the target entity (fails fast on unrelated slug collision).
    const authorName = await resolveAuthorName(actor);
    const created = await createTarget(draft, authorName);
    createdEntityId = created.entityId;

    // Bind the exact target to OUR exact reservation. If this CAS loses, we
    // must not publish a target that this request no longer owns.
    const bound = await db
      .update(editorial_publications)
      .set({ entityId: createdEntityId })
      .where(
        and(
          eq(editorial_publications.id, reservationId),
          eq(editorial_publications.draftId, draft.id),
          isNull(editorial_publications.entityId),
        ),
      )
      .returning({ id: editorial_publications.id })
      .get();

    if (!bound) {
      await abandonOwnedTarget(entityType, createdEntityId);
      createdEntityId = null;
      throw new Error(`Publication lease for draft ${draft.id} was lost before target ownership could be recorded.`);
    }
    targetBoundToLease = true;

    await opts?.onCreateTarget?.(entityType, createdEntityId);

    // 4. Publish the target and verify it by exact ID.
    await publishTargetFn(entityType, createdEntityId);
    if (!(await verifyTargetPublic(entityType, createdEntityId))) {
      throw new Error("Publication verification failed: target is not publicly visible after publish.");
    }

    // 5. CAS the draft to PUBLISHED. The bound reservation remains the
    // authoritative crash-recovery record until finalization succeeds.
    return await markDraftPublished(
      db,
      draft,
      actor,
      reservationId,
      entityType,
      createdEntityId,
      now,
    );
  } catch (err) {
    if (!targetBoundToLease) {
      // No authoritative target ownership exists. Release only OUR reservation.
      await deletePublicationReservation(db, reservationId, draft.id, false);
      if (createdEntityId) {
        await abandonOwnedTarget(entityType, createdEntityId);
      }
    }
    // If targetBoundToLease is true, KEEP the exact reservation + entityId.
    // A retry resumes that same target after publish/verify/transient failure.
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
  return user?.name?.trim() || DEFAULT_PUBLISH_AUTHOR;
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

/** Undo and discard a target that this editorial publication owns.
 * Used only when publication is deliberately abandoned (e.g. stale draft CAS).
 * It never deletes published content without first unpublishing it. */
async function abandonOwnedTarget(entityType: "guide" | "field_note", entityId: string): Promise<void> {
  try {
    const target = await getTargetById(entityType, entityId);
    if (!target) return;
    if (target.status === "published") {
      if (entityType === "guide") await unpublishGuide(entityId);
      else await unpublishFieldNote(entityId);
    }

    const after = await getTargetById(entityType, entityId);
    if (after?.status === "draft") {
      if (entityType === "guide") await discardGuideDraft(entityId);
      else await discardFieldNoteDraft(entityId);
    }
  } catch {
    // Best effort. The draft itself remains fail-closed (not PUBLISHED).
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

/** Delete only the exact publication lease this caller intends to release. */
async function deletePublicationReservation(
  db: Database,
  reservationId: string,
  draftId: string,
  onlyIfUnbound: boolean,
): Promise<boolean> {
  const conditions = [
    eq(editorial_publications.id, reservationId),
    eq(editorial_publications.draftId, draftId),
  ];
  if (onlyIfUnbound) conditions.push(isNull(editorial_publications.entityId));

  const deleted = await db
    .delete(editorial_publications)
    .where(and(...conditions))
    .returning({ id: editorial_publications.id })
    .get();
  return !!deleted;
}

/** Poll for a concurrent publisher to fully finish, not merely bind an entityId. */
async function waitForCompletedPublication(
  db: Database,
  draftId: string,
  timeoutMs = 2000,
  intervalMs = 20,
): Promise<{ entityType: "guide" | "field_note"; entityId: string }> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const pub = await getPublicationByDraftId(db, draftId);
    if (pub?.entityId) {
      const currentDraft = await getDraft(draftId);
      if (
        currentDraft?.status === "PUBLISHED" &&
        currentDraft.publishedEntityId === pub.entityId &&
        (await verifyTargetPublic(pub.entityType as "guide" | "field_note", pub.entityId))
      ) {
        return {
          entityType: pub.entityType as "guide" | "field_note",
          entityId: pub.entityId,
        };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new AppError("conflict", `Publication of draft ${draftId} is still in progress — please retry in a moment.`);
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
  reservationId: string,
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
  return await markDraftPublished(db, draft, actor, reservationId, entityType, entityId, now);
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
  reservationId: string,
  entityType: "guide" | "field_note",
  entityId: string,
  now: Date,
): Promise<{ entityType: "guide" | "field_note"; entityId: string }> {
  // Verify exact lease ownership before changing the draft.
  const ownership = await getPublicationByDraftId(db, draft.id);
  if (
    !ownership ||
    ownership.id !== reservationId ||
    ownership.entityId !== entityId ||
    ownership.entityType !== entityType
  ) {
    throw new Error(`Publication ownership for draft ${draft.id} changed before finalization.`);
  }

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
    await abandonOwnedTarget(entityType, entityId);
    await deletePublicationReservation(db, reservationId, draft.id, false);
    throw new AppError("conflict", `Stale publish: draft "${draft.id}" was modified (status="${after?.status ?? "unknown"}") during publication. Re-approve and retry.`);
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
  extraDetail?: Record<string, unknown>,
  clearFields?: (keyof typeof editorial_drafts.$inferInsert)[],
): Promise<EditorialDraftWithSources> {
  const draft = await getDraft(id);
  if (!draft) throw new AppError("not_found", `Draft with id "${id}" not found`);
  // Terminal state guard — PUBLISHED drafts cannot transition further.
  if (draft.status === "PUBLISHED") {
    throw new AppError("invalid", `Cannot ${auditAction} draft — already PUBLISHED.`);
  }
  if (draft.status !== expectedStatus) {
    throw new AppError("invalid",
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

  // Clear review/rejection metadata when reverting to DRAFT (for example
  // REJECTED → DRAFT recovery) so the recovered draft starts a fresh review
  // cycle. updateDraft itself is DRAFT-only and never revokes approval.
  if (newStatus === "DRAFT" && clearFields) {
    for (const field of clearFields) {
      (updates as Record<string, unknown>)[field] = null;
    }
  }

  // CAS: only advance if the draft is still in expectedStatus. A concurrent
  // transition moves 0 rows, which the re-check below detects.
  const transitioned = await db
    .update(editorial_drafts)
    .set(updates)
    .where(and(eq(editorial_drafts.id, id), eq(editorial_drafts.status, expectedStatus)))
    .returning({ id: editorial_drafts.id })
    .get();

  if (!transitioned) {
    const current = await getDraft(id);
    throw new AppError("conflict",
      `Cannot ${auditAction} draft — status changed to "${current?.status ?? "unknown"}" during transition.`,
    );
  }

  // Audit only after the authoritative CAS confirms this caller won.
  await logAudit({
    actor,
    entityType: "editorial_draft",
    entityId: id,
    action: auditAction,
    detail: extraDetail,
  });

  const updated = await getDraft(id);
  if (!updated) throw new Error("Draft disappeared after lifecycle transition.");
  return updated;
}

// Re-export types for convenience.
export type { EditorialDraftWithSources, DraftSourceProvenance };
