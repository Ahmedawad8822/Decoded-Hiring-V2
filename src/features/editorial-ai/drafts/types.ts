// ============================================================================
// EDITORIAL AI — DRAFTS DOMAIN TYPES
// ----------------------------------------------------------------------------
// Types for the editorial draft lifecycle: DRAFT → IN_REVIEW → APPROVED/
// REJECTED → PUBLISHED. Drafts are created by the LLM generation pipeline
// and reviewed/approved by editors before being published as Guides or
// Field Notes.
// ============================================================================

import { z } from "zod";
import type { LlmBlock } from "../skills/types";

/** Draft status lifecycle: DRAFT → IN_REVIEW → APPROVED → PUBLISHED */
export const DRAFT_STATUSES = ["DRAFT", "IN_REVIEW", "APPROVED", "REJECTED", "PUBLISHED"] as const;
export type DraftStatus = (typeof DRAFT_STATUSES)[number];

export const contentTypeSchema = z.enum(["GUIDE", "FIELD_NOTE"]);
export type DraftContentType = z.infer<typeof contentTypeSchema>;

/** Input for generating a new editorial draft. */
export const generateDraftSchema = z.object({
  contentType: contentTypeSchema,
  topic: z.string().min(3).max(200),
  workingTitle: z.string().max(200).optional(),
  audience: z.string().max(500).optional(),
  angle: z.string().max(500).optional(),
  objective: z.string().max(1000).optional(),
  notes: z.string().max(2000).optional(),
  sourceIds: z.array(z.string().uuid()).optional(),
});

export type GenerateDraftInput = z.infer<typeof generateDraftSchema>;

/** Input for updating an existing draft (editor edits LLM output). */
export const updateDraftSchema = z.object({
  title: z.string().min(3).max(200).optional(),
  slug: z.string().min(3).max(100).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).optional(),
  excerpt: z.string().max(500).optional(),
  body: z.array(z.any()).optional(), // LlmBlock[] — validated by service
  metaTitle: z.string().max(100).optional(),
  metaDescription: z.string().max(300).optional(),
});

export type UpdateDraftInput = z.infer<typeof updateDraftSchema>;

/** Source provenance — which knowledge chunks informed this draft. */
export interface DraftSourceProvenance {
  sourceId: string;
  sourceTitle: string;
  chunkId: string;
  heading: string | null;
  ordinal: number;
  content: string;
  rank: number;
}

/** A draft with its source provenance and parsed body. */
export interface EditorialDraftWithSources {
  id: string;
  contentType: DraftContentType;
  title: string;
  slug: string;
  excerpt: string | null;
  body: LlmBlock[];
  metaTitle: string | null;
  metaDescription: string | null;
  status: DraftStatus;
  skillId: string;
  skillVersion: string;
  provider: string | null;
  model: string | null;
  createdBy: string;
  reviewedBy: string | null;
  approvedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
  submittedAt: Date | null;
  approvedAt: Date | null;
  rejectedAt: Date | null;
  publishedAt: Date | null;
  publishedEntityId: string | null;
  publishedEntityType: "guide" | "field_note" | null;
  sources: DraftSourceProvenance[];
}

/** Input for the review decision log (approve/reject/send-back notes). */
export const reviewNoteSchema = z.object({
  note: z.string().max(2000).optional(),
});

export type ReviewNoteInput = z.infer<typeof reviewNoteSchema>;

/**
 * Status transition rules (Mission 07 §10):
 *   DRAFT     → IN_REVIEW   (submit for review)
 *   IN_REVIEW → DRAFT       (send back for edits)
 *   IN_REVIEW → APPROVED    (approve)
 *   IN_REVIEW → REJECTED    (reject — terminal)
 *   APPROVED  → PUBLISHED   (publish to guide/field-note)
 *
 * All other transitions are rejected. PUBLISHED and REJECTED are terminal.
 */
export const ALLOWED_DRAFT_TRANSITIONS: ReadonlyArray<{ from: DraftStatus; to: DraftStatus; action: string }> = [
  { from: "DRAFT", to: "IN_REVIEW", action: "submit_for_review" },
  { from: "IN_REVIEW", to: "DRAFT", action: "send_back" },
  { from: "IN_REVIEW", to: "APPROVED", action: "approve" },
  { from: "IN_REVIEW", to: "REJECTED", action: "reject" },
  { from: "APPROVED", to: "PUBLISHED", action: "publish" },
];

export function isValidDraftTransition(from: DraftStatus, to: DraftStatus): boolean {
  return ALLOWED_DRAFT_TRANSITIONS.some((t) => t.from === from && t.to === to);
}
