import type { Usage } from './types';

type Obj = Record<string, any>;

function n(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/**
 * Reads token usage from any common response shape: normalized ({ inputTokens, outputTokens }),
 * OpenAI-style ({ prompt_tokens, completion_tokens }), Anthropic ({ input_tokens, output_tokens }),
 * or Gemini ({ promptTokenCount, candidatesTokenCount, thoughtsTokenCount }).
 */
export function normalizeAnyUsage(raw: unknown): Usage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const u = raw as Obj;
  if (n(u.inputTokens) !== undefined && n(u.outputTokens) !== undefined) {
    return { inputTokens: u.inputTokens, outputTokens: u.outputTokens, reasoningTokens: n(u.reasoningTokens), totalTokens: n(u.totalTokens) ?? u.inputTokens + u.outputTokens };
  }
  if (n(u.prompt_tokens) !== undefined || n(u.completion_tokens) !== undefined) {
    const input = n(u.prompt_tokens) ?? 0;
    const output = n(u.completion_tokens) ?? 0;
    return { inputTokens: input, outputTokens: output, reasoningTokens: n(u.completion_tokens_details?.reasoning_tokens), totalTokens: input + output };
  }
  if (n(u.input_tokens) !== undefined && n(u.output_tokens) !== undefined) {
    const input = u.input_tokens + (n(u.cache_creation_input_tokens) ?? 0) + (n(u.cache_read_input_tokens) ?? 0);
    return { inputTokens: input, outputTokens: u.output_tokens, reasoningTokens: n(u.output_tokens_details?.thinking_tokens), totalTokens: input + u.output_tokens };
  }
  if (n(u.promptTokenCount) !== undefined) {
    const thoughts = n(u.thoughtsTokenCount);
    const output = (n(u.candidatesTokenCount) ?? 0) + (thoughts ?? 0);
    return { inputTokens: u.promptTokenCount, outputTokens: output, reasoningTokens: thoughts, totalTokens: u.promptTokenCount + output };
  }
  return undefined;
}

/** Parses a Server-Timing header value and returns the duration of the named metric (default "model"). */
export function serverTimingMs(header: string | undefined, metric = 'model'): number | undefined {
  if (!header) return undefined;
  for (const part of header.split(',')) {
    const [name, ...params] = part.trim().split(';');
    if (name.trim() !== metric) continue;
    const dur = params.map((p) => p.trim()).find((p) => p.startsWith('dur='));
    if (dur) return Number(dur.slice(4));
  }
  return undefined;
}
