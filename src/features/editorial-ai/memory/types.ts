// ============================================================================
// EDITORIAL AI — MEMORY DOMAIN TYPES
// ----------------------------------------------------------------------------
// Structured editorial constraints that guide the LLM's voice, positioning,
// audience understanding, and methodology. Active memory items are injected
// into every generation prompt as a "EDITORIAL MEMORY" context block.
//
// Source of truth (Mission 07 §4):
//   - Pre-seeded with 8 categories × 1-2 items covering Decoded's positioning.
//   - Admin manages via /admin/editorial/memory.
//   - Only ACTIVE, non-archived items participate in generation.
// ============================================================================

import { z } from "zod";

export const MEMORY_CATEGORIES = [
  "POSITIONING",
  "VOICE",
  "AUDIENCE",
  "METHODOLOGY",
  "EDITORIAL_RULE",
  "AVOID",
  "EDITORIAL_NOTE",
] as const;

export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

export const memoryCategorySchema = z.enum(MEMORY_CATEGORIES);

/** Category human-readable labels for the admin UI. */
export const MEMORY_CATEGORY_LABELS: Record<MemoryCategory, string> = {
  POSITIONING: "Positioning",
  VOICE: "Voice",
  AUDIENCE: "Audience",
  METHODOLOGY: "Methodology",
  EDITORIAL_RULE: "Editorial Rule",
  AVOID: "Avoid",
  EDITORIAL_NOTE: "Editorial Note",
};

/** Zod schema for creating a memory item (admin input validation). */
export const createMemorySchema = z.object({
  category: memoryCategorySchema,
  content: z.string().min(3).max(1000),
});

export type CreateMemoryInput = z.infer<typeof createMemorySchema>;

/** Zod schema for updating a memory item. */
export const updateMemorySchema = z.object({
  category: memoryCategorySchema.optional(),
  content: z.string().min(3).max(1000).optional(),
  active: z.boolean().optional(),
});

export type UpdateMemoryInput = z.infer<typeof updateMemorySchema>;

/**
 * Pre-seeded editorial memory items (Mission 07 §4 — foundation defaults).
 * These ship with every fresh database via migration 0006. They capture
 * Decoded's core positioning and must never be overridden by retrieved
 * knowledge — they are injected as a separate, immutable context block.
 */
export const SEEDED_MEMORY: CreateMemoryInput[] = [
  {
    category: "POSITIONING",
    content: "Decoded teaches working engineers to ship better software, not consume tutorials. Every insight must lead to an action the reader can take in their codebase today.",
  },
  {
    category: "POSITIONING",
    content: "Decoded verifies every claim against the actual tools and systems in use before publication — never documentation alone.",
  },
  {
    category: "VOICE",
    content: "Write like a senior engineer who has shipped the thing they're describing — confident, precise, never salesy. Avoid marketing fluff; cite evidence by name.",
  },
  {
    category: "AUDIENCE",
    content: "Audience: working engineers building and operating real software. Assume deep technical knowledge but not familiarity with the specific problem space.",
  },
  {
    category: "METHODOLOGY",
    content: "Aha Authority format: lead with an unexpected insight, ground every claim in evidence, then provide a concrete next step. Never lead with context-setting.",
  },
  {
    category: "EDITORIAL_RULE",
    content: "Never embed raw Markdown, HTML, or code blocks in output — only structured content blocks (headings, paragraphs, blockquotes, callouts, lists).",
  },
  {
    category: "AVOID",
    content: "Avoid: 'in today's tutorial', 'let's build together', filler phrases, promises about future content, and any instruction to 'imagine' or 'pretend'.",
  },
  {
    category: "AVOID",
    content: "Never reproduce full source material verbatim — summarize, paraphrase, and cite by name.",
  },
  {
    category: "EDITORIAL_NOTE",
    content: "When writing about a specific tool, language, or runtime, reference the real version and source files in use — not upstream documentation or memory.",
  },
  {
    category: "EDITORIAL_RULE",
    content: "Callout blocks with tone 'evidence' must cite the source title in the label field. Blockquote blocks are for direct paraphrase attribution.",
  },
];

/** Flat list of seeded memory items for migration seeding. */
export const SEED_MEMORY_VALUES: Array<{
  id: string;
  category: MemoryCategory;
  content: string;
  active: boolean;
}> = SEEDED_MEMORY.map((item, i) => ({
  id: `mem_${String(i + 1).padStart(3, "0")}`,
  category: item.category,
  content: item.content,
  active: true,
}));
