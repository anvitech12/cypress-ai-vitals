import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { withCassette } from '../src/plugin/cassette';
import { makeRedactor, redactDeep, secretValues } from '../src/plugin/redact';
import { buildRegistry } from '../src/plugin/registry';
import { ResultStore } from '../src/plugin/store';

const env = {
  CLOUDFLARE_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
  CLOUDFLARE_API_TOKEN: 'cfat_secret_token_value_123456',
  GROQ_API_KEY: 'gsk_secret_groq_key_value',
  AI_MODEL_FAST: 'groq:openai/gpt-oss-20b',
  AI_MODEL_FLUX: 'cloudflare:@cf/black-forest-labs/flux-1-schnell',
  AI_MODE: 'live',
};

describe('redaction', () => {
  const registry = buildRegistry(env);
  const redact = makeRedactor(secretValues(env, registry.values()));

  it('finds secrets by name and from model keys, and leaves the rest alone', () => {
    const values = secretValues(env, registry.values());
    expect(values).toEqual(expect.arrayContaining([env.CLOUDFLARE_ACCOUNT_ID, env.CLOUDFLARE_API_TOKEN, env.GROQ_API_KEY]));
    expect(values).not.toContain('live');
    expect(redact(`POST https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/ai failed; token ${env.CLOUDFLARE_API_TOKEN}`)).toBe(
      'POST https://api.cloudflare.com/client/v4/accounts/[redacted]/ai failed; token [redacted]',
    );
  });

  it('keeps secrets out of results files and of the records reports are built from', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ai-results-'));
    const store = new ResultStore(dir, redact);
    store.add({ ts: 't', spec: 's.cy.ts', test: 't', command: 'aiGenerate', pass: false, checks: [], error: `failed for account ${env.CLOUDFLARE_ACCOUNT_ID}` } as never);
    const written = readFileSync(path.join(dir, 's.cy.ts.jsonl'), 'utf8');
    expect(written).not.toContain(env.CLOUDFLARE_ACCOUNT_ID);
    expect(written).toContain('[redacted]');
    expect(JSON.stringify(store.records)).not.toContain(env.CLOUDFLARE_ACCOUNT_ID);
  });

  it('keeps secrets out of recordings', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ai-cassettes-'));
    const fake = async () => ({ text: `echo ${env.GROQ_API_KEY}`, latencyMs: 1 });
    const record = withCassette(fake, { mode: 'record', dir, redact });
    await record(registry.get('fast')!, { task: 'text', prompt: 'hi' });
    const files = readdirSync(dir);
    const json = readFileSync(path.join(dir, files[0]), 'utf8');
    expect(json).not.toContain(env.GROQ_API_KEY);
    expect(json).toContain('[redacted]');
  });
});

describe('panel copy text', () => {
  it('summarizes the run as Markdown', async () => {
    const { panelSummaryMarkdown, resetPanel, track } = await import('../src/support/panel');
    resetPanel();
    track(undefined, { model: 'gpt-oss-120b', latencyMs: 885, usage: { inputTokens: 80, outputTokens: 45, totalTokens: 125 }, costUsd: 0.00006 } as never, 'gpt-oss-120b');
    track(true, undefined, 'gpt-oss-120b');
    const md = panelSummaryMarkdown();
    expect(md).toContain('- Calls: 1');
    expect(md).toContain('- Accuracy: 100% (1/1)');
    expect(md).toContain('| gpt-oss-120b | 1 | 100% | 885ms | 125 | $0.00006 |');
  });

  it('redacts every string inside a task result, at any depth', () => {
    const redact = makeRedactor(['0123456789abcdef0123456789abcdef']);
    const result = redactDeep(
      { models: [{ name: 'cf', baseUrl: 'https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/ai', calls: 2 }], ok: true, none: null },
      redact,
    );
    expect(JSON.stringify(result)).not.toContain('0123456789abcdef');
    expect(result.models[0].baseUrl).toContain('[redacted]');
    expect(result.models[0].calls).toBe(2);
    expect(result.none).toBeNull();
  });
});

