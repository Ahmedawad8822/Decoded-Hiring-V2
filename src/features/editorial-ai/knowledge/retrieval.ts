// ============================================================================
// KNOWLEDGE RETRIEVAL — FTS5 FULL-TEXT SEARCH
// ----------------------------------------------------------------------------
// Uses D1's built-in FTS5 engine (no Vectorize in Mission 07). The
// knowledge_chunks_fts virtual table is an external-content table backed by
// knowledge_chunks (created in migration 0006 with sync triggers).
//
// Retrieval is bounded: max 10 chunks, optional source-id filtering.
// Only READY sources participate (FAILED/ARCHIVED/UPLOADED/INGESTING excluded).
// Results return metadata — never raw R2 object keys or original bytes.
// ============================================================================

import { getD1Database } from "@/lib/cloudflare/bindings";
import {
  MAX_RETRIEVAL_K,
  type RetrievedChunk,
  type RetrievalOptions,
} from "./types";

// D1 result row shape (columns are snake_case in the raw SQL).
interface FtsRow {
  chunk_id: string;
  source_id: string;
  source_title: string;
  heading: string | null;
  ordinal: number;
  content: string;
  rank: number;
}

/**
 * Build the FTS5 query string from a free-text search phrase. SQLite FTS5
 * treats the query as a mini-query-language — we tokenize and join terms with
 * OR so that multi-word phrases match any term, then rank by relevance.
 * Stop-words and operators from user input are neutralized by wrapping each
 * term in double quotes, which forces phrase matching and rejects FTS query
 * syntax injection.
 */
function buildFtsQuery(query: string): string {
  const terms = query
    .trim()
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);

  if (terms.length === 0) return "";
  // Each term is quoted to prevent FTS5 query-injection (e.g. user typing
  // "foo OR bar" becomes "foo" OR "bar" — a safe OR of quoted phrases).
  return terms.map((t) => `"${t}"`).join(" OR ");
}

/**
 * Search the knowledge library using FTS5.
 *
 * - Only READY, non-archived sources are searchable.
 * - topK is clamped to [1, MAX_RETRIEVAL_K].
 * - sourceIds, when provided, restricts the search to those source IDs.
 * - Never returns full R2 objects — only chunk content + metadata.
 */
export async function retrieveKnowledge(opts: RetrievalOptions): Promise<RetrievedChunk[]> {
  const topK = Math.max(1, Math.min(opts.topK ?? MAX_RETRIEVAL_K, MAX_RETRIEVAL_K));
  const ftsQuery = buildFtsQuery(opts.query);

  if (!ftsQuery) {
    return [];
  }

  const d1 = await getD1Database();
  const baseSql = `
    SELECT
      kc.id        AS chunk_id,
      ks.id        AS source_id,
      ks.title     AS source_title,
      kc.heading   AS heading,
      kc.ordinal   AS ordinal,
      kc.content   AS content,
      kcf.rank     AS rank
    FROM knowledge_chunks_fts kcf
    JOIN knowledge_chunks kc  ON kc.rowid = kcf.rowid
    JOIN knowledge_sources ks ON ks.id = kc.source_id
    WHERE knowledge_chunks_fts MATCH ?
      AND ks.status = 'READY'
      AND ks.archived_at IS NULL
  `;

  const orderLimit = ` ORDER BY kcf.rank LIMIT ${topK}`;

  let result: { results?: FtsRow[] };
  if (opts.sourceIds && opts.sourceIds.length > 0) {
    const placeholders = opts.sourceIds.map(() => "?").join(",");
    const sql = `${baseSql} AND ks.id IN (${placeholders}) ${orderLimit}`;
    const stmt = d1.prepare(sql).bind(ftsQuery, ...opts.sourceIds);
    result = await stmt.all<FtsRow>();
  } else {
    const sql = `${baseSql} ${orderLimit}`;
    const stmt = d1.prepare(sql).bind(ftsQuery);
    result = await stmt.all<FtsRow>();
  }

  if (!result.results) return [];

  return result.results.map((row) => ({
    chunkId: row.chunk_id,
    sourceId: row.source_id,
    sourceTitle: row.source_title,
    heading: row.heading,
    ordinal: row.ordinal,
    content: row.content,
    rank: row.rank,
  }));
}

/**
 * Retrieve all chunks for a specific source (admin inspection — ordered by
 * ordinal for deterministic traversal). Used by the knowledge detail page.
 */
export async function getChunksForSource(sourceId: string): Promise<ChunkView[]> {
  const d1 = await getD1Database();
  const result = await d1
    .prepare(
      `SELECT id, source_id, ordinal, heading, content, content_hash, character_count, created_at
       FROM knowledge_chunks
       WHERE source_id = ?
       ORDER BY ordinal ASC`
    )
    .bind(sourceId)
    .all<{
      id: string;
      source_id: string;
      ordinal: number;
      heading: string | null;
      content: string;
      content_hash: string;
      character_count: number;
      created_at: number;
    }>();

  return (result.results || []).map((row) => ({
    id: row.id,
    sourceId: row.source_id,
    ordinal: row.ordinal,
    heading: row.heading,
    content: row.content,
    contentHash: row.content_hash,
    characterCount: row.character_count,
    createdAt: row.created_at,
  }));
}

export interface ChunkView {
  id: string;
  sourceId: string;
  ordinal: number;
  heading: string | null;
  content: string;
  contentHash: string;
  characterCount: number;
  createdAt: number;
}
