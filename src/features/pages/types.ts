import { z } from "zod";
import {
  contentBlockSchema,
  coverImageSchema,
  slugSchema,
  type ContentBlock,
  type ContentStatus,
} from "@/features/publishing/types";
import { isReservedPageSlug } from "./reserved-slugs";

// ============================================================================
// STANDARD PAGE TYPES & VALIDATION (§3)
// ----------------------------------------------------------------------------
// Governed information pages (policy, FAQ, press...) without code changes.
// Hand-built pages (About, legal, contact) stay as they are. Field Notes
// share the ContentBlock storage model and ContentStatus lifecycle; Deliberately
// NOT carried over: category/tags taxonomy, resource-block CTAs in the
// editor (storage still accepts the full shared union), manual reading-time.
// Extra page fields: summary (meta description source), SEO title/
// description, noindex flag (public but excluded from sitemap/indexing),
// show-in-footer flag.
// Slug reservation (§3): every existing top-level route and segment is
// rejected on create AND rename, with a plain British English message.
// ============================================================================

export type PageStatus = ContentStatus;
export type PageBlock = ContentBlock;

const RESERVED_MESSAGE =
  "That address is reserved for an existing site section. Please choose another slug.";

export const pageSlugSchema = slugSchema.refine((slug) => !isReservedPageSlug(slug), {
  message: RESERVED_MESSAGE,
});

export const createPageSchema = z.object({
  title: z.string().min(3, "Title must be at least 3 characters").max(200),
  slug: pageSlugSchema,
  summary: z.string().max(500, "Summary must be at most 500 characters").optional(),
  coverImage: coverImageSchema,
  metaTitle: z.string().max(100).optional(),
  metaDescription: z.string().max(300).optional(),
  noindex: z.boolean().optional().default(false),
  body: z.array(contentBlockSchema).default([]),
});

export const updatePageSchema = createPageSchema.partial().extend({
  id: z.string().min(1),
});

export const deletePageSchema = z.object({
  id: z.string().min(1),
  // Typed confirmation: the exact page title, to prevent accidental loss.
  confirmTitle: z.string().min(1, "Type the page title to confirm permanent deletion"),
});

export type CreatePageInput = z.input<typeof createPageSchema>;
export type UpdatePageInput = z.input<typeof updatePageSchema>;
export type DeletePageInput = z.infer<typeof deletePageSchema>;
