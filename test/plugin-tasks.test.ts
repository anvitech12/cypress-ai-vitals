import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { aiVitalsPlugin } from '../src/plugin/index';
import { loadMedia } from '../src/plugin/media';
import { buildRegistry } from '../src/plugin/registry';
import { summarizeModel } from '../src/plugin/summary';
import { defineProvider, generate } from '../src/providers/index';

const ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
// A 1x1 transparent PNG.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

type Task = (arg: any) => Promise<any>;
const tasks: Record<string, Task> = {};
let returned: { expose?: Record<string, unknown> } = {};

beforeAll(() => {
  const root = mkdtempSync(path.join(tmpdir(), 'ai-vitals-tasks-'));
  mkdirSync(path.join(root, 'cypress/fixtures'), { recursive: true });
  writeFileSync(path.join(root, 'test.env'), `AI_MODEL_CF=cloudflare:@cf/meta/llama-4-scout\nCLOUDFLARE_ACCOUNT_ID=${ACCOUNT_ID}\nCLOUDFLARE_API_TOKEN=cfat_fake_token_value_123456\n`);
  const on = (event: string, handlers: Record<string, Task>) => {
    if (event === 'task') Object.assign(tasks, handlers);
  };
  writeFileSync(path.join(root, 'cypress/fixtures/bad.jsonl'), '{"input": "q", "answer": 1}\n{"input": "q2", "answer"\n');
  returned = aiVitalsPlugin(on as never, { projectRoot: root, fixturesFolder: path.join(root, 'cypress/fixtures') } as never, {
    envFile: 'test.env',
    terminalSummary: false,
    specReports: false,
    offline: true,
  }) as never;
});

const meta = (extra: Record<string, unknown> = {}) => ({ command: 'aiAssert', spec: 'cypress/e2e/a.cy.ts', test: 'a test', ...extra });

describe('plugin tasks', () => {
  it('never sends the Cloudflare account id to the browser', async () => {
    const models = await tasks['aiVitals:models'](undefined);
    expect(JSON.stringify(models)).not.toContain(ACCOUNT_ID);
    expect(models[0].key).toBe('set (28 chars)');
  });

  it('counts only scored results from the current run in a pass rate', async () => {
    const check = (output: string, run: string) => tasks['aiVitals:scoreText']({ output, spec: { mustMention: ['Washington'] }, meta: meta({ label: 'cap', soft: true, run }) });
    for (const answer of ['Washington, D.C.', 'Washington', 'Washington DC']) await check(answer, 'run-1');
    for (const answer of ['New York', 'New York', 'Washington, D.C.']) await check(answer, 'run-2');
    expect(await tasks['aiVitals:passRate']({ label: 'cap', run: 'run-1' })).toEqual({ n: 3, passRate: 1 });
    expect(await tasks['aiVitals:passRate']({ label: 'cap', run: 'run-2' })).toEqual({ n: 3, passRate: 1 / 3 });
  });

  it('fails an assertion that ran no check, even with shouldFail', async () => {
    const typo = await tasks['aiVitals:scoreText']({ output: 'anything', spec: { mustMentions: ['x'] }, meta: meta() });
    expect(typo.pass).toBe(false);
    expect(typo.checks[0].detail).toContain('mustMentions');
    const inverted = await tasks['aiVitals:scoreText']({ output: 'anything', spec: { mustMentions: ['x'] }, meta: meta({ shouldFail: true }) });
    expect(inverted.pass).toBe(false);
  });

  it('explains that notDepicts needs depicts', async () => {
    const result = await tasks['aiVitals:scoreImage']({ src: PNG, spec: { notDepicts: ['a red square'] }, meta: meta({ command: 'aiImageAssert' }) });
    expect(result.pass).toBe(false);
    expect(result.checks[0].detail).toContain('needs depicts');
  });

  it('rejects a comparison with no models or an unsupported scorer', async () => {
    await expect(tasks['aiVitals:compare']({ spec: { models: [], cases: [{ input: 'q', answer: 1 }] }, meta: meta() })).rejects.toThrow('at least one model');
    await expect(tasks['aiVitals:compare']({ spec: { models: ['cf'], cases: [{ input: 'q', answer: 1 }], scorers: ['maxWer'] }, meta: meta() })).rejects.toThrow('maxWer');
  });
});

describe('plugin wiring', () => {
  it('leaves its version in the config, so the support file can tell when the plugin is missing', () => {
    expect(returned.expose?.aiVitalsPlugin).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('gives the panel a report link in cypress open, and the file path either way', async () => {
    expect(await tasks['aiVitals:reportLink']({ spec: 'cypress/e2e/a.cy.ts' })).toEqual({ url: null, path: null });
    // A second plugin with spec reports on, as most projects run it.
    const root = mkdtempSync(path.join(tmpdir(), 'ai-vitals-link-'));
    const withReports: Record<string, Task> = {};
    const on = (event: string, handlers: Record<string, Task>) => {
      if (event === 'task') Object.assign(withReports, handlers);
    };
    aiVitalsPlugin(on as never, { projectRoot: root, fixturesFolder: path.join(root, 'cypress/fixtures'), experimentalInteractiveRunEvents: true } as never, { envFile: 'none.env', terminalSummary: false, offline: true });
    const link = await withReports['aiVitals:reportLink']({ spec: 'cypress/e2e/a.cy.ts' });
    expect(link.path).toBe(path.join('cypress', 'ai-vitals', 'reports', 'a.cy.ts', 'latest.html'));
    expect(link.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/open\?spec=a\.cy\.ts&since=\d+$/);
  });

  it('names the file and line of a broken dataset row', async () => {
    await expect(tasks['aiVitals:compare']({ spec: { models: ['cf'], dataset: 'bad.jsonl' }, meta: meta() })).rejects.toThrow(/bad\.jsonl, line 2/);
  });
});

describe('defineProvider', () => {
  it('lets ai.env name a model on a provider registered in code', async () => {
    defineProvider('my-gateway', { generate: async () => ({ text: 'hello from my gateway', latencyMs: 1 }) });
    const model = buildRegistry({ AI_MODEL_X: 'my-gateway:some-model' }).get('x')!;
    expect(model.preset).toBe('my-gateway');
    expect((await generate(model, { task: 'text', prompt: 'hi' })).text).toBe('hello from my gateway');
  });
});

describe('loadMedia', () => {
  it('accepts data URLs with parameters, as MediaRecorder produces', async () => {
    const media = await loadMedia('data:audio/webm;codecs=opus;base64,AAEC', '/');
    expect(media.mime).toBe('audio/webm');
    expect([...media.data]).toEqual([0, 1, 2]);
  });
});

describe('gates', () => {
  it('fails an accuracy gate when nothing was scored', () => {
    const summary = summarizeModel('m', [], { accuracy: 0.8 });
    expect(summary.gatesPassed).toBe(false);
    expect(summary.gateFailures[0]).toContain('nothing scored');
  });
});
