// ============================================================================
// EDITORIAL AI — LLM PROVIDER INTERFACE
// ----------------------------------------------------------------------------
// Abstraction over any OpenAI-compatible chat completions API. In dev/test
// or when no credentials are configured, the FakeProvider is used.
//
// Env vars (all optional — FakeProvider activates when unset):
//   EDITORIAL_MODEL_BASE_URL    API endpoint (e.g. https://api.openai.com/v1)
//   EDITORIAL_MODEL_API_KEY     Bearer token
//   EDITORIAL_MODEL_NAME        Model identifier (e.g. gpt-4o-mini)
//   EDITORIAL_MODEL_TEMPERATURE Sampling temperature (default 0.3)
//   EDITORIAL_MODEL_MAX_TOKENS  Max output tokens (default 2000)
// ============================================================================

import type { GenerationContext, GenerationParams, LLMDraftOutput } from "../skills/types";

export interface LLMGenerateInput {
  skillId: string;
  context: GenerationContext;
  params: GenerationParams;
}

export interface LLMProvider {
  readonly name: string;
  isConfigured(): boolean;
  generateDraft(input: LLMGenerateInput): Promise<LLMDraftOutput>;
}

export interface ProviderEnv {
  baseUrl: string | undefined;
  apiKey: string | undefined;
  modelName: string | undefined;
  temperature: number;
  maxTokens: number;
}

/** Read provider config from environment. */
export function getProviderEnv(): ProviderEnv {
  const parseNumber = (val: string | undefined, fallback: number) => {
    if (!val) return fallback;
    const n = parseFloat(val);
    return isNaN(n) ? fallback : n;
  };
  return {
    baseUrl: process.env.EDITORIAL_MODEL_BASE_URL,
    apiKey: process.env.EDITORIAL_MODEL_API_KEY,
    modelName: process.env.EDITORIAL_MODEL_NAME,
    temperature: parseNumber(process.env.EDITORIAL_MODEL_TEMPERATURE, 0.3),
    maxTokens: parseNumber(process.env.EDITORIAL_MODEL_MAX_TOKENS, 2000),
  };
}

/** Resolve the configured provider: OpenAI if env vars are set, Fake otherwise. */
export async function resolveProvider(): Promise<LLMProvider> {
  const env = getProviderEnv();
  if (env.baseUrl && env.apiKey && env.modelName) {
    const { OpenAIProvider } = await import("./openai");
    return new OpenAIProvider(env);
  }
  const { FakeProvider } = await import("./fake");
  return new FakeProvider();
}
