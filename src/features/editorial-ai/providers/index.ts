// ============================================================================
// EDITORIAL AI — LLM PROVIDER INTERFACE
// ----------------------------------------------------------------------------
// Abstraction over any OpenAI-compatible chat completions API. Generation is
// fail-closed: when no provider is configured, `resolveProvider` throws
// EditorialProviderNotConfiguredError (there is NO silent FakeProvider
// fallback in production code — callers must resolve explicitly, and tests
// inject a fake via `generateDraft`'s `opts.provider`).
//
// Env vars (all required to enable real generation):
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

/**
 * Thrown by `resolveProvider` when no LLM provider is configured.
 * Generation is fail-closed: we never silently fall back to a fake provider.
 */
export class EditorialProviderNotConfiguredError extends Error {
  readonly code = "EDITORIAL_PROVIDER_NOT_CONFIGURED";
  constructor(
    message = "AI provider is not configured. Set EDITORIAL_MODEL_API_KEY, " +
      "EDITORIAL_MODEL_BASE_URL, and EDITORIAL_MODEL_NAME in your environment to " +
      "enable draft generation.",
  ) {
    super(message);
    this.name = "EditorialProviderNotConfiguredError";
  }
}

/** True for errors thrown by `resolveProvider` when the provider is unset. */
export function isProviderNotConfigured(err: unknown): boolean {
  return (
    err instanceof EditorialProviderNotConfiguredError ||
    (err instanceof Error && err.name === "EditorialProviderNotConfiguredError") ||
    (err instanceof Error && (err as { code?: string }).code === "EDITORIAL_PROVIDER_NOT_CONFIGURED")
  );
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

/**
 * Resolve the configured provider. Throws `EditorialProviderNotConfiguredError`
 * (fail-closed) when no provider is configured — there is NO silent FakeProvider
 * fallback in production code. Tests inject a fake explicitly via `generateDraft`.
 */
export async function resolveProvider(providerEnv?: ProviderEnv): Promise<LLMProvider> {
  const env = providerEnv ?? getProviderEnv();
  if (env.baseUrl && env.apiKey && env.modelName) {
    const { OpenAIProvider } = await import("./openai");
    return new OpenAIProvider(env);
  }
  throw new EditorialProviderNotConfiguredError();
}
