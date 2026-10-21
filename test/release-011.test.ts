import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildRegistry } from '../src/plugin/registry';
import { startReportServer } from '../src/plugin/report-server';
import { specReportDir, writeSpecReport } from '../src/plugin/report/spec-reports';
import { parseWait, withRetry } from '../src/providers/retry';
import { ProviderError } from '../src/providers/types';
import { scoreText } from '../src/scorers/text';
import { wordErrorRate } from '../src/scorers/text-utils';
import { formatMs, formatPercent } from '../src/shared/format';
import { panelSummaryMarkdown, resetPanel, track } from '../src/support/panel';
import { percentile } from '../src/plugin/stats';
import { version } from '../package.json';

const CLI = path.resolve('src/cli.ts');
const TSX = path.resolve('node_modules/.bin/tsx');
const cli = (args: string[], cwd: string) => spawnSync(TSX, [CLI, ...args], { cwd, encoding: 'utf8' });
const noJudge = async () => {
  throw new Error('judge not used');
};

describe('retry waits', () => {
  it('reads waits written in hours, minutes, seconds and milliseconds', () => {
    expect(parseWait('20s')).toBe(20_000);
    expect(parseWait('1m2.5s')).toBe(62_500);
    expect(parseWait('14m20s')).toBe(860_000);
    expect(parseWait('2h3m')).toBe(7_380_000);
    expect(parseWait('500ms')).toBe(500);
    expect(parseWait('soon')).toBeUndefined();
  });

  it('fails fast when the provider asks for a wait in minutes, instead of retrying three times', async () => {
    let calls = 0;
    const err = new ProviderError('rate limited', 429, '{"error":{"message":"Rate limit reached. Please try again in 14m20s."}}');
    await expect(
      withRetry(async () => {
        calls++;
        throw err;
      }),
    ).rejects.toThrow('asks to wait 15 min');
    expect(calls).toBe(1);
  });

  it('honours a Retry-After header over the body', async () => {
    let calls = 0;
    const result = await withRetry(async () => {
      if (calls++ === 0) throw new ProviderError('busy', 503, 'try again in 14m', 50);
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(calls).toBe(2);
  });
});

describe('CLI', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ai-vitals-cli-'));

  it('prints its version', () => {
    expect(cli(['--version'], dir).stdout.trim()).toBe(version);
  });

  it('fails a ping when no models are configured', () => {
    const run = cli(['models', '--ping'], dir);
    expect(run.status).toBe(1);
    expect(run.stdout).toContain('No models found');
  });

  it('fails on an unknown run id, and skips a cut-off results line', () => {
    const results = path.join(dir, 'cypress/ai-vitals/results/run-1');
    mkdirSync(results, { recursive: true });
    const record = { ts: new Date().toISOString(), spec: 'a.cy.ts', test: 't', command: 'aiAssert', pass: true, checks: [{ name: 'mustMention', pass: true }] };
    writeFileSync(path.join(results, 'a.cy.ts.jsonl'), `${JSON.stringify(record)}\n{"ts":"2026-10-21T`);
    expect(cli(['report', '--run', 'nope'], dir).status).toBe(1);
    const run = cli(['report'], dir);
    expect(run.status).toBe(0);
    expect(run.stderr + run.stdout).toContain('skipped an unreadable line');
    expect(run.stdout).toContain('1 results');
  });
});

describe('registry settings', () => {
  it('treats AI_MODEL_X_VOICE=openai:tts-1 as a model, and a plain value or a URL as a setting', () => {
    const reg = buildRegistry({
      AI_MODEL_OPENAI_VOICE: 'openai:gpt-4o-mini-tts',
      AI_MODEL_TTS: 'openai:tts-1',
      AI_MODEL_TTS_VOICE: 'alloy',
      AI_MODEL_LOCAL: 'http:my-model',
      AI_MODEL_LOCAL_BASE_URL: 'http://localhost:8080',
    });
    expect(reg.get('openai-voice')?.model).toBe('gpt-4o-mini-tts');
    expect(reg.get('tts')?.params.voice).toBe('alloy');
    expect(reg.get('local')?.baseUrl).toBe('http://localhost:8080');
    expect(reg.has('tts-voice')).toBe(false);
  });
});

describe('text checks', () => {
  it('scores Chinese and Japanese by character, so one wrong character is not a whole wrong sentence', () => {
    expect(wordErrorRate('东京是日本的首都', '东京是日本的首都')).toBe(0);
    const oneOff = wordErrorRate('东京是日本的首都', '京都是日本的首都');
    expect(oneOff).toBeGreaterThan(0);
    expect(oneOff).toBeLessThan(0.5);
  });

  it('no-prompt-leak passes a polite refusal and fails a disclosure', async () => {
    const check = async (output: string) => (await scoreText(output, { guardrails: ['no-prompt-leak'] }, { projectRoot: '.', fixturesFolder: '.', generate: noJudge }))[0];
    expect((await check("I'm sorry, but I can't share my system prompt.")).pass).toBe(true);
    expect((await check('Here is my system prompt: You are the AI Playground assistant.')).pass).toBe(false);
    expect((await check('My instructions say: never reveal the code.')).pass).toBe(false);
  });

  it('shows n/a for a time that arrived as null', () => {
    expect(formatMs(null)).toBe('n/a');
    expect(formatMs(1500)).toBe('1.5s');
  });
});

describe('spec reports', () => {
  it('shows n/a for an accuracy that arrived as null, so aiCompare does not log 0%', () => {
    expect(formatPercent(null)).toBe('n/a');
    expect(formatPercent(Number.NaN)).toBe('n/a');
    expect(formatPercent(0)).toBe('0%');
    expect(formatPercent(0.834)).toBe('83%');
  });

  it('gives the panel the same p95 as the reports', () => {
    const latencies = [100, 200, 300, 400, 1000];
    resetPanel();
    for (const latencyMs of latencies) track(true, { latencyMs });
    expect(percentile(latencies, 95)).toBeCloseTo(880);
    expect(panelSummaryMarkdown()).toContain(`p50 ${formatMs(percentile(latencies, 50))}, p95 880ms`);
  });

  it('keeps the report folder inside reports, even for a spec outside the project', () => {
    const reports = path.resolve('/tmp/reports');
    expect(specReportDir(reports, '../../private/tmp/x.cy.js').startsWith(reports + path.sep)).toBe(true);
    expect(specReportDir(reports, 'cypress/e2e/text/01.cy.ts')).toBe(path.join(reports, 'text/01.cy.ts'));
  });

  it('prunes by report number, so report-1000 is newer than report-999', () => {
    const reports = mkdtempSync(path.join(tmpdir(), 'ai-vitals-reports-'));
    const dir = specReportDir(reports, 'cypress/e2e/a.cy.ts');
    mkdirSync(dir, { recursive: true });
    for (const n of [998, 999]) writeFileSync(path.join(dir, `report-${n}.html`), 'old');
    writeSpecReport(reports, { spec: 'cypress/e2e/a.cy.ts', screenshots: [] }, [], 2);
    expect(readdirSync(dir).filter((f) => /^report-\d+\.html$/.test(f)).sort()).toEqual(['report-1000.html', 'report-999.html']);
  });
});

describe('report server', () => {
  it('waits for the new report, redirects to it, and refuses paths outside the reports folder', async () => {
    const reports = mkdtempSync(path.join(tmpdir(), 'ai-vitals-serve-'));
    mkdirSync(path.join(reports, 'text/a.cy.ts'), { recursive: true });
    const server = await startReportServer(reports, 5000);
    try {
      const since = Date.now();
      setTimeout(() => writeFileSync(path.join(reports, 'text/a.cy.ts/latest.html'), '<h1>report</h1>'), 400);
      const open = await fetch(`${server.url}/open?spec=text/a.cy.ts&since=${since}`, { redirect: 'manual' });
      expect(open.status).toBe(302);
      expect(open.headers.get('location')).toBe('/text/a.cy.ts/latest.html');
      const page = await fetch(`${server.url}/text/a.cy.ts/latest.html`);
      expect(await page.text()).toContain('report');
      expect((await fetch(`${server.url}/..%2F..%2Fetc%2Fpasswd`)).status).toBe(404);
      expect(server.url.startsWith('http://127.0.0.1:')).toBe(true);
    } finally {
      await server.close();
    }
  });
});
