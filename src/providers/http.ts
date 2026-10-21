import { authHeaders, fetchJson, usage, type GenerateResult, type Provider } from './types';

export function readPath(value: unknown, dotted: string | undefined): unknown {
  if (!dotted) return undefined;
  return dotted.split('.').reduce<unknown>((acc, key) => {
    if (acc === null || acc === undefined) return undefined;
    const index = /^\d+$/.test(key) ? Number(key) : key;
    return (acc as Record<string | number, unknown>)[index];
  }, value);
}

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => JSON.stringify(values[key] ?? '').slice(1, -1));
}

/**
 * Catch-all for any JSON-over-HTTP model:
 *   AI_MODEL_MINE=http:my-model
 *   AI_MODEL_MINE_URL=https://example.com/generate
 *   AI_MODEL_MINE_BODY={"model":"{{model}}","input":"{{prompt}}"}
 *   AI_MODEL_MINE_TEXT_PATH=output.0.text
 */
export const httpProvider: Provider = {
  async generate(model, req): Promise<GenerateResult> {
    if (req.task !== 'text') throw new Error('The http provider supports text only.');
    const cfg = model.http ?? {};
    const url = cfg.url ?? model.baseUrl;
    if (!url) throw new Error(`Model "${model.name}" needs AI_MODEL_<NAME>_URL.`);
    const values = { prompt: req.prompt ?? '', system: req.system ?? '', model: model.model };
    const body = fill(cfg.body ?? '{"model":"{{model}}","prompt":"{{prompt}}"}', values);
    const { json, latencyMs } = await fetchJson(fill(url, values), {
      method: 'POST',
      headers: { ...authHeaders(model), 'content-type': 'application/json' },
      body,
    });
    const text = readPath(json, cfg.textPath ?? 'text');
    const input = Number(readPath(json, cfg.inputTokensPath));
    const output = Number(readPath(json, cfg.outputTokensPath));
    return {
      text: typeof text === 'string' ? text : JSON.stringify(text ?? ''),
      usage: Number.isFinite(input) && Number.isFinite(output) ? usage(input, output) : undefined,
      latencyMs,
    };
  },
};
