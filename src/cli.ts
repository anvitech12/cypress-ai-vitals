import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { formatMs, formatTokens } from './shared/format';
import type { ResultRecord } from './shared/types';
import { generate, ProviderError, withRetry } from './providers';
import type { GenerateRequest } from './providers/types';
import { loadAiEnv, mask } from './plugin/env';
import { audioDurationSec, pcm16ToWav } from './plugin/media';
import { configureMl, warmAll } from './plugin/ml';
import { buildRegistry, type ModelConfig } from './plugin/registry';
import { renderHtml, renderMarkdown } from './plugin/report/html';
import { VERSION } from './version';

const HELP = `cypress-ai-vitals ${VERSION}

Usage:
  npx cypress-ai-vitals --version
      Print the installed version.
  npx cypress-ai-vitals report [--results cypress/ai-vitals/results] [--out cypress/ai-vitals/reports] [--run <id> | --all]
      Merge the latest run's JSONL results (every spec and CI shard) into run.html, summary.json and summary.md.
      (Each spec also writes its own report-NNN.html after it runs.)
      Shards that share AI_VITALS_RUN_ID land in the same run.
      Appends the Markdown summary to $GITHUB_STEP_SUMMARY when it is set.
  npx cypress-ai-vitals models [--env ai.env] [--ping]
      List the models named in ai.env (keys masked). --ping calls each one once: a one-word question, a tiny image,
      a one-word clip, or one second of silence to transcribe. Exits 1 if any model fails.
  npx cypress-ai-vitals clean
      Delete saved results and reports.
  npx cypress-ai-vitals warm [--cache .cache/ai-vitals-models]
      Download and load the local scoring models so the first test does not wait for them.
`;

/** One cheap call that fits what the model does, with the usual retries for rate limits. */
async function pingModel(m: ModelConfig): Promise<string> {
  const requests: Record<ModelConfig['modality'], GenerateRequest> = {
    chat: { task: 'text', prompt: 'Reply with the single word OK.', params: { maxTokens: 512 } },
    image: { task: 'image', prompt: 'A small blue square on a white background' },
    speech: { task: 'speech', prompt: 'OK' },
    transcribe: { task: 'transcribe', audio: { mime: 'audio/wav', data: pcm16ToWav(Buffer.alloc(16000 * 2), 16000) } },
  };
  const r = await withRetry(() => generate(m, requests[m.modality]));
  const time = formatMs(r.latencyMs);
  if (m.modality === 'chat') return `${JSON.stringify((r.text ?? '').slice(0, 20))} in ${time}, ${formatTokens(r.usage?.totalTokens)} tok`;
  if (m.modality === 'transcribe') return `heard ${JSON.stringify((r.text ?? '').trim().slice(0, 20))} (silence) in ${time}`;
  if (!r.media) throw new Error('returned no media');
  const seconds = m.modality === 'speech' ? audioDurationSec(r.media.data) : undefined;
  return `${r.media.mime}, ${Math.round(r.media.data.length / 1024)} KB${seconds ? `, ${seconds.toFixed(1)}s` : ''} in ${time}`;
}

function runDirs(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort((a, b) => statSync(path.join(root, a)).mtimeMs - statSync(path.join(root, b)).mtimeMs);
}

function readResults(dir: string): ResultRecord[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .flatMap((f) =>
      readFileSync(path.join(dir, f), 'utf8')
        .split('\n')
        .flatMap((line, i) => {
          if (!line.trim()) return [];
          try {
            return [JSON.parse(line) as ResultRecord];
          } catch {
            // A run that was killed mid-write leaves a cut-off last line; skip it rather than lose the whole report.
            console.warn(`  skipped an unreadable line: ${path.join(dir, f)}:${i + 1}`);
            return [];
          }
        }),
    );
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      results: { type: 'string', default: 'cypress/ai-vitals/results' },
      out: { type: 'string', default: 'cypress/ai-vitals/reports' },
      env: { type: 'string' },
      cache: { type: 'string', default: '.cache/ai-vitals-models' },
      ping: { type: 'boolean', default: false },
      run: { type: 'string' },
      all: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', short: 'v', default: false },
    },
  });
  const command = positionals[0];
  const cwd = process.cwd();

  if (values.version) {
    console.log(VERSION);
    return;
  }

  if (!command || values.help) {
    console.log(HELP);
    return;
  }

  if (command === 'report') {
    const root = path.resolve(cwd, values.results!);
    const runs = runDirs(root);
    if (values.run && !runs.includes(values.run)) {
      console.error(`No run "${values.run}" in ${values.results}. Runs: ${runs.slice(-5).join(', ') || '(none yet)'}`);
      process.exitCode = 1;
      return;
    }
    const picked = values.all ? runs : values.run ? [values.run] : runs.slice(-1);
    const records = [...readResults(root), ...picked.flatMap((r) => readResults(path.join(root, r)))];
    const out = path.resolve(cwd, values.out!);
    mkdirSync(out, { recursive: true });
    writeFileSync(path.join(out, 'run.html'), renderHtml(records, new Date(), { title: 'AI Vitals: whole run' }));
    writeFileSync(path.join(out, 'summary.json'), `${JSON.stringify(records, null, 2)}\n`);
    const md = renderMarkdown(records);
    writeFileSync(path.join(out, 'summary.md'), md);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${md}\n`);
    console.log(`AI Vitals report: ${records.length} results from ${values.all ? `${runs.length} runs` : `run ${picked[0] ?? '(none)'}`} → ${path.join(out, 'run.html')}`);
    return;
  }

  if (command === 'models') {
    const env = loadAiEnv(cwd, values.env);
    const registry = buildRegistry(env);
    if (!registry.size) {
      console.log('No models found. Add lines like AI_MODEL_FAST=groq:openai/gpt-oss-20b to ai.env.');
      // With --ping this is usually a CI step whose keys never arrived, so it must not pass quietly.
      if (values.ping) process.exitCode = 1;
      return;
    }
    const width = Math.max(...[...registry.keys()].map((n) => n.length));
    let failed = 0;
    for (const m of registry.values()) {
      let ping = '';
      if (values.ping) {
        try {
          ping = ` → ${await pingModel(m)}`;
        } catch (err) {
          failed++;
          const status = err instanceof ProviderError && err.status ? `${err.status} ` : '';
          ping = ` → FAILED ${status}${(err as Error).message.replace(/\s+/g, ' ').slice(0, 200)}`;
        }
      }
      const tags = m.tags.length ? ` [${m.tags.join(', ')}]` : '';
      console.log(`${m.name.padEnd(width)}  ${m.modality.padEnd(10)} ${m.preset}:${m.model}${tags}  key ${m.apiKey ? mask(m.apiKey) : '(not set)'}${ping}`);
    }
    if (failed) {
      console.log(`\n${failed} of ${registry.size} models failed.`);
      process.exitCode = 1;
    }
    return;
  }

  if (command === 'clean') {
    for (const dir of [values.results!, values.out!]) rmSync(path.resolve(cwd, dir), { recursive: true, force: true });
    console.log(`Removed ${values.results} and ${values.out}.`);
    return;
  }

  if (command === 'warm') {
    configureMl({ cacheDir: path.resolve(cwd, values.cache!), offline: false });
    await warmAll((msg) => console.log(`  ${msg}`));
    return;
  }

  console.error(`Unknown command "${command}".\n\n${HELP}`);
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
