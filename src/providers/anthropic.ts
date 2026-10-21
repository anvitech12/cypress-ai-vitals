import type Anthropic from '@anthropic-ai/sdk';
import { requireKey, usage, type GenerateResult, type Provider } from './types';

let sdk: Promise<typeof import('@anthropic-ai/sdk')> | undefined;

async function loadSdk(): Promise<typeof import('@anthropic-ai/sdk')> {
  sdk ??= import('@anthropic-ai/sdk').catch(() => {
    throw new Error('Claude models need the Anthropic SDK: npm i -D @anthropic-ai/sdk');
  });
  return sdk;
}

export function normalizeAnthropicUsage(u: Anthropic.Usage) {
  // input_tokens excludes cached tokens; output_tokens already includes thinking tokens.
  const input = u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
  return usage(input, u.output_tokens, u.output_tokens_details?.thinking_tokens);
}

type ImageMime = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

export const anthropicProvider: Provider = {
  async generate(model, req): Promise<GenerateResult> {
    if (req.task !== 'text') throw new Error(`The anthropic provider supports text and vision, not "${req.task}".`);
    requireKey(model, 'ANTHROPIC_API_KEY');
    const { default: AnthropicClient } = await loadSdk();
    const client = new AnthropicClient({
      apiKey: model.apiKey,
      ...(model.baseUrl && !model.baseUrl.startsWith('https://api.anthropic.com') ? { baseURL: model.baseUrl } : {}),
      defaultHeaders: model.headers,
    });
    const p = { ...model.params, ...req.params };
    const content: Anthropic.ContentBlockParam[] = [
      ...(req.images ?? []).map((img): Anthropic.ImageBlockParam => ({
        type: 'image',
        source: { type: 'base64', media_type: img.mime as ImageMime, data: img.data.toString('base64') },
      })),
      { type: 'text', text: req.prompt ?? '' },
    ];
    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: model.model,
      max_tokens: (p.maxTokens as number | undefined) ?? 16000,
      messages: [{ role: 'user', content }],
      ...(req.system ? { system: req.system } : {}),
      ...(p.reasoningEffort ? { output_config: { effort: p.reasoningEffort as 'low' | 'medium' | 'high' | 'xhigh' | 'max' } } : {}),
      // Only forwarded when the user sets it: current Claude models reject sampling parameters.
      ...(p.temperature !== undefined ? { temperature: p.temperature as number } : {}),
    };

    const started = performance.now();
    const response = await client.messages.create(params);
    const latencyMs = performance.now() - started;
    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('')
      .trim();
    return {
      text,
      finishReason: response.stop_reason ?? undefined,
      usage: normalizeAnthropicUsage(response.usage),
      latencyMs,
      servedModel: response.model,
    };
  },
};
