import { describe, expect, it } from 'vitest';
import { buildRegistry, parseModelSpec } from '../src/plugin/registry';
import { computeCost } from '../src/plugin/cost';
import { normalizeOpenAiUsage } from '../src/providers/openai';
import { normalizeGeminiUsage } from '../src/providers/gemini';
import { normalizeAnthropicUsage } from '../src/providers/anthropic';
import { normalizeAnyUsage, serverTimingMs } from '../src/shared/usage';

describe('registry', () => {
  const env = {
    AI_MODEL_FAST: 'groq:openai/gpt-oss-20b',
    AI_MODEL_FAST_REASONING_EFFORT: 'low',
    AI_MODEL_FAST_PRICE_IN: '0.1',
    AI_MODEL_FAST_PRICE_OUT: '0.5',
    AI_MODEL_IMAGE: 'cloudflare:@cf/black-forest-labs/flux-1-schnell',
    AI_MODEL_LOCAL: 'openai-compatible:llama3.2:latest',
    AI_MODEL_LOCAL_BASE_URL: 'http://localhost:11434/v1',
    AI_MODEL_GPT_OSS: 'groq:openai/gpt-oss-120b',
    GROQ_API_KEY: 'gsk_test',
    CLOUDFLARE_ACCOUNT_ID: 'acc123',
    CLOUDFLARE_API_TOKEN: 'cf_test',
  };

  it('splits only on the first colon', () => {
    expect(parseModelSpec('openai-compatible:llama3.2:latest')).toEqual({ preset: 'openai-compatible', model: 'llama3.2:latest' });
    expect(() => parseModelSpec('no-colon')).toThrow(/preset:model/);
  });

  it('builds named models with presets, keys, params and prices', () => {
    const r = buildRegistry(env);
    expect([...r.keys()].sort()).toEqual(['fast', 'gpt-oss', 'image', 'local']);
    const fast = r.get('fast')!;
    expect(fast).toMatchObject({ kind: 'openai', baseUrl: 'https://api.groq.com/openai/v1', apiKey: 'gsk_test', params: { reasoningEffort: 'low' } });
    expect(fast.price).toEqual({ inputPerMTok: 0.1, outputPerMTok: 0.5, perImage: undefined, perMinute: undefined });
    expect(r.get('image')!.baseUrl).toBe('https://api.cloudflare.com/client/v4/accounts/acc123/ai');
    expect(r.get('local')).toMatchObject({ model: 'llama3.2:latest', baseUrl: 'http://localhost:11434/v1', apiKey: undefined });
  });

  it('lets code definitions override env', () => {
    const r = buildRegistry(env, { fast: { provider: 'groq', model: 'qwen/qwen3.8-27b', params: { temperature: 0 } } });
    expect(r.get('fast')).toMatchObject({ model: 'qwen/qwen3.8-27b', params: { reasoningEffort: 'low', temperature: 0 } });
  });

  it('respects AI_MODELS as an allow-list', () => {
    expect([...buildRegistry({ ...env, AI_MODELS: 'fast' }).keys()]).toEqual(['fast']);
  });
});

describe('usage normalization', () => {
  it('OpenAI and Groq: reasoning tokens are already inside completion tokens', () => {
    expect(normalizeOpenAiUsage({ prompt_tokens: 100, completion_tokens: 300, completion_tokens_details: { reasoning_tokens: 250 } })).toEqual({
      inputTokens: 100,
      outputTokens: 300,
      reasoningTokens: 250,
      totalTokens: 400,
    });
  });

  it('Gemini: thinking tokens are added to candidate tokens', () => {
    expect(normalizeGeminiUsage({ promptTokenCount: 100, candidatesTokenCount: 50, thoughtsTokenCount: 250 })).toEqual({
      inputTokens: 100,
      outputTokens: 300,
      reasoningTokens: 250,
      totalTokens: 400,
    });
  });

  it('Anthropic: cached input counts as input; thinking is inside output', () => {
    const u = normalizeAnthropicUsage({
      input_tokens: 10,
      cache_creation_input_tokens: 40,
      cache_read_input_tokens: 50,
      output_tokens: 300,
      output_tokens_details: { thinking_tokens: 250 },
    } as never);
    expect(u).toEqual({ inputTokens: 100, outputTokens: 300, reasoningTokens: 250, totalTokens: 400 });
  });

  it('the browser-side reader agrees with every provider shape', () => {
    expect(normalizeAnyUsage({ prompt_tokens: 100, completion_tokens: 300 })?.totalTokens).toBe(400);
    expect(normalizeAnyUsage({ promptTokenCount: 100, candidatesTokenCount: 50, thoughtsTokenCount: 250 })?.outputTokens).toBe(300);
    expect(normalizeAnyUsage({ input_tokens: 100, output_tokens: 300 })?.totalTokens).toBe(400);
    expect(normalizeAnyUsage({ inputTokens: 1, outputTokens: 2 })?.totalTokens).toBe(3);
    expect(normalizeAnyUsage('nope')).toBeUndefined();
  });

  it('parses Server-Timing', () => {
    expect(serverTimingMs('db;dur=12, model;dur=1234.5;desc="llm"')).toBe(1234.5);
    expect(serverTimingMs('db;dur=12')).toBeUndefined();
  });
});

describe('cost', () => {
  const model = buildRegistry({ AI_MODEL_FAST: 'groq:x', AI_MODEL_FAST_PRICE_IN: '1', AI_MODEL_FAST_PRICE_OUT: '2', AI_MODEL_FAST_PRICE_IMAGE: '0.01' }).get('fast');

  it('prices tokens per million and images per call', () => {
    expect(computeCost(model, { inputTokens: 1_000_000, outputTokens: 500_000, totalTokens: 1_500_000 })).toBe(2);
    expect(computeCost(model, undefined, { images: 3 })).toBeCloseTo(0.03);
  });

  it('returns null when no price is configured instead of a fake $0', () => {
    expect(computeCost(buildRegistry({ AI_MODEL_X: 'groq:x' }).get('x'), { inputTokens: 5, outputTokens: 5, totalTokens: 10 })).toBeNull();
  });
});

describe('ai.env order', () => {
  it('lists models in the order they are written', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    const { loadAiEnv } = await import('../src/plugin/env');
    const dir = mkdtempSync(path.join(tmpdir(), 'ai-env-'));
    writeFileSync(path.join(dir, 'ai.env'), 'AI_MODEL_ZETA=groq:a\n# comment\nAI_MODEL_ALPHA=groq:b\nexport AI_MODEL_MID=groq:c\n');
    expect([...buildRegistry(loadAiEnv(dir)).keys()]).toEqual(['zeta', 'alpha', 'mid']);
  });
});
