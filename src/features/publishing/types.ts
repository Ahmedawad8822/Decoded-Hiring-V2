import { z } from "zod";

// ============================================================================
// SHARED PUBLISHING PRIMITIVES (Mission 05 extraction — REUSE FIRST)
// ----------------------------------------------------------------------------
// These primitives capture the REAL shared requirements between Guides and
// Field Notes. They were extracted from the proven Guide implementation
// (src/features/guides/types.ts) without changing Guide behavior: Guides
// keep importing the same names from "@/features/guides/types", which now
// re-exports these shared definitions.
//
// Deliberately NOT generalized here:
// - Guide metadata (category, tags, resource block CTA) stays Guide-specific.
// - Database access stays per-domain (no generic repositories).
// - Lifecycle timestamps stay per-domain via lifecycle.ts helpers.
// ============================================================================

export type ContentStatus = "draft" | "published" | "archived";

export const contentStatusSchema = z.union([
  z.literal("draft"),
  z.literal("published"),
  z.literal("archived"),
]);

// ----------------------------------------------------------------------------
// Shared structured content blocks (XSS-safe, no raw HTML / Markdown storage)
// ----------------------------------------------------------------------------

export type ContentBlock =
  | { id: string; type: "heading"; level: 2 | 3; text: string; anchor?: string }
  | { id: string; type: "paragraph"; text: string }
  | { id: string; type: "blockquote"; text: string }
  | { id: string; type: "callout"; tone: "evidence" | "note"; label: string; text: string }
  | { id: string; type: "list"; style: "bullet" | "ordered"; items: string[] }
  | { id: string; type: "resource"; title: string; meta: string; note: string; buttonLabel: string };

export const contentBlockSchema = z.discriminatedUnion("type", [
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

export const contentBlocksArraySchema = z.array(contentBlockSchema);

/**
 * Field Notes author with a lightweight subset of blocks. The storage schema
 * stays the full shared union (no parallel content model), but the Field
 * Notes editor only offers these types to keep authoring fast and scannable.
 */
export const FIELD_NOTE_BLOCK_TYPES = [
  "heading",
  "paragraph",
  "blockquote",
  "callout",
  "list",
] as const;

export type FieldNoteBlockType = (typeof FIELD_NOTE_BLOCK_TYPES)[number];

// ============================================================================
// Shared validation helpers
// ============================================================================

export const slugRegex = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const slugSchema = z
  .string()
  .min(3, "Slug must be at least 3 characters")
  .max(100)
  .regex(slugRegex, "Slug must be lowercase alphanumeric with hyphens (e.g. 'talent-strategy')");

export function slugifyTitle(title: string): string {
  return title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * URL protocol security validator:
 * Disallow javascript:, data:, vbscript: and unsafe protocols.
 * Allow relative (/...), hash (#...), http, https, mailto, tel.
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

// ============================================================================
// Shared reading-time helper (Field Notes show auto-calculated reading time;
// Guides deliberately retain their curated value — see MISSION-05 doc)
// ============================================================================

export function estimateReadingTime(blocks: ContentBlock[]): number {
  let words = 0;
  for (const block of blocks) {
    switch (block.type) {
      case "heading":
      case "paragraph":
      case "blockquote":
        words += block.text.trim().split(/\s+/).filter(Boolean).length;
        break;
      case "callout":
        words += block.label.trim().split(/\s+/).filter(Boolean).length;
        words += block.text.trim().split(/\s+/).filter(Boolean).length;
        break;
      case "list":
        for (const item of block.items) {
          words += item.trim().split(/\s+/).filter(Boolean).length;
        }
        break;
      case "resource":
        words += block.title.trim().split(/\s+/).filter(Boolean).length;
        words += block.note.trim().split(/\s+/).filter(Boolean).length;
        break;
    }
  }
  return Math.max(1, Math.ceil(words / 200));
}
