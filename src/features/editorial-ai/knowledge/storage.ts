// ============================================================================
// KNOWLEDGE STORAGE — R2 PRIVATE OBJECTS + D1 METADATA
// ----------------------------------------------------------------------------
// Knowledge originals are PRIVATE. R2 keys are server-generated and never
// client-supplied. D1 stores metadata only; the R2 object holds the bytes.
//
// Key pattern: editorial/knowledge/{sourceId}/original.{ext}
//
// Never exposed through /api/media or any public route. Access is gated
// server-side behind requireAdmin().
// ===========================================================================

import { getR2Bucket } from "@/lib/cloudflare/bindings";
import { getDb, knowledge_sources, type KnowledgeSource } from "@/lib/db";
import { and, eq, ne } from "drizzle-orm";
import {
  isSupportedMimeType,
  MIME_TO_EXTENSION,
  MIME_TO_SOURCE_TYPE,
  MAX_KNOWLEDGE_FILE_SIZE,
  type KnowledgeStatus,
  type SupportedMimeType,
} from "./types";

export interface KnowledgeUploadResult {
  id: string;
  r2Key: string;
  byteSize: number;
  checksum: string;
  mimeType: string;
  status: KnowledgeStatus;
  duplicateOf: string | null;
}

/**
 * Store a knowledge source's original file in private R2 and record
 * metadata in D1. If an identical file (same checksum) already exists —
 * regardless of status (incl. ARCHIVED) — the upload is rejected with a
 * domain error. The global UNIQUE(checksum) index (migration 0007) is the
 * backstop: only deleting the existing source frees its checksum for re-upload.
 *
 * R2 write happens BEFORE D1 row creation — on D1 failure the orphan R2
 * object is deleted (mirrors media/service.ts uploadMedia pattern).
 */
export async function uploadKnowledgeSource(params: {
  buffer: ArrayBuffer;
  filename: string;
  contentType: string;
  title: string;
  author?: string | null;
  sourceLabel?: string | null;
  notes?: string | null;
  createdBy: string;
}): Promise<KnowledgeUploadResult> {
  const { buffer, filename, contentType, title, author, sourceLabel, notes, createdBy } = params;

  // 1. Validate MIME type
  const normalizedType = contentType.toLowerCase().trim();
  if (!isSupportedMimeType(normalizedType)) {
    throw new Error(
      `Unsupported file type "${contentType}". Mission 07 supports text/plain and text/markdown only.`
    );
  }

  // 2. Validate file size
  const byteSize = buffer.byteLength;
  if (byteSize === 0) {
    throw new Error("Uploaded file is empty.");
  }
  if (byteSize > MAX_KNOWLEDGE_FILE_SIZE) {
    throw new Error(
      `File size (${(byteSize / 1024 / 1024).toFixed(2)} MB) exceeds the 2 MB knowledge limit.`
    );
  }

  // 3. Compute checksum (SHA-256)
  const { hashBytes } = await import("./chunker");
  const checksum = hashBytes(buffer);

  // 4. Duplicate detection — checksums are globally unique (see migration
  //    0007). The only way to re-upload identical content is to first DELETE
  //    the existing source, which also frees its checksum. Archived sources are
  //    preserved for restore and still occupy their checksum — use restore,
  //    not re-upload, to revive archived material.
  const db = await getDb();
  const existing = await db
    .select()
    .from(knowledge_sources)
    .where(eq(knowledge_sources.checksum, checksum))
    .get();

  if (existing) {
    throw new Error(
      `Identical source content already exists (ID: ${existing.id}, title: "${existing.title}"). ` +
        "Restore the existing source, or delete it first and re-upload."
    );
  }

  // 5. Generate server-side R2 key (never trust client filename)
  const sourceId = `ks_${crypto.randomUUID().slice(0, 12)}`;
  const ext = MIME_TO_EXTENSION[normalizedType as SupportedMimeType];
  const r2Key = `editorial/knowledge/${sourceId}/original.${ext}`;

  // 6. Write to R2 first
  const bucket = await getR2Bucket();
  await bucket.put(r2Key, buffer, {
    httpMetadata: { contentType: normalizedType },
  });

  // 7. Record metadata in D1 (rollback R2 on failure)
  try {
    const now = new Date();
    const sourceType = MIME_TO_SOURCE_TYPE[normalizedType as SupportedMimeType];
    const safeFilename = filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);

    await db.insert(knowledge_sources).values({
      id: sourceId,
      title,
      sourceType,
      mimeType: normalizedType,
      originalFilename: safeFilename,
      r2Key,
      author: author || null,
      sourceLabel: sourceLabel || null,
      notes: notes || null,
      status: "UPLOADED",
      checksum,
      byteSize,
      chunkCount: 0,
      createdBy,
      createdAt: now,
      updatedAt: now,
      ingestedAt: null,
      archivedAt: null,
    });
  } catch (dbError) {
    // Best-effort cleanup of orphaned R2 object
    try {
      await bucket.delete(r2Key);
    } catch {
      // Swallow — the DB error is what the caller must see
    }
    throw dbError;
  }

  return {
    id: sourceId,
    r2Key,
    byteSize,
    checksum,
    mimeType: normalizedType,
    status: "UPLOADED",
    duplicateOf: null,
  };
}

/**
 * Read a knowledge source's original bytes from private R2. Server-side only.
 * Returns null if the R2 object is missing (corrupted state).
 */
export async function getKnowledgeObject(r2Key: string): Promise<{ body: Uint8Array; contentType: string; size: number } | null> {
  // Strict namespace check — only keys we minted under editorial/knowledge/
  if (
    !r2Key.startsWith("editorial/knowledge/") ||
    r2Key.includes("..") ||
    !/^[a-zA-Z0-9_/.-]+$/.test(r2Key)
  ) {
    return null;
  }

  const bucket = await getR2Bucket();
  const object = await bucket.get(r2Key);
  if (!object) return null;

  // Always use arrayBuffer() — accessing object.body via instanceof can
  // trigger body materialization in Miniflare/wrangler getPlatformProxy,
  // marking the body as "used" before our arrayBuffer() call succeeds.
  const body = new Uint8Array(await object.arrayBuffer());

  return {
    body,
    contentType: object.httpMetadata?.contentType || "text/plain",
    size: object.size,
  };
}

/**
 * Delete a knowledge source's R2 object. Does NOT delete D1 metadata
 * (archiving is a separate lifecycle step). Used on complete source deletion.
 */
export async function deleteKnowledgeObject(r2Key: string): Promise<void> {
  if (
    !r2Key.startsWith("editorial/knowledge/") ||
    r2Key.includes("..") ||
    !/^[a-zA-Z0-9_/.-]+$/.test(r2Key)
  ) {
    return; // never delete anything outside our namespace
  }

  const bucket = await getR2Bucket();
  await bucket.delete(r2Key).catch(() => undefined);
}

/**
 * Get a knowledge source by ID, regardless of status (admin-only).
 */
export async function getKnowledgeSourceById(id: string): Promise<KnowledgeSource | null> {
  const db = await getDb();
  const source = await db.select().from(knowledge_sources).where(eq(knowledge_sources.id, id)).get();
  return source || null;
}

/**
 * Get a knowledge source only if it is in a retrievable (READY) state.
 */
export async function getRetrievableKnowledgeSource(id: string): Promise<KnowledgeSource | null> {
  const source = await getKnowledgeSourceById(id);
  if (!source) return null;
  if (!isRetrievable(source.status)) return null;
  return source;
}

function isRetrievable(status: string): boolean {
  return status === "READY";
}

/**
 * List all non-archived knowledge sources (admin view).
 * Archived sources are excluded — they are soft-deleted.
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
 * Permanently delete a source that has no indexed evidence.
 *
 * Safety rules:
 * - READY / INGESTING are never deletable.
 * - ARCHIVED is deletable only when it has no chunks.
 * - The D1 delete is a CAS on id + status + updatedAt, so an ingestion/archive
 *   transition that starts after our read makes the delete lose safely.
 * - D1 is deleted BEFORE the private R2 object. If a FK/dependency check or CAS
 *   fails, the source bytes remain available and the source is not corrupted.
 */
export async function deleteKnowledgeSource(
  id: string,
  opts?: {
    /** Test seam: runs after validation and before the authoritative delete CAS. */
    onValidated?: () => Promise<void>;
  },
): Promise<void> {
  const source = await getKnowledgeSourceById(id);
  if (!source) {
    throw new Error(`Knowledge source with id "${id}" not found`);
  }

  const deletable =
    source.status === "UPLOADED" ||
    source.status === "FAILED" ||
    (source.status === "ARCHIVED" && source.chunkCount === 0);

  if (!deletable) {
    throw new Error(
      `Cannot delete a ${source.status} source. Only UPLOADED, FAILED, or chunk-free ARCHIVED sources can be permanently deleted.`,
    );
  }

  await opts?.onValidated?.();

  const db = await getDb();
  const deleted = await db
    .delete(knowledge_sources)
    .where(
      and(
        eq(knowledge_sources.id, id),
        eq(knowledge_sources.status, source.status),
        eq(knowledge_sources.updatedAt, source.updatedAt),
      ),
    )
    .returning({ id: knowledge_sources.id })
    .get();

  if (!deleted) {
    throw new Error("Knowledge source changed while deletion was starting. Retry after the current operation finishes.");
  }

  // Only after the authoritative metadata delete succeeds do we remove the
  // private source object. Orphaned R2 bytes are safer than a live DB row whose
  // source bytes disappeared.
  await deleteKnowledgeObject(source.r2Key);
}
