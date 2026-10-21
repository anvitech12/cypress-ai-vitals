import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadAiEnv, unreadEnvHint } from '../src/plugin/env';
import { aiVitalsAfterSpec, aiVitalsPlugin } from '../src/plugin/index';
import { makeRedactor } from '../src/plugin/redact';
import { specReportDir } from '../src/plugin/report/spec-reports';

const project = (files: Record<string, string>) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ai-vitals-020-'));
  mkdirSync(path.join(dir, 'cypress/fixtures'), { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(path.join(dir, name), text);
  return dir;
};

describe('env files', () => {
  it("reads ai.env and not the app's .env, unless .env is named", () => {
    const dir = project({ 'ai.env': 'AI_MODEL_FAST=groq:a\n', '.env': 'AI_MODEL_APP=openai:b\nOPENAI_API_KEY=sk-app-production-key\n' });
    const byDefault = loadAiEnv(dir);
    expect(byDefault.AI_MODEL_FAST).toBe('groq:a');
    expect(byDefault.AI_MODEL_APP).toBeUndefined();
    expect(byDefault.OPENAI_API_KEY).toBe(process.env.OPENAI_API_KEY);
    expect(loadAiEnv(dir, '.env').AI_MODEL_APP).toBe('openai:b');
    expect(loadAiEnv(dir, ['ai.env', '.env'])).toMatchObject({ AI_MODEL_FAST: 'groq:a', AI_MODEL_APP: 'openai:b' });
  });

  it('says so when .env holds AI_* settings that are no longer read', () => {
    expect(unreadEnvHint(project({ '.env': 'AI_MODEL_FAST=groq:a\n' }))).toContain("envFile: '.env'");
    expect(unreadEnvHint(project({ '.env': 'AI_MODEL_FAST=groq:a\n' }), '.env')).toBeUndefined();
    expect(unreadEnvHint(project({ '.env': 'DATABASE_URL=postgres://localhost/app\n' }))).toBeUndefined();
    expect(unreadEnvHint(project({}))).toBeUndefined();
  });
});

describe('after:spec', () => {
  const setup = (options: Record<string, unknown>) => {
    const root = project({});
    const events: string[] = [];
    aiVitalsPlugin(((event: string) => events.push(event)) as never, { projectRoot: root, fixturesFolder: path.join(root, 'cypress/fixtures') } as never, {
      envFile: 'none.env',
      terminalSummary: false,
      offline: true,
      ...options,
    });
    return { root, events };
  };

  it('registers its handler by default', () => {
    expect(setup({}).events).toContain('after:spec');
  });

  it('leaves after:spec to you with registerAfterSpec: false, and aiVitalsAfterSpec does its work', () => {
    const { root, events } = setup({ registerAfterSpec: false });
    expect(events).not.toContain('after:spec');
    aiVitalsAfterSpec({ relative: 'cypress/e2e/mine.cy.ts' } as Cypress.Spec);
    expect(existsSync(path.join(specReportDir(path.join(root, 'cypress/ai-vitals/reports'), 'cypress/e2e/mine.cy.ts'), 'latest.html'))).toBe(true);
  });
});

describe('redaction by value', () => {
  it('redacts extra values of any length, longest first', () => {
    const redact = makeRedactor(['abc12', 'abc12-long-secret']);
    expect(redact('keys abc12-long-secret and abc12')).toBe('keys [redacted] and [redacted]');
  });

  it('redacts the user and password in a URL, and leaves URLs without them alone', () => {
    const redact = makeRedactor([]);
    expect(redact('DATABASE_URL=postgres://app:s3cret@db.internal:5432/app')).toBe('DATABASE_URL=postgres://[redacted]@db.internal:5432/app');
    expect(redact('see https://example.com/a@b and git@github.com:x/y')).toBe('see https://example.com/a@b and git@github.com:x/y');
  });

  it('applies the redact option to what the plugin stores', async () => {
    const root = project({ 'ai.env': 'SHORT=abc12\n' });
    const tasks: Record<string, (arg: unknown) => Promise<{ checks: { detail?: string }[] }>> = {};
    aiVitalsPlugin(((event: string, handlers: typeof tasks) => event === 'task' && Object.assign(tasks, handlers)) as never, { projectRoot: root } as never, {
      terminalSummary: false,
      specReports: false,
      offline: true,
      redact: ['abc12'],
    });
    const result = await tasks['aiVitals:scoreText']({ output: 'the key is abc12', spec: { exactAnswer: 'abc12' }, meta: { command: 'aiAssert', spec: 'a.cy.ts', test: 't' } });
    expect(JSON.stringify(result)).not.toContain('abc12');
  });
});
