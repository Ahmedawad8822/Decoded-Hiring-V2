// ============================================================================
// EDITORIAL AI — OPENAI-COMPATIBLE LLM PROVIDER
// ----------------------------------------------------------------------------
// Calls any OpenAI-compatible chat completions endpoint with:
//   - A system prompt (from the skill's buildSystemPrompt)
//   - A user message (from buildGenerationPrompt)
//   - response_format = { type: "json_object" } for structured output
//   - Bounded max_tokens and temperature
//
// The raw JSON response is parsed and validated against the skill's output
// schema before returning.
// ============================================================================

import type { LLMProvider, LLMGenerateInput, ProviderEnv } from "./index";
import type { LLMDraftOutput } from "../skills/types";
import { validateDraftOutput, buildGenerationPrompt } from "../skills/aha-authority";
import { AHA_AUTHORITY_V1, SKILL_ID } from "../skills/aha-authority";

export class OpenAIProvider implements LLMProvider {
  readonly name = "openai";
  private readonly env: ProviderEnv;

  constructor(env: ProviderEnv) {
    this.env = env;
  }

  isConfigured(): boolean {
    return Boolean(this.env.baseUrl && this.env.apiKey && this.env.modelName);
  }

  async generateDraft(input: LLMGenerateInput): Promise<LLMDraftOutput> {
    if (!this.isConfigured()) {
      throw new Error("OpenAIProvider is not configured (missing base URL, API key, or model name)");
    }

    // Build the full prompt using the skill. Currently only AHA_AUTHORITY_V1
    // is supported, but the dispatch is structured to make adding skills easy.
    if (input.skillId !== SKILL_ID) {
      throw new Error(`Unsupported skill: "${input.skillId}". Available: ${SKILL_ID}`);
    }

    const prompt = buildGenerationPrompt(input.context, input.params);
    const systemPrompt = AHA_AUTHORITY_V1.systemPrompt(input.context, input.params);

    const response = await fetch(this.env.baseUrl + "/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.env.apiKey}`,
      },
      body: JSON.stringify({
        model: this.env.modelName,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: prompt },
        ],
        response_format: { type: "json_object" },
        temperature: this.env.temperature,
        max_tokens: this.env.maxTokens,
      }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "<unreadable>");
      throw new Error(
        `LLM request failed: ${response.status} ${response.statusText}. Body: ${text.slice(0, 500)}`
      );
    }

    const data: unknown = await response.json();

    // Extract the JSON string from the response. The provider returns
    // { choices: [{ message: { content: "<json string>" } }] }.
    const content = extractContent(data);
    if (!content) {
      throw new Error("LLM response contained no content");
    }

    // Parse JSON — the LLM might wrap it in markdown code fences.
    const parsed = parseJsonFromContent(content);

    return validateDraftOutput(parsed);
  }
}

/** Navigate the OpenAI chat completion response shape safely. */
function extractContent(data: unknown): string | null {
  try {
    const obj = data as { choices?: Array<{ message?: { content?: string } }> };
    return obj.choices?.[0]?.message?.content ?? null;
  } catch {
    return null;
  }
}

/** Strip markdown code fences if present, then JSON.parse. */
function parseJsonFromContent(content: string): unknown {
  let cleaned = content.trim();
  // Remove leading/trailing ``` fences with optional language tag
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```[a-z]*\n/, "").replace(/\n```$/, "");
  }
  return JSON.parse(cleaned);
}
