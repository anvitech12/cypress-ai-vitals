import type { ModelConfig, ProviderKind } from '../plugin/registry';
import { anthropicProvider } from './anthropic';
import { cloudflareProvider } from './cloudflare';
import { geminiProvider } from './gemini';
import { gradioProvider } from './gradio';
import { httpProvider } from './http';
import { openAiProvider } from './openai';
import { customProviders } from '../plugin/custom-providers';
import type { GenerateRequest, GenerateResult, Provider } from './types';

const BUILT_IN: Record<ProviderKind, Provider> = {
  openai: openAiProvider,
  anthropic: anthropicProvider,
  gemini: geminiProvider,
  cloudflare: cloudflareProvider,
  gradio: gradioProvider,
  http: httpProvider,
};

/** Registers a provider for models whose preset is `name`, e.g. AI_MODEL_X=name:model. Call it before aiVitalsPlugin(). */
export function defineProvider(name: string, provider: Provider): void {
  customProviders().set(name, provider);
}

export function providerFor(model: ModelConfig): Provider {
  return customProviders().get(model.preset) ?? BUILT_IN[model.kind];
}

export function generate(model: ModelConfig, request: GenerateRequest): Promise<GenerateResult> {
  return providerFor(model).generate(model, request);
}

export { buildRegistry, describeSettings, inferKind, parseModelSpec, PRESETS, type ModelConfig, type ModelDefinition, type ModelKind } from '../plugin/registry';
export { loadAiEnv } from '../plugin/env';
export { makeRedactor, secretValues } from '../plugin/redact';
export { audioDurationSec, decodeWav, padWavWithSilence, pcm16ToWav } from '../plugin/media';
export type { GenerateRequest, GenerateResult, MediaInput, Provider } from './types';
export { withCassette, cassetteKey, CassetteMissError, type CassetteMode, type CassetteResult } from '../plugin/cassette';
export { computeCost } from '../plugin/cost';
export { normalizeAnyUsage } from '../shared/usage';
export { withRetry, RETRYABLE_STATUS } from './retry';
export { ProviderError, sniffMime } from './types';
