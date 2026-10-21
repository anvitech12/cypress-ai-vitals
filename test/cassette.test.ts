import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildRegistry } from '../src/plugin/registry';
import { CassetteMissError, withCassette } from '../src/plugin/cassette';
import type { GenerateRequest, GenerateResult } from '../src/providers/types';

const model = buildRegistry({ AI_MODEL_FAST: 'groq:openai/gpt-oss-20b', GROQ_API_KEY: 'x' }).get('fast')!;
const ask: GenerateRequest = { task: 'text', prompt: 'What is the capital of Australia?' };

function fakeProvider(answers: string[]) {
  let i = 0;
  return async (): Promise<GenerateResult> => ({ text: answers[i++ % answers.length], latencyMs: 100 + i, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } });
}

describe('cassettes', () => {
  it('records several answers to the same prompt and replays them in order', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cassette-'));
    const answers = ['Canberra.', 'It is Canberra.', "Australia's capital is Canberra."];
    const record = withCassette(fakeProvider(answers), { mode: 'record', dir });
    for (let i = 0; i < 3; i++) await record(model, ask, { scope: 'spec01' });

    const replay = withCassette(async () => {
      throw new Error('network must not be used in replay');
    }, { mode: 'replay', dir });
    const replayed = [];
    for (let i = 0; i < 3; i++) replayed.push(await replay(model, ask, { scope: 'spec01' }));
    expect(replayed.map((r) => r.text)).toEqual(answers);
    expect(replayed.every((r) => r.cassette === 'hit')).toBe(true);
    expect(replayed[0].latencyMs).toBe(101);
  });

  it('re-recording replaces old answers instead of appending forever', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cassette-'));
    await withCassette(fakeProvider(['old']), { mode: 'record', dir })(model, ask);
    await withCassette(fakeProvider(['new']), { mode: 'record', dir })(model, ask);
    const replay = withCassette(fakeProvider([]), { mode: 'replay', dir });
    expect((await replay(model, ask)).text).toBe('new');
    expect(readdirSync(dir)).toHaveLength(1);
  });

  it('stores media as files next to the cassette', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cassette-'));
    const png = Buffer.from([137, 80, 78, 71]);
    await withCassette(async () => ({ media: { data: png, mime: 'image/png' }, latencyMs: 5 }), { mode: 'record', dir })(model, { task: 'image', prompt: 'fox' });
    const hit = await withCassette(fakeProvider([]), { mode: 'replay', dir })(model, { task: 'image', prompt: 'fox' });
    expect(hit.media?.data.equals(png)).toBe(true);
    expect(readdirSync(dir).some((f) => f.endsWith('.png'))).toBe(true);
  });

  it('fails loudly on a miss in replay mode', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cassette-'));
    await expect(withCassette(fakeProvider([]), { mode: 'replay', dir })(model, ask)).rejects.toBeInstanceOf(CassetteMissError);
  });

  it('replays each test its own answers when two tests send the same prompt', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cassette-'));
    const record = withCassette(fakeProvider(['a1', 'b1', 'b2']), { mode: 'record', dir });
    await record(model, ask, { scope: 'spec::test A', run: 'r1' });
    await record(model, ask, { scope: 'spec::test B', run: 'r1' });
    await record(model, ask, { scope: 'spec::test B', run: 'r1' });
    const replay = withCassette(async () => {
      throw new Error('network must not be used in replay');
    }, { mode: 'replay', dir });
    expect((await replay(model, ask, { scope: 'spec::test B', run: 'r2' })).text).toBe('b1');
    expect((await replay(model, ask, { scope: 'spec::test B', run: 'r2' })).text).toBe('b2');
    expect((await replay(model, ask, { scope: 'spec::test A', run: 'r2' })).text).toBe('a1');
    // A re-run of the spec (a new run id) starts from the first answer again.
    expect((await replay(model, ask, { scope: 'spec::test B', run: 'r3' })).text).toBe('b1');
  });

  it('passes straight through in live mode', async () => {
    const live = withCassette(fakeProvider(['live answer']), { mode: 'live', dir: '/nonexistent' });
    expect((await live(model, ask)).text).toBe('live answer');
  });
});

describe('per-spec reports', async () => {
  const { writeSpecReport } = await import('../src/plugin/report/spec-reports');
  const { readdirSync: ls, readFileSync: read } = await import('node:fs');
  const record = { ts: '', spec: 'cypress/e2e/text/01-single.cy.ts', test: 't', command: 'aiAssert', model: 'm', pass: true, checks: [{ name: 'means', pass: true, score: 0.9 }] };

  it('numbers reports per spec, keeps the newest, and indexes them', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'reports-'));
    for (let i = 0; i < 4; i++) writeSpecReport(dir, { spec: record.spec, tests: { total: 1, passed: 1, failed: 0, pending: 0 } }, [record], 3);
    const specDir = path.join(dir, 'text/01-single.cy.ts');
    expect(ls(specDir).sort()).toEqual(['latest.html', 'report-002.html', 'report-003.html', 'report-004.html']);
    expect(read(path.join(specDir, 'latest.html'), 'utf8')).toContain('run #4');
    expect(read(path.join(dir, 'index.html'), 'utf8')).toContain('text/01-single.cy.ts');
  });
});
