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

import { getDb, knowledge_sources, type KnowledgeSource } from "@/lib/db";
import { getD1Database } from "@/lib/cloudflare/bindings";
import { and, eq, isNull, ne } from "drizzle-orm";
import { logAudit } from "../audit/service";
import type { KnowledgeStatus, RetrievedChunk } from "./types";
import { AppError, isAppError } from "@/lib/errors";

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

function toSqliteTimestamp(date: Date): number {
  // Drizzle integer({ mode: "timestamp" }) stores Unix seconds in SQLite.
  return Math.floor(date.getTime() / 1000);
}

async function deleteChunksOwnedByLease(sourceId: string, claimTime: Date): Promise<void> {
  const d1 = await getD1Database();
  await d1
    .prepare(
      `DELETE FROM knowledge_chunks
       WHERE source_id = ?1
         AND EXISTS (
           SELECT 1
           FROM knowledge_sources
           WHERE id = ?2
             AND status = 'INGESTING'
             AND updated_at = ?3
         )`,
    )
    .bind(sourceId, sourceId, toSqliteTimestamp(claimTime))
    .run();
}

async function insertChunkOwnedByLease(
  sourceId: string,
  claimTime: Date,
  chunk: {
    id: string;
    ordinal: number;
    heading: string | null;
    content: string;
    contentHash: string;
    characterCount: number;
    createdAt: Date;
  },
): Promise<void> {
  const d1 = await getD1Database();
  const result = await d1
    .prepare(
      `INSERT INTO knowledge_chunks
        (id, source_id, ordinal, heading, content, content_hash, character_count, created_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8
       WHERE EXISTS (
         SELECT 1
         FROM knowledge_sources
         WHERE id = ?9
           AND status = 'INGESTING'
           AND updated_at = ?10
       )`,
    )
    .bind(
      chunk.id,
      sourceId,
      chunk.ordinal,
      chunk.heading,
      chunk.content,
      chunk.contentHash,
      chunk.characterCount,
      toSqliteTimestamp(chunk.createdAt),
      sourceId,
      toSqliteTimestamp(claimTime),
    )
    .run();

  // D1/Miniflare may include FTS trigger side-effects in meta.changes, so
  // successful insertion can report >1 changes. Zero remains the authoritative
  // signal that the lease-gated INSERT ... SELECT inserted no chunk row.
  if ((result.meta?.changes ?? 0) < 1) {
    throw new Error("Ingestion lease was lost before chunk insertion.");
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
  actor: string,
  opts?: {
    /** Test hook invoked only after this caller atomically owns INGESTING. */
    onClaim?: () => Promise<void>;
    /** Age after which a crashed INGESTING lease may be reclaimed. */
    staleAfterMs?: number;
  },
): Promise<{ chunkCount: number; status: KnowledgeStatus }> {
  const db = await getDb();

  const source = await db
    .select()
    .from(knowledge_sources)
    .where(eq(knowledge_sources.id, sourceId))
    .get();
  if (!source) {
    throw new AppError("not_found", `Knowledge source with id "${sourceId}" not found`);
  }
  if (source.status === "ARCHIVED") {
    throw new AppError("invalid", "Cannot ingest an archived source. Unarchive first.");
  }

  const nowMs = Date.now();
  const previousVersionSec = Math.floor(source.updatedAt.getTime() / 1000);
  const claimVersionSec = Math.max(Math.floor(nowMs / 1000), previousVersionSec + 1);
  // SQLite timestamp mode stores seconds, so force every lease version to a
  // distinct stored second even when two lifecycle operations happen quickly.
  const claimTime = new Date(claimVersionSec * 1000);
  const staleAfterMs = opts?.staleAfterMs ?? 5 * 60 * 1000;

  // INGESTING is an exclusive lease. A fresh lease cannot be stolen; a stale
  // one can only be reclaimed by CAS against the exact updatedAt version read
  // above, so two recovery attempts cannot both win.
  if (
    source.status === "INGESTING" &&
    nowMs - source.updatedAt.getTime() < staleAfterMs
  ) {
    throw new AppError("conflict", "Knowledge source is already being ingested. Retry after the current ingestion finishes.");
  }

  const claimed = await db
    .update(knowledge_sources)
    .set({ status: "INGESTING" as KnowledgeStatus, updatedAt: claimTime, error: null })
    .where(
      and(
        eq(knowledge_sources.id, sourceId),
        eq(knowledge_sources.status, source.status),
        eq(knowledge_sources.updatedAt, source.updatedAt),
      ),
    )
    .returning({ id: knowledge_sources.id })
    .get();

  if (!claimed) {
    throw new AppError("conflict", "Knowledge source changed while ingestion was starting. Retry; another operation owns the source.");
  }

  await opts?.onClaim?.();

  try {
    // Ingestion-only modules are unnecessary for knowledge list/detail reads.
    const { getKnowledgeObject } = await import("./storage");
    const { chunkText } = await import("./chunker");

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
      throw new AppError("invalid", "Source content produced zero chunks — nothing to index.");
    }

    // 5. Replace chunks with lease-conditional SQL. Every destructive write
    // checks the exact INGESTING lease in the SAME SQL statement. If a stale
    // worker wakes after another request has reclaimed the lease, its DELETE
    // and INSERT statements become harmless no-ops instead of corrupting the
    // winner's chunks/FTS rows.
    await deleteChunksOwnedByLease(sourceId, claimTime);

    const now = new Date();
    for (const c of chunks) {
      await insertChunkOwnedByLease(sourceId, claimTime, {
        id: `knc_${crypto.randomUUID().slice(0, 12)}`,
        ordinal: c.ordinal,
        heading: c.heading,
        content: c.content,
        contentHash: c.contentHash,
        characterCount: c.characterCount,
        createdAt: now,
      });
    }

    // 6. Finalize only if our exact INGESTING lease version still exists.
    const finalized = await db
      .update(knowledge_sources)
      .set({
        status: "READY" as KnowledgeStatus,
        chunkCount: chunks.length,
        ingestedAt: now,
        updatedAt: now,
        error: null,
      })
      .where(
        and(
          eq(knowledge_sources.id, sourceId),
          eq(knowledge_sources.status, "INGESTING"),
          eq(knowledge_sources.updatedAt, claimTime),
        ),
      )
      .returning({ id: knowledge_sources.id })
      .get();

    if (!finalized) {
      throw new Error("Ingestion ownership changed before READY finalization.");
    }

    await logAudit({
      actor,
      entityType: "knowledge_source",
      entityId: sourceId,
      action: "knowledge_ingested",
      detail: { chunkCount: chunks.length, totalChars: text.length },
    });

    return { chunkCount: chunks.length, status: "READY" };
  } catch (err) {
    // Failure cleanup is conditional on still owning the exact INGESTING
    // lease. If ownership changed, never delete another operation's chunks.
    const owner = await db
      .select({ status: knowledge_sources.status, updatedAt: knowledge_sources.updatedAt })
      .from(knowledge_sources)
      .where(eq(knowledge_sources.id, sourceId))
      .get();

    if (
      owner?.status === "INGESTING" &&
      owner.updatedAt.getTime() === claimTime.getTime()
    ) {
      await deleteChunksOwnedByLease(sourceId, claimTime);
      await db
        .update(knowledge_sources)
        .set({
          status: "FAILED" as KnowledgeStatus,
          chunkCount: 0,
          error: (err as Error).message.slice(0, 1000),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(knowledge_sources.id, sourceId),
            eq(knowledge_sources.status, "INGESTING"),
            eq(knowledge_sources.updatedAt, claimTime),
          ),
        );
    }

    await logAudit({
      actor,
      entityType: "knowledge_source",
      entityId: sourceId,
      action: "knowledge_failed",
      detail: { error: (err as Error).message },
    });

    // Only a user-facing cause keeps its detail; internal causes stay
    // internal (masked by the action boundary, logged server-side).
    if (isAppError(err)) {
      throw new AppError(err.kind, `Ingestion failed for source "${source.title}": ${err.message}`);
    }
    throw new Error(
      `Ingestion failed for source "${source.title}": ${(err as Error).message}`,
      { cause: err }
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
    throw new AppError("not_found", `Knowledge source with id "${sourceId}" not found`);
  }

  if (source.status === "ARCHIVED") {
    throw new AppError("invalid", "Source is already archived");
  }

  if (source.status === "INGESTING") {
    throw new AppError("conflict", "Cannot archive a source that is currently being ingested. Wait for ingestion to complete.");
  }

  const now = new Date();
  const archived = await db
    .update(knowledge_sources)
    .set({ status: "ARCHIVED" as KnowledgeStatus, archivedAt: now, updatedAt: now })
    .where(
      and(
        eq(knowledge_sources.id, sourceId),
        eq(knowledge_sources.status, source.status),
        eq(knowledge_sources.updatedAt, source.updatedAt),
      ),
    )
    .returning({ id: knowledge_sources.id })
    .get();

  if (!archived) {
    throw new AppError("conflict", "Knowledge source changed while archiving. Retry after the current operation finishes.");
  }

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
    throw new AppError("not_found", `Knowledge source with id "${sourceId}" not found`);
  }

  if (source.status !== "ARCHIVED") {
    throw new AppError("invalid", "Only archived sources can be restored");
  }

  const now = new Date();
  const restoredRow = await db
    .update(knowledge_sources)
    .set({ status: "READY" as KnowledgeStatus, archivedAt: null, updatedAt: now })
    .where(
      and(
        eq(knowledge_sources.id, sourceId),
        eq(knowledge_sources.status, "ARCHIVED"),
        eq(knowledge_sources.updatedAt, source.updatedAt),
      ),
    )
    .returning({ id: knowledge_sources.id })
    .get();

  if (!restoredRow) {
    throw new AppError("conflict", "Knowledge source changed while restoring. Retry.");
  }

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
