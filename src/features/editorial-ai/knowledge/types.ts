// ============================================================================
// KNOWLEDGE DOMAIN — TYPES, SCHEMAS, CONSTANTS
// ----------------------------------------------------------------------------
// Zod schemas for admin input validation, MIME/extension mapping, and shared
// types used across the knowledge ingestion, retrieval, and rendering layers.
// ============================================================================

import { z } from "zod";

// ---------------------------------------------------------------------------
// Supported input types (Mission 07: text/plain, text/markdown only)
// ---------------------------------------------------------------------------

export const SUPPORTED_MIME_TYPES = ["text/plain", "text/markdown"] as const;
export type SupportedMimeType = (typeof SUPPORTED_MIME_TYPES)[number];

export const MIME_TO_EXTENSION: Record<SupportedMimeType, string> = {
  "text/plain": "txt",
  "text/markdown": "md",
};

export const MIME_TO_SOURCE_TYPE: Record<SupportedMimeType, "text" | "markdown"> = {
  "text/plain": "text",
  "text/markdown": "markdown",
};

export const MAX_KNOWLEDGE_FILE_SIZE = 2 * 1024 * 1024; // 2 MB

export function isSupportedMimeType(mimeType: string): mimeType is SupportedMimeType {
  return SUPPORTED_MIME_TYPES.includes(mimeType.toLowerCase() as SupportedMimeType);
}

/** True when the MIME type is supported but the file extension is wrong
 *  (e.g. contentType "text/plain" but filename "doc.md"). This is a warning,
 *  not a rejection — the MIME type is authoritative. */
export function extensionMatchesMime(filename: string, mimeType: SupportedMimeType): boolean {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  const expected = MIME_TO_EXTENSION[mimeType];
  return ext === expected || (ext === "txt" && expected === "txt") || (ext === "md" && expected === "md");
}

// ---------------------------------------------------------------------------
// Knowledge source lifecycle statuses
// ---------------------------------------------------------------------------

export const KNOWLEDGE_STATUSES = ["UPLOADED", "INGESTING", "READY", "FAILED", "ARCHIVED"] as const;
export type KnowledgeStatus = (typeof KNOWLEDGE_STATUSES)[number];

export const RETRIEVABLE_STATUSES: KnowledgeStatus[] = ["READY"];

// ---------------------------------------------------------------------------
// Zod: upload input validation
// ---------------------------------------------------------------------------

export const uploadKnowledgeSchema = z.object({
  title: z.string().min(3, "Title must be at least 3 characters").max(200),
  sourceType: z.enum(["text", "markdown"]),
  mimeType: z.enum(["text/plain", "text/markdown"]),
  originalFilename: z.string().min(1, "Filename is required").max(255),
  author: z.string().max(200).optional().nullable(),
  sourceLabel: z.string().max(200).optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
});

export type UploadKnowledgeInput = z.infer<typeof uploadKnowledgeSchema>;

// ---------------------------------------------------------------------------
// Retrieval result type
// ---------------------------------------------------------------------------

export interface RetrievedChunk {
  chunkId: string;
  sourceId: string;
  sourceTitle: string;
  heading: string | null;
  ordinal: number;
  content: string;
  rank: number;
}

export interface RetrievalOptions {
  query: string;
  topK?: number;
  sourceIds?: string[];
}

export const MAX_RETRIEVAL_K = 10;
