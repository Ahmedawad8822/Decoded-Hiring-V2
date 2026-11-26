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

  /**
   * Deterministic course-outline draft for the Studio curriculum editor
   * (src/features/course-outline). Groups the retrieved knowledge chunks into
   * up to 3 sections of 2 lessons, deriving titles from chunk headings and
   * summaries from chunk content. No network calls; output is fully
   * determined by the input chunks so tests and local dev work without a key.
   *
   * The result is plain structured data — the course-outline service validates
   * it against its own zod schema exactly like real provider output, so this
   * path exercises the same sanitize-and-ground pipeline.
   */
  async generateOutline(input: {
    topic: string;
    chunks: FakeOutlineChunk[];
  }): Promise<FakeOutlineJson> {
    const chunks = input.chunks.slice(0, 6);
    const sections: FakeOutlineJson["sections"] = [];
    for (let i = 0; i < chunks.length; i += 2) {
      const pair = chunks.slice(i, i + 2);
      const first = pair[0]!;
      const sectionTitle = first.heading?.trim() || `${first.sourceTitle} — part ${sections.length + 1}`;
      sections.push({
        title: sectionTitle.slice(0, 160),
        lessons: pair.map((chunk) => ({
          title: (chunk.heading?.trim() || firstSentence(chunk.content)).slice(0, 160),
          summary: firstSentence(chunk.content).slice(0, 500),
          // Deterministic 10–50 minute estimate derived from chunk length.
          durationMinutes: 10 + (chunk.content.length % 41),
          sourceIds: [chunk.sourceId],
        })),
      });
    }
    return { sections };
  }
}

/** Minimal chunk view the fake outline needs (structural — no imports). */
export interface FakeOutlineChunk {
  chunkId: string;
  sourceId: string;
  sourceTitle: string;
  heading: string | null;
  ordinal: number;
  content: string;
}

/** Raw outline JSON shape (mirrors the course-outline raw schema). */
export interface FakeOutlineJson {
  sections: Array<{
    title: string;
    lessons: Array<{
      title: string;
      summary: string;
      durationMinutes: number;
      sourceIds: string[];
    }>;
  }>;
}

function firstSentence(text: string): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  const match = cleaned.match(/^(.+?[.!?])(\s|$)/);
  return (match?.[1] ?? cleaned).slice(0, 200) || "Key concept from the knowledge base.";
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
