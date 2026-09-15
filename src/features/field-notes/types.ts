import { z } from "zod";
import {
  contentBlockSchema,
  slugSchema,
  type ContentBlock,
  type ContentStatus,
} from "@/features/publishing/types";

// ============================================================================
// FIELD NOTE TYPES & VALIDATION (Mission 05)
// ----------------------------------------------------------------------------
// Field Notes share the ContentBlock storage model and ContentStatus
// lifecycle with Guides. Deliberately NOT carried over from Guides:
// category/tags taxonomy, resource-block CTAs (storage still accepts the
// full shared union — the editor simply doesn't offer them), manual
// reading-time input (reading time is auto-calculated on render).
// ============================================================================

export type FieldNoteStatus = ContentStatus;
export type FieldNoteBlock = ContentBlock;

export const createFieldNoteSchema = z.object({
  title: z.string().min(3, "Title must be at least 3 characters").max(200),
  slug: slugSchema,
  excerpt: z.string().max(500).optional(),
  author: z.string().min(2).max(100).optional().default("Ahmed Awad"),
  coverImage: z.string().url().or(z.string().startsWith("/")).optional().nullable(),
  metaTitle: z.string().max(100).optional(),
  metaDescription: z.string().max(300).optional(),
  body: z.array(contentBlockSchema).default([]),
});

export const updateFieldNoteSchema = createFieldNoteSchema.partial().extend({
  id: z.string().min(1),
});

export type CreateFieldNoteInput = z.infer<typeof createFieldNoteSchema>;
export type UpdateFieldNoteInput = z.infer<typeof updateFieldNoteSchema>;
