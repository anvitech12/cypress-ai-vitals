import { describe, expect, it } from 'vitest';
import { buildRegistry } from '../src/plugin/registry';
import { firstFile, gradioInputs, parseGradioEvents } from '../src/providers/gradio';
import { withRetry } from '../src/providers/retry';
import { ProviderError } from '../src/providers/types';

describe('gradio provider', () => {
  const flux = [
    { parameter_name: 'prompt', parameter_has_default: false, type: { type: 'string' } },
    { parameter_name: 'seed', parameter_has_default: true, parameter_default: 0, type: { type: 'number' } },
    { parameter_name: 'randomize_seed', parameter_has_default: true, parameter_default: true, type: { type: 'boolean' } },
    { parameter_name: 'width', parameter_has_default: true, parameter_default: 1024, type: { type: 'number' } },
  ];

  it('puts the prompt in the prompt input and keeps the Space defaults', () => {
    expect(gradioInputs(flux, 'a fox')).toEqual(['a fox', 0, true, 1024]);
  });

  it('applies overrides by input name and fills empty inputs by type', () => {
    const sd = [flux[0], { parameter_name: 'negative_prompt', parameter_has_default: false, type: { type: 'string' } }, flux[3]];
    expect(gradioInputs(sd, 'a fox', { width: 768 })).toEqual(['a fox', '', 768]);
    expect(gradioInputs([{ parameter_name: 'description', type: { type: 'string' } }], 'a fox')).toEqual(['a fox']);
  });

  it('reads the final event of a Gradio stream', () => {
    const ok = 'event: heartbeat\ndata: null\n\nevent: complete\ndata: [{"url": "https://x.hf.space/file=a.webp", "path": "/tmp/a.webp"}, 42]\n\n';
    expect(parseGradioEvents(ok)).toEqual({ event: 'complete', data: [{ url: 'https://x.hf.space/file=a.webp', path: '/tmp/a.webp' }, 42] });
    const quota = 'event: error\ndata: {"error": "You have exceeded your ZeroGPU quota", "title": "ZeroGPU quota exceeded"}\n\n';
    expect(parseGradioEvents(quota).event).toBe('error');
  });

  it('explains a Space error that has no details', async () => {
    const { gradioProvider } = await import('../src/providers/gradio');
    const space = buildRegistry({ AI_MODEL_S: 'gradio:demo', AI_MODEL_S_BASE_URL: 'http://space.test', AI_MODEL_S_KIND: 'image' }).get('s')!;
    const replies: Record<string, string> = {
      'http://space.test/gradio_api/info': JSON.stringify({ named_endpoints: { '/infer': { parameters: [{ parameter_name: 'prompt', type: { type: 'string' } }] } } }),
      'http://space.test/gradio_api/call/infer': JSON.stringify({ event_id: 'e1' }),
      'http://space.test/gradio_api/call/infer/e1': 'event: error\ndata: null\n\n',
    };
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string) => new Response(replies[url], { status: 200 })) as typeof fetch;
    try {
      await expect(gradioProvider.generate(space, { task: 'image', prompt: 'a fox' })).rejects.toMatchObject({ status: 429, message: expect.stringMatching(/ZeroGPU quota.*HF_TOKEN/) });
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('finds the first file in images and galleries', () => {
    const gallery = [[{ image: { path: '/tmp/b.png', url: 'https://x.hf.space/file=b.png', meta: { _type: 'gradio.FileData' } }, caption: null }], 'seed'];
    expect(firstFile(gallery)).toEqual({ url: 'https://x.hf.space/file=b.png' });
    expect(firstFile(['just text', 3])).toBeUndefined();
  });

  it('registers hf-space models with an optional token', () => {
    const r = buildRegistry({
      AI_MODEL_FLUX_SPACE: 'hf-space:black-forest-labs/FLUX.1-schnell',
      AI_MODEL_FLUX_SPACE_ENDPOINT: '/infer',
      AI_MODEL_FLUX_SPACE_BODY: '{"width":768}',
    });
    expect(r.get('flux-space')).toMatchObject({ kind: 'gradio', modality: 'image', apiKey: undefined, http: { endpoint: '/infer', body: '{"width":768}' } });
  });
});

describe('withRetry', () => {
  it('retries a short rate limit', async () => {
    let calls = 0;
    const result = await withRetry(async () => {
      if (++calls === 1) throw new ProviderError('slow down', 429, '{"retry_after": 0.01}');
      return 'ok';
    });
    expect([result, calls]).toEqual(['ok', 2]);
  });

  it('fails fast when a daily allowance is spent', async () => {
    let calls = 0;
    const spent = withRetry(async () => {
      calls++;
      throw new ProviderError('Space "x": ZeroGPU quota exceeded: You have exceeded your ZeroGPU quota', 429);
    });
    await expect(spent).rejects.toThrow(/ZeroGPU quota/);
    expect(calls).toBe(1);
  });
});

describe('missing keys', () => {
  it('names the variable to set before calling a keyed provider', async () => {
    const { generate } = await import('../src/providers');
    const chatgpt = buildRegistry({ AI_MODEL_CHATGPT: 'openai:gpt-6-luna' }).get('chatgpt')!;
    await expect(generate(chatgpt, { task: 'text', prompt: 'hi' })).rejects.toThrow(/needs an API key\. Set OPENAI_API_KEY/);
  });
});

describe('provider error text', () => {
  it('keeps the provider message and drops the JSON around it', async () => {
    const { errorText } = await import('../src/providers/types');
    expect(errorText('{"error":{"code":503,"message":"This model is currently experiencing high demand."}}')).toBe('This model is currently experiencing high demand.');
    expect(errorText('{"errors":[{"message":"Invalid API key"}]}')).toBe('Invalid API key');
    expect(errorText('<html>Bad gateway</html>')).toBe('<html>Bad gateway</html>');
  });
});

describe('withRetry and provider hints', () => {
  it('waits out a per-minute limit even when the body also names a per-day quota', async () => {
    let calls = 0;
    const body = '{"error":{"code":429,"details":[{"violations":[{"quotaId":"GenerateRequestsPerMinutePerProjectPerModel-FreeTier"},{"quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier"}]},{"retryDelay":"0.01s"}]}}';
    const result = await withRetry(async () => {
      if (++calls === 1) throw new ProviderError('generativelanguage.googleapis.com returned 429: You exceeded your current quota', 429, body);
      return 'ok';
    });
    expect([result, calls]).toEqual(['ok', 2]);
  });

  it('fails at once when the provider asks for a long wait', async () => {
    let calls = 0;
    const slow = withRetry(async () => {
      calls++;
      throw new ProviderError('429', 429, '{"retryDelay":"3600s"}');
    });
    await expect(slow).rejects.toThrow('429 (the provider asks to wait 60 min)');
    expect(calls).toBe(1);
  });
});

describe('cloudflare provider', () => {
  const env = { CLOUDFLARE_ACCOUNT_ID: 'acc', CLOUDFLARE_API_TOKEN: 'cf_test' };
  async function capture(modelLine: string, request: object, reply: object) {
    const { cloudflareProvider } = await import('../src/providers/cloudflare');
    const model = buildRegistry({ ...env, AI_MODEL_M: modelLine }).get('m')!;
    const calls: { url: string; init: RequestInit }[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    try {
      return { result: await cloudflareProvider.generate(model, request as never), calls };
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  it('sends chat through the OpenAI-compatible endpoint, with usage', async () => {
    const { result, calls } = await capture('cloudflare:@cf/openai/gpt-oss-20b', { task: 'text', prompt: 'hi', params: { reasoningEffort: 'low' } }, {
      choices: [{ message: { content: 'Canberra' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 80, completion_tokens: 67 },
    });
    expect(calls[0].url).toBe('https://api.cloudflare.com/client/v4/accounts/acc/ai/v1/chat/completions');
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({ model: '@cf/openai/gpt-oss-20b', reasoning_effort: 'low' });
    expect(result).toMatchObject({ text: 'Canberra', usage: { inputTokens: 80, outputTokens: 67 } });
  });

  it('sends Nova raw audio and reads its transcript', async () => {
    const audio = { mime: 'audio/wav', data: Buffer.from('RIFF....WAVE') };
    const { result, calls } = await capture('cloudflare:@cf/deepgram/nova-3', { task: 'transcribe', audio }, {
      success: true,
      result: { results: { channels: [{ alternatives: [{ transcript: 'thank you for testing with cypress' }] }] } },
    });
    expect((calls[0].init.headers as Record<string, string>)['content-type']).toBe('audio/wav');
    expect(result.text).toBe('thank you for testing with cypress');
  });

  it('reads tags from ai.env', () => {
    const r = buildRegistry({ AI_MODEL_FAST: 'groq:openai/gpt-oss-20b', AI_MODEL_FAST_TAGS: 'Free, beta' });
    expect(r.get('fast')!.tags).toEqual(['free', 'beta']);
  });
});
