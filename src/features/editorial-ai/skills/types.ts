// ============================================================================
// EDITORIAL AI — SKILLS TYPES
// ----------------------------------------------------------------------------
// Structured output contract between the LLM provider and the draft service.
// The LLM produces JSON that validates against LLMDraftOutputSchema.
//
// Security (Mission 07 §9): content blocks are a strict whitelist of types.
// No raw HTML or Markdown is stored — only structured blocks, matching the
// existing ContentBlock schema from src/features/publishing/types.ts.
// ============================================================================

import { z } from "zod";

// Re-export the shared publishing ContentBlock for type compatibility.
export type { ContentBlock } from "@/features/publishing/types";

// ---------------------------------------------------------------------------
// LLM output: stripped ContentBlock (id + anchor assigned by the service
// after validation, not by the LLM).
// ---------------------------------------------------------------------------

export const llmBlockSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("heading"), level: z.union([z.literal(2), z.literal(3)]), text: z.string().min(1) }),
  z.object({ type: z.literal("paragraph"), text: z.string().min(1) }),
  z.object({ type: z.literal("blockquote"), text: z.string().min(1) }),
  z.object({
    type: z.literal("callout"),
    tone: z.union([z.literal("evidence"), z.literal("note")]),
    label: z.string().min(1),
    text: z.string().min(1),
  }),
  z.object({
    type: z.literal("list"),
    style: z.union([z.literal("bullet"), z.literal("ordered")]),
    items: z.array(z.string().min(1)).min(1),
  }),
]);

export type LlmBlock = z.infer<typeof llmBlockSchema>;

export const llmDraftOutputSchema = z.object({
  title: z.string().min(3).max(200),
  slugSuggestion: z.string().min(3).max(100).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  excerpt: z.string().max(500),
  contentBlocks: z.array(llmBlockSchema).min(1),
  metaTitle: z.string().max(100),
  metaDescription: z.string().max(300),
  reasoning: z.string().optional(),
});

export type LLMDraftOutput = z.infer<typeof llmDraftOutputSchema>;

// ---------------------------------------------------------------------------
// Generation context: assembled from knowledge + memory, passed to the skill
// prompt. This is the "bounded context" that goes to the LLM — never the raw
// R2 object, never the full document.
// ---------------------------------------------------------------------------

export interface ContextChunk {
  chunkId: string;
  sourceId: string;
  sourceTitle: string;
  heading: string | null;
  ordinal: number;
  content: string; // bounded snippet — already truncated
  rank: number;
}

export interface ActiveMemoryItem {
  category: string;
  content: string;
}

export interface GenerationContext {
  /** Retrieved knowledge chunks (bounded to MAX_RETRIEVAL_K). */
  retrievedChunks: ContextChunk[];
  /** Active editorial memory items. */
  memory: ActiveMemoryItem[];
  /** Total characters of retrieved content fed to the LLM. */
  contextChars: number;
}

export type DraftContentType = "GUIDE" | "FIELD_NOTE";

// ---------------------------------------------------------------------------
// Skill definition
// ---------------------------------------------------------------------------

export interface EditorialSkill {
  id: string;
  version: string;
  contentType: DraftContentType;
  systemPrompt: (ctx: GenerationContext, params: GenerationParams) => string;
  schema: z.ZodType;
}

export interface GenerationParams {
  contentType: DraftContentType;
  topic: string;
  workingTitle?: string;
  audience?: string;
  angle?: string;
  objective?: string;
  notes?: string;
}
