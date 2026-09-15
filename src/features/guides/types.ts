import { z } from "zod";

// ============================================================================
// TYPED GUIDE BLOCKS (XSS-safe structured content representation)
// ============================================================================

export type GuideBlock =
  | { id: string; type: "heading"; level: 2 | 3; text: string; anchor?: string }
  | { id: string; type: "paragraph"; text: string }
  | { id: string; type: "blockquote"; text: string }
  | { id: string; type: "callout"; tone: "evidence" | "note"; label: string; text: string }
  | { id: string; type: "list"; style: "bullet" | "ordered"; items: string[] }
  | { id: string; type: "resource"; title: string; meta: string; note: string; buttonLabel: string };

export const guideBlockSchema = z.discriminatedUnion("type", [
  z.object({
    id: z.string(),
    type: z.literal("heading"),
    level: z.union([z.literal(2), z.literal(3)]),
    text: z.string().min(1),
    anchor: z.string().optional(),
  }),
  z.object({
    id: z.string(),
    type: z.literal("paragraph"),
    text: z.string().min(1),
  }),
  z.object({
    id: z.string(),
    type: z.literal("blockquote"),
    text: z.string().min(1),
  }),
  z.object({
    id: z.string(),
    type: z.literal("callout"),
    tone: z.union([z.literal("evidence"), z.literal("note")]),
    label: z.string().min(1),
    text: z.string().min(1),
  }),
  z.object({
    id: z.string(),
    type: z.literal("list"),
    style: z.union([z.literal("bullet"), z.literal("ordered")]),
    items: z.array(z.string().min(1)),
  }),
  z.object({
    id: z.string(),
    type: z.literal("resource"),
    title: z.string().min(1),
    meta: z.string().min(1),
    note: z.string().min(1),
    buttonLabel: z.string().min(1),
  }),
]);

export const guideBlocksArraySchema = z.array(guideBlockSchema);

// ============================================================================
// VALIDATION SCHEMAS FOR GUIDE ACTIONS
// ============================================================================

export const slugRegex = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const createGuideSchema = z.object({
  title: z.string().min(3, "Title must be at least 3 characters").max(200),
  slug: z
    .string()
    .min(3, "Slug must be at least 3 characters")
    .max(100)
    .regex(slugRegex, "Slug must be lowercase alphanumeric with hyphens (e.g. 'talent-strategy')"),
  excerpt: z.string().max(500).optional(),
  author: z.string().min(2).max(100).optional().default("Ahmed Awad"),
  category: z.string().max(50).optional(),
  tags: z.string().max(200).optional(),
  coverImage: z.string().url().or(z.string().startsWith("/")).optional().nullable(),
  metaTitle: z.string().max(100).optional(),
  metaDescription: z.string().max(300).optional(),
  body: z.array(guideBlockSchema).default([]),
});

export const updateGuideSchema = createGuideSchema.partial().extend({
  id: z.string().min(1),
});

export type CreateGuideInput = z.infer<typeof createGuideSchema>;
export type UpdateGuideInput = z.infer<typeof updateGuideSchema>;

/**
 * URL protocol security validator (Correction 3):
 * Disallow javascript:, data:, vbscript: and unsafe protocols.
 * Allow relative (/...), http, https, mailto, tel.
 */
export function isSafeUrl(url?: string | null): boolean {
  if (!url) return false;
  const trimmed = url.trim().toLowerCase();
  if (
    trimmed.startsWith("javascript:") ||
    trimmed.startsWith("data:") ||
    trimmed.startsWith("vbscript:") ||
    trimmed.startsWith("file:")
  ) {
    return false;
  }
  if (trimmed.startsWith("/") || trimmed.startsWith("#")) {
    return true;
  }
  try {
    const parsed = new URL(url);
    return ["http:", "https:", "mailto:", "tel:"].includes(parsed.protocol);
  } catch {
    return false;
  }
}
