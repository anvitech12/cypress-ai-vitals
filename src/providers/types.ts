import type { Usage } from '../shared/types';
import type { ModelConfig } from '../plugin/registry';

export type GenerateTask = 'text' | 'image' | 'speech' | 'transcribe';

export interface MediaInput {
  mime: string;
  data: Buffer;
}

export interface GenerateRequest {
  task: GenerateTask;
  prompt?: string;
  system?: string;
  images?: MediaInput[];
  audio?: MediaInput;
  /** temperature, maxTokens, reasoningEffort, thinkingBudget, voice, json... */
  params?: Record<string, unknown>;
}

export interface GenerateResult {
  text?: string;
  media?: MediaInput;
  usage?: Usage;
  /** Wall clock around the HTTP call, measured in Node. */
  latencyMs: number;
  /** Server-side processing time when the provider reports it. */
  serverLatencyMs?: number;
  finishReason?: string;
  /** Model id the provider says it actually served. */
  servedModel?: string;
}

export interface Provider {
  generate(model: ModelConfig, request: GenerateRequest): Promise<GenerateResult>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export function usage(input: number, output: number, reasoning?: number): Usage {
  return { inputTokens: input, outputTokens: output, reasoningTokens: reasoning, totalTokens: input + output };
}

export function authHeaders(model: ModelConfig): Record<string, string> {
  const headers: Record<string, string> = { ...model.headers };
  if (!model.apiKey || model.authHeader === 'none') return headers;
  switch (model.authHeader) {
    case 'api-key':
      headers['api-key'] = model.apiKey;
      break;
    case 'x-api-key':
      headers['x-api-key'] = model.apiKey;
      break;
    case 'x-goog-api-key':
      headers['x-goog-api-key'] = model.apiKey;
      break;
    default:
      headers.Authorization = `Bearer ${model.apiKey}`;
  }
  return headers;
}

/** The provider's own error message from a JSON error body (OpenAI, Gemini, Anthropic and most others), else the raw text. */
export function errorText(body: string): string {
  try {
    const json = JSON.parse(body) as { error?: { message?: string } | string; errors?: { message?: string }[]; message?: string };
    const message = typeof json.error === 'string' ? json.error : (json.error?.message ?? json.errors?.[0]?.message ?? json.message);
    if (message) return message;
  } catch {
    // not JSON
  }
  return body.slice(0, 400);
}

async function send(url: string, init: RequestInit): Promise<Response> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new ProviderError(`${new URL(url).host} returned ${res.status}: ${errorText(body)}`, res.status, body);
  }
  return res;
}

/** Times the full round trip, including reading the body. */
export async function fetchJson<T = any>(url: string, init: RequestInit): Promise<{ json: T; latencyMs: number; headers: Headers }> {
  const started = performance.now();
  const res = await send(url, init);
  const json = (await res.json()) as T;
  return { json, latencyMs: performance.now() - started, headers: res.headers };
}

export async function fetchBytes(url: string, init: RequestInit): Promise<{ data: Buffer; mime: string; latencyMs: number }> {
  const started = performance.now();
  const res = await send(url, init);
  const data = Buffer.from(await res.arrayBuffer());
  return { data, mime: res.headers.get('content-type') ?? 'application/octet-stream', latencyMs: performance.now() - started };
}

export function requireBaseUrl(model: ModelConfig): string {
  if (!model.baseUrl) {
    throw new Error(`Model "${model.name}" has no base URL. Set AI_MODEL_${model.name.toUpperCase().replace(/-/g, '_')}_BASE_URL in ai.env.`);
  }
  return model.baseUrl.replace(/\/$/, '');
}

export function requireKey(model: ModelConfig, envHint: string): void {
  if (!model.apiKey) throw new Error(`Model "${model.name}" needs an API key. Set ${envHint} in ai.env.`);
}

export function dataUrl(media: MediaInput): string {
  return `data:${media.mime};base64,${media.data.toString('base64')}`;
}

/** Detects common image and audio formats from their first bytes. */
export function sniffMime(data: Buffer, fallback = 'application/octet-stream'): string {
  const hex = data.subarray(0, 12).toString('hex');
  const ascii = data.subarray(0, 12).toString('latin1');
  if (hex.startsWith('89504e47')) return 'image/png';
  if (hex.startsWith('ffd8ff')) return 'image/jpeg';
  if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP') return 'image/webp';
  if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WAVE') return 'audio/wav';
  if (ascii.startsWith('ID3') || hex.startsWith('fffb') || hex.startsWith('fff3') || hex.startsWith('fff2')) return 'audio/mpeg';
  if (ascii.startsWith('OggS')) return 'audio/ogg';
  if (hex.startsWith('1a45dfa3')) return 'audio/webm';
  if (ascii.startsWith('GIF8')) return 'image/gif';
  return fallback;
}
