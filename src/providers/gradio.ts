import type { ModelConfig } from '../plugin/registry';
import { authHeaders, fetchBytes, fetchJson, ProviderError, sniffMime, type GenerateResult, type Provider } from './types';

interface GradioParameter {
  parameter_name?: string;
  parameter_has_default?: boolean;
  parameter_default?: unknown;
  type?: { type?: string };
}

interface GradioInfo {
  named_endpoints?: Record<string, { parameters: GradioParameter[] }>;
}

const PROMPT_NAMES = /^(prompt|text|input|message|query|caption)$/i;
const QUOTA = /quota|exceeded your|too many requests/i;
const hosts = new Map<string, Promise<string>>();
const infos = new Map<string, Promise<GradioInfo>>();

/** The Space's own URL, e.g. black-forest-labs/FLUX.1-schnell -> https://black-forest-labs-flux-1-schnell.hf.space. */
function hostFor(model: ModelConfig): Promise<string> {
  if (model.baseUrl) return Promise.resolve(model.baseUrl.replace(/\/$/, ''));
  if (!hosts.has(model.model)) {
    const lookup = fetchJson<{ host?: string; runtime?: { stage?: string } }>(`https://huggingface.co/api/spaces/${model.model}`, {
      method: 'GET',
      headers: authHeaders(model),
    }).then(({ json }) => {
      if (!json.host) throw new ProviderError(`Space "${model.model}" has no public URL (stage: ${json.runtime?.stage ?? 'unknown'}).`, 503);
      return json.host;
    });
    lookup.catch(() => hosts.delete(model.model));
    hosts.set(model.model, lookup);
  }
  return hosts.get(model.model)!;
}

function infoFor(model: ModelConfig, host: string): Promise<GradioInfo> {
  if (!infos.has(host)) {
    const lookup = fetchJson<GradioInfo>(`${host}/gradio_api/info`, { method: 'GET', headers: authHeaders(model) }).then(({ json }) => json);
    lookup.catch(() => infos.delete(host));
    infos.set(host, lookup);
  }
  return infos.get(host)!;
}

function emptyFor(parameter: GradioParameter): unknown {
  switch (parameter.type?.type) {
    case 'string':
      return '';
    case 'number':
    case 'integer':
      return 0;
    case 'boolean':
      return false;
    default:
      return null;
  }
}

function fillPrompt(value: unknown, prompt: string): unknown {
  return typeof value === 'string' ? value.replace(/\{\{prompt\}\}/g, prompt) : value;
}

/**
 * Builds the endpoint's input list: the prompt goes into the input named "prompt" (or the first text input),
 * overrides from AI_MODEL_<NAME>_BODY are applied by input name, and everything else keeps the Space's default.
 */
export function gradioInputs(parameters: GradioParameter[], prompt: string, overrides: Record<string, unknown> = {}): unknown[] {
  let promptIndex = parameters.findIndex((p) => PROMPT_NAMES.test(p.parameter_name ?? ''));
  if (promptIndex < 0) promptIndex = parameters.findIndex((p) => p.type?.type === 'string');
  return parameters.map((p, i) => {
    const name = p.parameter_name ?? '';
    if (name in overrides) return fillPrompt(overrides[name], prompt);
    if (i === promptIndex) return prompt;
    return p.parameter_has_default ? p.parameter_default : emptyFor(p);
  });
}

/** Reads a Gradio server-sent event stream and returns the payload of its final event. */
export function parseGradioEvents(stream: string): { event: string; data: unknown } {
  let last = { event: 'missing', data: null as unknown };
  for (const block of stream.split(/\n\n+/)) {
    const event = /^event:\s*(.+)$/m.exec(block)?.[1]?.trim();
    const raw = /^data:\s*(.*)$/m.exec(block)?.[1];
    if (!event || event === 'heartbeat') continue;
    let data: unknown = raw;
    try {
      data = raw === undefined ? null : JSON.parse(raw);
    } catch {
      // keep the raw text
    }
    last = { event, data };
  }
  return last;
}

/** Finds the first file in a Gradio output: an Image, Audio, File or the first picture of a Gallery. */
export function firstFile(value: unknown): { url: string } | undefined {
  if (!value || typeof value !== 'object') return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstFile(item);
      if (found) return found;
    }
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.url === 'string' && (record.path !== undefined || (record.meta as { _type?: string })?._type === 'gradio.FileData')) {
    return { url: record.url };
  }
  for (const nested of Object.values(record)) {
    const found = firstFile(nested);
    if (found) return found;
  }
  return undefined;
}

function firstText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstText(item);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function errorMessage(data: unknown, hasToken: boolean): string {
  if (data && typeof data === 'object') {
    const { error, title } = data as { error?: string; title?: string };
    if (error) return title ? `${title}: ${error}` : error;
  }
  // Many Spaces hide error details. Without a token, a spent ZeroGPU quota is by far the most common cause.
  return hasToken
    ? 'The Space failed without saying why. It may be out of your daily GPU time, restarting, or busy.'
    : 'The Space failed without saying why, most likely because the ZeroGPU quota for your network (2 minutes a day without a token) is used up. Add a free HF_TOKEN to ai.env.';
}

/**
 * Any Gradio app, most usefully the free demos on Hugging Face Spaces:
 *   AI_MODEL_FLUX_SPACE=hf-space:black-forest-labs/FLUX.1-schnell
 *   AI_MODEL_FLUX_SPACE_ENDPOINT=/infer              optional, defaults to the Space's first API endpoint
 *   AI_MODEL_FLUX_SPACE_BODY={"width":768}           optional, overrides inputs by name
 * A self-hosted Gradio app works too: AI_MODEL_MINE=gradio:my-app with AI_MODEL_MINE_BASE_URL=http://localhost:7860.
 * HF_TOKEN is optional. With it, ZeroGPU Spaces count usage against your account's daily quota instead of your IP's.
 */
export const gradioProvider: Provider = {
  async generate(model, req): Promise<GenerateResult> {
    if (req.task === 'transcribe') throw new Error(`Model "${model.name}": Gradio Spaces are supported for text, image and speech output, not transcription.`);
    const started = performance.now();
    const host = await hostFor(model);
    const info = await infoFor(model, host);
    const endpoints = info.named_endpoints ?? {};
    const endpoint = model.http?.endpoint ?? Object.keys(endpoints)[0];
    if (!endpoint || !endpoints[endpoint]) {
      throw new Error(`Space "${model.model}" has no API endpoint "${endpoint ?? ''}". Its endpoints: ${Object.keys(endpoints).join(', ') || 'none'}.`);
    }
    const overrides = model.http?.body ? (JSON.parse(model.http.body) as Record<string, unknown>) : {};
    const data = gradioInputs(endpoints[endpoint].parameters, req.prompt ?? '', overrides);
    const path = `${host}/gradio_api/call/${endpoint.replace(/^\//, '')}`;
    const headers = authHeaders(model);

    const { json } = await fetchJson<{ event_id?: string }>(path, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ data }),
    });
    if (!json.event_id) throw new ProviderError(`Space "${model.model}" did not queue the request.`, 502);
    const res = await fetch(`${path}/${json.event_id}`, { headers, signal: AbortSignal.timeout(300_000) });
    const stream = await res.text();
    if (!res.ok) throw new ProviderError(`Space "${model.model}" failed with ${res.status}: ${stream.slice(0, 300)}`, res.status, stream);
    const final = parseGradioEvents(stream);
    if (final.event !== 'complete') {
      const message = errorMessage(final.data, Boolean(model.apiKey));
      throw new ProviderError(`Space "${model.model}": ${message}`, QUOTA.test(message) ? 429 : 502, stream.slice(-600));
    }
    const serverLatencyMs = performance.now() - started;

    if (req.task === 'text') {
      return { text: firstText(final.data) ?? '', latencyMs: performance.now() - started, serverLatencyMs, servedModel: model.model };
    }
    const file = firstFile(final.data);
    if (!file) throw new ProviderError(`Space "${model.model}" finished without returning a file.`, 502, stream.slice(-600));
    const download = await fetchBytes(file.url, { method: 'GET', headers });
    return {
      media: { data: download.data, mime: sniffMime(download.data, download.mime) },
      latencyMs: performance.now() - started,
      serverLatencyMs,
      servedModel: model.model,
    };
  },
};
