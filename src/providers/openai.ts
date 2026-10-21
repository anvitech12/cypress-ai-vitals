import { PRESETS, type ModelConfig } from '../plugin/registry';
import { authHeaders, dataUrl, fetchBytes, fetchJson, requireBaseUrl, requireKey, sniffMime, usage, type GenerateRequest, type GenerateResult, type Provider } from './types';

/** Presets whose servers expect max_completion_tokens (required by reasoning models). */
const COMPLETION_TOKEN_PRESETS = new Set(['openai', 'azure-openai', 'groq']);

interface ChatResponse {
  model?: string;
  choices: { message: { content: string | null }; finish_reason?: string }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    completion_tokens_details?: { reasoning_tokens?: number };
    /** Groq reports server timings in seconds. */
    total_time?: number;
  };
}

export function normalizeOpenAiUsage(u: ChatResponse['usage']) {
  if (!u) return undefined;
  // completion_tokens already includes reasoning tokens for OpenAI and Groq.
  return usage(u.prompt_tokens ?? 0, u.completion_tokens ?? 0, u.completion_tokens_details?.reasoning_tokens);
}

function chatBody(model: ModelConfig, req: GenerateRequest): Record<string, unknown> {
  const p = { ...model.params, ...req.params };
  const content = req.images?.length
    ? [{ type: 'text', text: req.prompt ?? '' }, ...req.images.map((img) => ({ type: 'image_url', image_url: { url: dataUrl(img) } }))]
    : (req.prompt ?? '');
  const body: Record<string, unknown> = {
    model: model.model,
    messages: [...(req.system ? [{ role: 'system', content: req.system }] : []), { role: 'user', content }],
  };
  if (p.temperature !== undefined) body.temperature = p.temperature;
  if (p.maxTokens !== undefined) body[COMPLETION_TOKEN_PRESETS.has(model.preset) ? 'max_completion_tokens' : 'max_tokens'] = p.maxTokens;
  if (p.reasoningEffort !== undefined) body.reasoning_effort = p.reasoningEffort;
  if (p.seed !== undefined) body.seed = p.seed;
  if (p.json) body.response_format = { type: 'json_object' };
  return body;
}

export const openAiProvider: Provider = {
  async generate(model, req): Promise<GenerateResult> {
    const base = requireBaseUrl(model);
    const preset = PRESETS[model.preset];
    if (preset && !preset.keyOptional) requireKey(model, preset.keyEnv?.[0] ?? `AI_MODEL_${model.name.toUpperCase().replace(/-/g, '_')}_API_KEY`);
    const headers = { ...authHeaders(model), 'content-type': 'application/json' };

    if (req.task === 'text') {
      const { json, latencyMs } = await fetchJson<ChatResponse>(`${base}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(chatBody(model, req)),
      });
      const choice = json.choices?.[0];
      return {
        text: choice?.message?.content ?? '',
        finishReason: choice?.finish_reason,
        usage: normalizeOpenAiUsage(json.usage),
        latencyMs,
        serverLatencyMs: json.usage?.total_time !== undefined ? json.usage.total_time * 1000 : undefined,
        servedModel: json.model,
      };
    }

    if (req.task === 'transcribe') {
      if (!req.audio) throw new Error('transcribe needs audio');
      const form = new FormData();
      form.append('model', model.model);
      form.append('response_format', 'json');
      form.append('file', new Blob([new Uint8Array(req.audio.data)], { type: req.audio.mime }), `audio.${req.audio.mime.split('/')[1] ?? 'wav'}`);
      const { json, latencyMs } = await fetchJson<{ text: string }>(`${base}/audio/transcriptions`, {
        method: 'POST',
        headers: authHeaders(model),
        body: form,
      });
      return { text: json.text?.trim() ?? '', latencyMs };
    }

    if (req.task === 'speech') {
      const p = { ...model.params, ...req.params };
      const { data, mime, latencyMs } = await fetchBytes(`${base}/audio/speech`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: model.model, input: req.prompt ?? '', voice: p.voice ?? 'alloy', response_format: 'wav' }),
      });
      return { media: { data, mime: mime.startsWith('audio/') ? mime : 'audio/wav' }, latencyMs };
    }

    const { json, latencyMs } = await fetchJson<{ data: { b64_json?: string; url?: string }[] }>(`${base}/images/generations`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: model.model, prompt: req.prompt ?? '', n: 1 }),
    });
    const first = json.data?.[0];
    if (first?.b64_json) {
      const data = Buffer.from(first.b64_json, 'base64');
      return { media: { data, mime: sniffMime(data, 'image/png') }, latencyMs };
    }
    if (first?.url) {
      const img = await fetchBytes(first.url, { method: 'GET' });
      return { media: { data: img.data, mime: img.mime }, latencyMs: latencyMs + img.latencyMs };
    }
    throw new Error(`Model "${model.name}" returned no image.`);
  },
};
