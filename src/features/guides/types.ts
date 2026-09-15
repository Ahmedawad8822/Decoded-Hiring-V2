import { z } from "zod";
import {
  contentBlockSchema,
  contentBlocksArraySchema,
  slugRegex,
  slugSchema,
  isSafeUrl,
  type ContentBlock,
  type ContentStatus,
} from "@/features/publishing/types";

// ============================================================================
// GUIDE TYPES (Mission 05: thin compatibility layer over shared primitives)
// ----------------------------------------------------------------------------
// All type shapes, schemas, and helpers are defined once in
// src/features/publishing/types.ts. This module re-exports them under the
// original Guide names so every existing Guide import keeps working with
// byte-identical runtime behavior.
// ----------------------------------------------------------------------------
// Guide-specific surface retained here:
// - createGuideSchema / updateGuideSchema (category, tags, resource blocks)
// - Guide-only metadata fields (author default, category, tags, coverImage)
// ============================================================================

export type GuideStatus = ContentStatus;
export type GuideBlock = ContentBlock;

export {
  contentBlockSchema as guideBlockSchema,
  contentBlocksArraySchema as guideBlocksArraySchema,
  slugRegex,
  slugSchema,
  isSafeUrl,
};

export const createGuideSchema = z.object({
  title: z.string().min(3, "Title must be at least 3 characters").max(200),
  slug: slugSchema,
  excerpt: z.string().max(500).optional(),
  author: z.string().min(2).max(100).optional().default("Ahmed Awad"),
  category: z.string().max(50).optional(),
  tags: z.string().max(200).optional(),
  coverImage: z.string().url().or(z.string().startsWith("/")).optional().nullable(),
  metaTitle: z.string().max(100).optional(),
  metaDescription: z.string().max(300).optional(),
  body: z.array(contentBlockSchema).default([]),
});

export const updateGuideSchema = createGuideSchema.partial().extend({
  id: z.string().min(1),
});

export type CreateGuideInput = z.infer<typeof createGuideSchema>;
export type UpdateGuideInput = z.infer<typeof updateGuideSchema>;
