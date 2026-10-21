import { openAiProvider } from './openai';
import { authHeaders, requireBaseUrl, requireKey, sniffMime, usage, ProviderError, type GenerateResult, type Provider } from './types';

interface CloudflareEnvelope {
  success?: boolean;
  errors?: { message: string }[];
  result?: {
    response?: string;
    image?: string;
    audio?: string;
    text?: string;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
    /** Deepgram Nova answers in Deepgram's own shape. */
    results?: { channels?: { alternatives?: { transcript?: string }[] }[] };
  };
}

/** The readable part of a Cloudflare error body, without the account URL. */
function cloudflareMessage(body: string): string {
  try {
    const json = JSON.parse(body) as CloudflareEnvelope;
    const messages = json.errors?.map((e) => e.message.replace(/^(AiError:\s*)+/, '')).filter(Boolean);
    if (messages?.length) return messages.join('; ');
  } catch {
    // not JSON
  }
  return body.slice(0, 300);
}

export const cloudflareProvider: Provider = {
  async generate(model, req): Promise<GenerateResult> {
    requireKey(model, 'CLOUDFLARE_API_TOKEN');
    const base = requireBaseUrl(model);
    // Chat goes through Cloudflare's OpenAI-compatible endpoint: standard usage, finish reason and reasoning effort.
    if (req.task === 'text') return openAiProvider.generate({ ...model, baseUrl: `${base}/v1` }, req);
    const url = `${base}/run/${model.model}`;
    const p = { ...model.params, ...req.params };
    const nova = /deepgram\/nova/i.test(model.model);

    let body: BodyInit;
    let contentType = 'application/json';
    if (req.task === 'image') {
      body = JSON.stringify({ prompt: req.prompt ?? '', ...(p.steps !== undefined ? { steps: p.steps } : {}), ...(p.seed !== undefined ? { seed: p.seed } : {}) });
    } else if (req.task === 'transcribe') {
      if (!req.audio) throw new Error('transcribe needs audio');
      if (nova) {
        // Nova takes the raw audio bytes, typed by the content-type header.
        body = new Uint8Array(req.audio.data);
        contentType = req.audio.mime;
      } else {
        body = JSON.stringify({ audio: req.audio.data.toString('base64') });
      }
    } else if (req.task === 'speech') {
      // MeloTTS takes { prompt, lang }; Deepgram Aura and most others take { text }.
      body = JSON.stringify(/melotts/i.test(model.model) ? { prompt: req.prompt ?? '', lang: p.lang ?? 'en' } : { text: req.prompt ?? '', ...(p.voice ? { speaker: p.voice } : {}) });
    } else {
      throw new Error(`Cloudflare adapter does not support task "${req.task}".`);
    }

    // AI_MODEL_<NAME>_BODY adds model-specific fields, e.g. {"encoding":"linear16","container":"wav"} for Aura-2.
    if (model.http?.body && typeof body === 'string') body = JSON.stringify({ ...JSON.parse(body), ...JSON.parse(model.http.body) });

    const started = performance.now();
    const send = () => fetch(url, { method: 'POST', headers: { ...authHeaders(model), 'content-type': contentType }, body });
    let res = await send();
    if (!res.ok) {
      let text = await res.text();
      // The image safety filter sometimes flags a harmless prompt (code 8007); the same prompt usually passes on a second try.
      if (req.task === 'image' && res.status === 400 && /"code":\s*8007/.test(text)) {
        res = await send();
        if (!res.ok) text = await res.text();
      }
      if (!res.ok) throw new ProviderError(`Cloudflare ${res.status} for ${model.model}: ${cloudflareMessage(text)}`, res.status, text);
    }
    const mime = res.headers.get('content-type') ?? '';

    // Some image and speech models answer with raw bytes instead of a JSON envelope.
    if (!mime.includes('application/json')) {
      const data = Buffer.from(await res.arrayBuffer());
      return { media: { data, mime: sniffMime(data, mime || 'application/octet-stream') }, latencyMs: performance.now() - started };
    }
    const json = (await res.json()) as CloudflareEnvelope;
    const latencyMs = performance.now() - started;
    if (json.success === false) throw new ProviderError(`Cloudflare error: ${json.errors?.map((e) => e.message).join('; ')}`);
    const r = json.result ?? {};
    if (req.task === 'image') {
      if (!r.image) throw new Error(`Model "${model.name}" returned no image.`);
      const data = Buffer.from(r.image, 'base64');
      return { media: { data, mime: sniffMime(data, 'image/jpeg') }, latencyMs };
    }
    if (req.task === 'speech') {
      if (!r.audio) throw new Error(`Model "${model.name}" returned no audio.`);
      const data = Buffer.from(r.audio, 'base64');
      return { media: { data, mime: sniffMime(data, 'audio/mpeg') }, latencyMs };
    }
    return {
      text: (r.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? r.response ?? r.text ?? '').trim(),
      usage: r.usage ? usage(r.usage.prompt_tokens ?? 0, r.usage.completion_tokens ?? 0) : undefined,
      latencyMs,
    };
  },
};
