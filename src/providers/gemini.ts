import { pcm16ToWav } from '../plugin/media';
import { authHeaders, fetchJson, requireBaseUrl, requireKey, usage, type GenerateRequest, type GenerateResult, type Provider } from './types';
import type { ModelConfig } from '../plugin/registry';

interface GeminiPart {
  text?: string;
  thought?: boolean;
  inlineData?: { mimeType: string; data: string };
}

interface GeminiResponse {
  modelVersion?: string;
  candidates?: { content?: { parts?: GeminiPart[] }; finishReason?: string }[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    totalTokenCount?: number;
  };
}

export function normalizeGeminiUsage(u: GeminiResponse['usageMetadata']) {
  if (!u) return undefined;
  // Unlike OpenAI, Gemini reports thinking tokens separately from candidate tokens.
  const thoughts = u.thoughtsTokenCount ?? 0;
  return usage(u.promptTokenCount ?? 0, (u.candidatesTokenCount ?? 0) + thoughts, thoughts);
}

function generationConfig(model: ModelConfig, req: GenerateRequest): Record<string, unknown> {
  const p = { ...model.params, ...req.params };
  const config: Record<string, unknown> = {};
  if (p.temperature !== undefined) config.temperature = p.temperature;
  if (p.maxTokens !== undefined) config.maxOutputTokens = p.maxTokens;
  if (p.seed !== undefined) config.seed = p.seed;
  if (p.json) config.responseMimeType = 'application/json';
  const thinking: Record<string, unknown> = {};
  if (p.thinkingBudget !== undefined) thinking.thinkingBudget = p.thinkingBudget;
  if (p.reasoningEffort !== undefined) thinking.thinkingLevel = p.reasoningEffort;
  if (Object.keys(thinking).length) config.thinkingConfig = thinking;
  if (req.task === 'speech') {
    config.responseModalities = ['AUDIO'];
    config.speechConfig = { voiceConfig: { prebuiltVoiceConfig: { voiceName: p.voice ?? 'Kore' } } };
  }
  if (req.task === 'image') config.responseModalities = ['TEXT', 'IMAGE'];
  return config;
}

function parts(req: GenerateRequest): GeminiPart[] {
  const prompt =
    req.task === 'transcribe' ? (req.prompt ?? 'Transcribe this audio verbatim. Reply with the transcript only.') : (req.prompt ?? '');
  const out: GeminiPart[] = [{ text: prompt }];
  for (const img of req.images ?? []) out.push({ inlineData: { mimeType: img.mime, data: img.data.toString('base64') } });
  if (req.audio) out.push({ inlineData: { mimeType: req.audio.mime, data: req.audio.data.toString('base64') } });
  return out;
}

export const geminiProvider: Provider = {
  async generate(model, req): Promise<GenerateResult> {
    requireKey(model, 'GEMINI_API_KEY');
    const base = requireBaseUrl(model);
    const body: Record<string, unknown> = {
      contents: [{ role: 'user', parts: parts(req) }],
      generationConfig: generationConfig(model, req),
    };
    if (req.system) body.systemInstruction = { parts: [{ text: req.system }] };

    const { json, latencyMs } = await fetchJson<GeminiResponse>(`${base}/models/${encodeURIComponent(model.model)}:generateContent`, {
      method: 'POST',
      headers: { ...authHeaders(model), 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const candidate = json.candidates?.[0];
    const answerParts = (candidate?.content?.parts ?? []).filter((p) => !p.thought);
    const result: GenerateResult = {
      text: answerParts.map((p) => p.text ?? '').join('').trim(),
      finishReason: candidate?.finishReason,
      usage: normalizeGeminiUsage(json.usageMetadata),
      latencyMs,
      servedModel: json.modelVersion,
    };
    const inline = answerParts.find((p) => p.inlineData)?.inlineData;
    if (inline) {
      const data = Buffer.from(inline.data, 'base64');
      // TTS returns raw 16-bit PCM, e.g. "audio/L16;codec=pcm;rate=24000".
      const rate = /rate=(\d+)/.exec(inline.mimeType)?.[1];
      result.media = inline.mimeType.startsWith('audio/L16')
        ? { data: pcm16ToWav(data, Number(rate ?? 24000)), mime: 'audio/wav' }
        : { data, mime: inline.mimeType };
    }
    return result;
  },
};
