// ============================================================================
// KNOWLEDGE INGESTION SERVICE
// ----------------------------------------------------------------------------
// Ingestion lifecycle: UPLOADED → INGESTING → READY (or FAILED).
//
// Invariants (Mission 07 sections 7, 8):
//   - A failed ingestion must NOT leave orphan R2 objects, half-indexed FTS
//     rows, or inconsistent chunkCount.
//   - Re-ingestion is idempotent: deterministic chunking + delete-before-insert
//     means identical source content → identical chunks.
//   - Only READY sources enter retrieval.
//   - Duplicate checksum on upload → reject (handled in storage.ts).
// ============================================================================

import { getDb, knowledge_sources, knowledge_chunks, type KnowledgeSource } from "@/lib/db";
import { and, eq, isNull, ne } from "drizzle-orm";
import { chunkText } from "./chunker";
import { getKnowledgeObject } from "./storage";
import { logAudit } from "../audit/service";
import type { KnowledgeStatus, RetrievedChunk } from "./types";

/** Decode a text/markdown R2 object to a UTF-8 string. */
function decodeText(body: Uint8Array): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { TextDecoder } = require("util") as typeof import("util");
    return new TextDecoder("utf-8").decode(body);
  } catch {
    return new TextDecoder("utf-8").decode(body);
  }
}

/**
 * Begin ingestion of a knowledge source: read R2 object, chunk, store chunks,
 * update FTS (via triggers), and transition to READY (or FAILED on error).
 *
 * Safe to call on UPLOADED, READY, or FAILED sources (re-ingestion).
 * ARCHIVED sources are rejected.
 */
export async function ingestKnowledgeSource(
  sourceId: string,
  actor: string
): Promise<{ chunkCount: number; status: KnowledgeStatus }> {
  const db = await getDb();

  const source = await db
    .select()
    .from(knowledge_sources)
    .where(eq(knowledge_sources.id, sourceId))
    .get();
  if (!source) {
    throw new Error(`Knowledge source with id "${sourceId}" not found`);
  }

  if (source.status === "ARCHIVED") {
    throw new Error("Cannot ingest an archived source. Unarchive first.");
  }

  // 1. Mark INGESTING
  await db
    .update(knowledge_sources)
    .set({ status: "INGESTING" as KnowledgeStatus, updatedAt: new Date() })
    .where(eq(knowledge_sources.id, sourceId));

  try {
    // 2. Read original from R2
    const object = await getKnowledgeObject(source.r2Key);
    if (!object) {
      throw new Error(`Original file missing in R2 for source "${sourceId}"`);
    }

    // 3. Decode text (text/plain and text/markdown only)
    const text = decodeText(object.body);

    // 4. Chunk deterministically
    const { chunks } = chunkText(text);
    if (chunks.length === 0) {
      throw new Error("Source content produced zero chunks — nothing to index.");
    }

    // 5. Delete any existing chunks (idempotent re-ingestion). Triggers clean
    //    the FTS index automatically.
    await db.delete(knowledge_chunks).where(eq(knowledge_chunks.sourceId, sourceId));

    // 6. Insert new chunks. D1 does not offer cross-statement atomicity for
    //    ORM-level batch across the Drizzle wrapper, so we insert sequentially
    //    inside a try/catch: on any failure, ALL chunks for this source are
    //    purged (trigger removes FTS rows) and the source is marked FAILED.
    const now = new Date();
    for (const c of chunks) {
      await db.insert(knowledge_chunks).values({
        id: `knc_${crypto.randomUUID().slice(0, 12)}`,
        sourceId: sourceId,
        ordinal: c.ordinal,
        heading: c.heading,
        content: c.content,
        contentHash: c.contentHash,
        characterCount: c.characterCount,
        createdAt: now,
      });
    }

    // 7. Transition to READY
    await db
      .update(knowledge_sources)
      .set({
        status: "READY" as KnowledgeStatus,
        chunkCount: chunks.length,
        ingestedAt: now,
        updatedAt: now,
      })
      .where(eq(knowledge_sources.id, sourceId));

    await logAudit({
      actor,
      entityType: "knowledge_source",
      entityId: sourceId,
      action: "knowledge_ingested",
      detail: { chunkCount: chunks.length, totalChars: text.length },
    });

    return { chunkCount: chunks.length, status: "READY" };
  } catch (err) {
    // 8. Failure: clean up chunks inserted so far, mark FAILED.
    await db.delete(knowledge_chunks).where(eq(knowledge_chunks.sourceId, sourceId));
    await db
      .update(knowledge_sources)
      .set({ status: "FAILED" as KnowledgeStatus, updatedAt: new Date() })
      .where(eq(knowledge_sources.id, sourceId));

    await logAudit({
      actor,
      entityType: "knowledge_source",
      entityId: sourceId,
      action: "knowledge_failed",
      detail: { error: (err as Error).message },
    });

    throw new Error(
      `Ingestion failed for source "${source.title}": ${(err as Error).message}`
    );
  }
}

/**
 * Archive a knowledge source (soft delete). Sets status to ARCHIVED and
 * archivedAt. Chunks are preserved but excluded from retrieval via the status
 * filter. The R2 object remains (private, recoverable).
 */
export async function archiveKnowledgeSource(sourceId: string, actor: string): Promise<KnowledgeSource> {
  const db = await getDb();
  const source = await db
    .select()
    .from(knowledge_sources)
    .where(eq(knowledge_sources.id, sourceId))
    .get();

  if (!source) {
    throw new Error(`Knowledge source with id "${sourceId}" not found`);
  }

  if (source.status === "ARCHIVED") {
    throw new Error("Source is already archived");
  }

  if (source.status === "INGESTING") {
    throw new Error("Cannot archive a source that is currently being ingested. Wait for ingestion to complete.");
  }

  const now = new Date();
  await db
    .update(knowledge_sources)
    .set({ status: "ARCHIVED" as KnowledgeStatus, archivedAt: now, updatedAt: now })
    .where(eq(knowledge_sources.id, sourceId));

  await logAudit({
    actor,
    entityType: "knowledge_source",
    entityId: sourceId,
    action: "knowledge_archived",
    detail: { previousStatus: source.status, chunkCount: source.chunkCount },
  });

  const updated = await db
    .select()
    .from(knowledge_sources)
    .where(eq(knowledge_sources.id, sourceId))
    .get();
  return updated!;
}

/**
 * Restore an archived source. Chunks were preserved during archiving, so the
 * source is immediately searchable again after restore.
 */
export async function restoreKnowledgeSource(sourceId: string, actor: string): Promise<KnowledgeSource> {
  const db = await getDb();
  const source = await db
    .select()
    .from(knowledge_sources)
    .where(eq(knowledge_sources.id, sourceId))
    .get();

  if (!source) {
    throw new Error(`Knowledge source with id "${sourceId}" not found`);
  }

  if (source.status !== "ARCHIVED") {
    throw new Error("Only archived sources can be restored");
  }

  const now = new Date();
  await db
    .update(knowledge_sources)
    .set({ status: "READY" as KnowledgeStatus, archivedAt: null, updatedAt: now })
    .where(eq(knowledge_sources.id, sourceId));

  await logAudit({
    actor,
    entityType: "knowledge_source",
    entityId: sourceId,
    action: "knowledge_restored",
    detail: { chunkCount: source.chunkCount },
  });

  const updated = await db
    .select()
    .from(knowledge_sources)
    .where(eq(knowledge_sources.id, sourceId))
    .get();
  return updated!;
}

/**
 * Force re-ingestion of an already-READY source. Deletes existing chunks and
 * re-chunks from the R2 original. Idempotent: same content → same chunks.
 */
export async function reingestKnowledgeSource(
  sourceId: string,
  actor: string
): Promise<{ chunkCount: number }> {
  const result = await ingestKnowledgeSource(sourceId, actor);
  return { chunkCount: result.chunkCount };
}

/**
 * List all non-archived knowledge sources for the admin panel.
 */
export async function listKnowledgeSources(): Promise<KnowledgeSource[]> {
  const db = await getDb();
  return db
    .select()
    .from(knowledge_sources)
    .where(ne(knowledge_sources.status, "ARCHIVED"))
    .orderBy(knowledge_sources.createdAt);
}

/**
 * Get a knowledge source by ID (any status — admin view).
 */
export async function getKnowledgeSource(sourceId: string): Promise<KnowledgeSource | null> {
  const db = await getDb();
  const source = await db
    .select()
    .from(knowledge_sources)
    .where(eq(knowledge_sources.id, sourceId))
    .get();
  return source || null;
}

/**
 * Get all retrievable (READY) source IDs — for source-filtered retrieval.
 */
export async function getRetrievableSourceIds(): Promise<string[]> {
  const db = await getDb();
  const rows = await db
    .select({ id: knowledge_sources.id })
    .from(knowledge_sources)
    .where(
      and(
        eq(knowledge_sources.status, "READY"),
        isNull(knowledge_sources.archivedAt)
      )
    );
  return rows.map((r) => r.id);
}

/** Re-export RetrievedChunk type for convenience. */
export type { RetrievedChunk };
