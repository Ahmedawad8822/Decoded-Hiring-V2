// ============================================================================
// EDITORIAL AI — FAKE LLM PROVIDER
// ----------------------------------------------------------------------------
// Returns deterministic, valid LLMDraftOutput without any network calls.
// Used in tests and local development when no model credentials are set.
//
// The fake output is crafted to:
// - Always pass schema validation (llmDraftOutputSchema).
// - Include evidence callouts pointing to the first retrieved chunk.
// - Produce reproducible results for the same input.
// ============================================================================

import type { LLMProvider, LLMGenerateInput } from "./index";
import type { LLMDraftOutput } from "../skills/types";
import { validateDraftOutput } from "../skills/aha-authority";
import { AHA_AUTHORITY_V1 } from "../skills/aha-authority";

export class FakeProvider implements LLMProvider {
  readonly name = "fake";

  isConfigured(): boolean {
    return true; // always available
  }

  async generateDraft(input: LLMGenerateInput): Promise<LLMDraftOutput> {
    // Build the full prompt to ensure the skill is exercised even in fake mode.
    // (We don't send it anywhere, but constructing it validates the skill wiring.)
    void AHA_AUTHORITY_V1.systemPrompt(input.context, input.params);

    const topic = input.params.topic || "the craft of building";
    const firstChunk = input.context.retrievedChunks[0];

    const sourceLabel = firstChunk
      ? `${firstChunk.sourceTitle} (chunk ${firstChunk.ordinal})`
      : "Decoded knowledge base";

    const output = {
      title: topic.charAt(0).toUpperCase() + topic.slice(1),
      slugSuggestion: slugify(topic),
      excerpt: `An evidence-backed look at ${topic}, grounded in source material.`,
      contentBlocks: [
        {
          type: "paragraph" as const,
          text: `When we dig into ${topic}, one pattern keeps surfacing across the evidence:`,
        },
        ...(firstChunk
          ? [
              {
                type: "paragraph" as const,
                text: truncate(firstChunk.content, 300),
              },
            ]
          : []),
        {
          type: "blockquote" as const,
          text: "The reader's job is to act on this insight, not to admire it.",
        },
        {
          type: "callout" as const,
          tone: "evidence" as const,
          label: `Source: ${sourceLabel}`,
          text: "The above analysis is drawn from the supplied knowledge chunks and editorial memory.",
        },
        {
          type: "list" as const,
          style: "bullet" as const,
          items: [
            `Key takeaway from ${topic}: the unexpected pattern is the signal, not the noise.`,
            "Apply this by questioning the default path on your current project.",
          ],
        },
      ],
      metaTitle: `Aha: ${topic}`,
      metaDescription: `Discover an unexpected insight about ${topic} backed by evidence.`,
      reasoning: `Generated ${topic} with aha framing. Source: ${sourceLabel}.`,
    };

    // Validate before returning — catches schema drift in tests.
    return validateDraftOutput(output);
  }
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + "...";
}
