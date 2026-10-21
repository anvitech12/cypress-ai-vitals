import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  AudioSpec,
  CheckResult,
  CompareCase,
  CompareResult,
  CompareSpec,
  ImageSpec,
  Modality,
  ResultRecord,
  ScoreResult,
  TextSpec,
  Vitals,
  VitalsThresholds,
} from '../shared/types';
import { generate as providerGenerate } from '../providers';
import type { GenerateRequest, GenerateResult } from '../providers/types';
import { withRetry } from '../providers/retry';
import { scoreAudio } from '../scorers/audio';
import { scoreImage } from '../scorers/image';
import { scoreText } from '../scorers/text';
import { withCassette, type CassetteMode } from './cassette';
import { computeCost } from './cost';
import { loadAiEnv, mask, unreadEnvHint } from './env';
import { audioDurationSec, loadMedia } from './media';
import { makeRedactor, redactDeep, secretValues } from './redact';
import { configureMl, warmAll } from './ml';
import { buildRegistry, describeSettings, requireModel, type ModelConfig, type ModelDefinition } from './registry';
import { leaderboardTable, specSummary } from './report/terminal';
import { writeSpecReport, specReportDir } from './report/spec-reports';
import { startReportServer, type ReportServer } from './report-server';
import { ResultStore } from './store';
import { pickWinner, summarizeModel } from './summary';
import { VERSION } from '../version';

export interface AiVitalsOptions {
  /** Models defined in code. Merged over the AI_MODEL_* entries from ai.env. */
  models?: Record<string, ModelDefinition>;
  /** Env file(s) to read instead of ai.env. Your app's .env is read only if you name it here. */
  envFile?: string | string[];
  /** live | record | replay. Defaults to AI_MODE, then live. */
  mode?: CassetteMode;
  /** Where recordings live. Defaults to <fixturesFolder>/ai-cassettes. */
  cassetteDir?: string;
  /** Where JSONL results go. Defaults to <projectRoot>/cypress/ai-vitals/results. */
  resultsDir?: string;
  /** Where local models are cached. Defaults to <projectRoot>/.cache/ai-vitals-models. */
  modelCacheDir?: string;
  /** Never download local models (fail fast instead). Defaults to AI_VITALS_OFFLINE=1. */
  offline?: boolean;
  /** Named model used by `judge` checks. Defaults to AI_JUDGE. */
  judge?: string;
  /** Speech-to-text engine for aiAudioAssert: 'local' or a named model. Defaults to AI_STT, then local. */
  stt?: string;
  /** Print a per-spec AI Vitals table in the terminal (registers after:spec). Defaults to true. */
  terminalSummary?: boolean;
  /** Save an HTML report per spec run (registers after:spec). Defaults to true. */
  specReports?: boolean;
  /** Where per-spec reports go. Defaults to <projectRoot>/cypress/ai-vitals/reports. */
  reportsDir?: string;
  /** Reports kept per spec; older ones are deleted. Defaults to 10. */
  keepReports?: number;
  /**
   * Register the plugin's after:spec handler. Defaults to true. Cypress keeps only one after:spec handler, so set false
   * when you have your own, and call aiVitalsAfterSpec(spec, results) from it.
   */
  registerAfterSpec?: boolean;
  /** Extra values to redact from results, reports, recordings and error messages, such as a short key. */
  redact?: string[];
}

/** Name of the check added when an assertion ran nothing. */
const NOTHING_RAN = 'no checks';
const COMPARE_SCORERS: string[] = ['exactAnswer', 'means', 'mustMention', 'groundedIn', 'judge'];

/** Fails an assertion that produced no checks, usually because an option name is misspelled. */
function orNothingRan(checks: CheckResult[], spec: object | undefined): CheckResult[] {
  if (checks.length) return checks;
  const given = Object.keys(spec ?? {}).filter((k) => (spec as Record<string, unknown>)[k] !== undefined);
  const detail = given.length ? `no check ran; is an option misspelled? Got: ${given.join(', ')}` : 'no check ran; pass at least one check option';
  return [{ name: NOTHING_RAN, pass: false, detail }];
}

export interface Meta {
  command: string;
  spec: string;
  test: string;
  label?: string;
  soft?: boolean;
  shouldFail?: boolean;
  model?: string;
  question?: string;
  /** One id per spec run, set by the browser. */
  run?: string;
}

const MAX_RETRIES = 3;

function vitalsChecks(vitals: Vitals, thresholds: VitalsThresholds = {}): CheckResult[] {
  const checks: CheckResult[] = [];
  const add = (name: string, value: number | null | undefined, max: number | undefined) => {
    if (max === undefined) return;
    checks.push(
      value === undefined || value === null
        ? { name, pass: false, threshold: max, detail: 'not reported' }
        : { name, pass: value <= max, score: value, threshold: max },
    );
  };
  add('latencyMs', vitals.latencyMs, thresholds.latencyMs);
  add('inputTokens', vitals.usage?.inputTokens, thresholds.inputTokens);
  add('outputTokens', vitals.usage?.outputTokens, thresholds.outputTokens);
  add('reasoningTokens', vitals.usage?.reasoningTokens, thresholds.reasoningTokens);
  add('totalTokens', vitals.usage?.totalTokens, thresholds.totalTokens);
  add('costUsd', vitals.costUsd, thresholds.costUsd);
  return checks;
}

async function loadDataset(file: string): Promise<CompareCase[]> {
  const raw = await readFile(file, 'utf8');
  if (file.endsWith('.jsonl')) {
    return raw.split('\n').flatMap((line, i) => {
      if (!line.trim()) return [];
      try {
        return [JSON.parse(line) as CompareCase];
      } catch (err) {
        throw new Error(`aiCompare dataset ${file}, line ${i + 1}: ${(err as Error).message}`);
      }
    });
  }
  return JSON.parse(raw) as CompareCase[];
}

let afterSpecHandler: ((spec: Cypress.Spec, results?: CypressCommandLine.RunResult) => void) | undefined;

/** The plugin's after:spec work (terminal summary and spec report), for your own after:spec handler. */
export function aiVitalsAfterSpec(spec: Cypress.Spec, results?: CypressCommandLine.RunResult): void {
  if (!afterSpecHandler) throw new Error('aiVitalsAfterSpec needs aiVitalsPlugin(on, config) to run first in setupNodeEvents.');
  afterSpecHandler(spec, results);
}

export function aiVitalsPlugin(
  on: Cypress.PluginEvents,
  config: Cypress.PluginConfigOptions,
  options: AiVitalsOptions = {},
): Cypress.PluginConfigOptions {
  const projectRoot = config.projectRoot;
  const fixturesFolder = config.fixturesFolder || path.join(projectRoot, 'cypress/fixtures');
  const env = loadAiEnv(projectRoot, options.envFile);
  const envHint = unreadEnvHint(projectRoot, options.envFile);
  if (envHint) console.log(`  [ai-vitals] ${envHint}`);
  const registry = buildRegistry(env, options.models);
  const mode = (options.mode ?? (env.AI_MODE as CassetteMode | undefined) ?? 'live') as CassetteMode;
  if (!['live', 'record', 'replay'].includes(mode)) throw new Error(`AI_MODE must be live, record or replay (got "${mode}").`);
  const judge = options.judge ?? env.AI_JUDGE;
  const stt = options.stt ?? env.AI_STT;
  // One folder per run; CI shards share AI_VITALS_RUN_ID so `report` can merge them.
  const runId = env.AI_VITALS_RUN_ID ?? new Date().toISOString().replace(/[:.]/g, '-');
  // Keys and account ids from ai.env never reach results, reports, recordings or the Command Log.
  const redact = makeRedactor([...secretValues(env, registry.values()), ...(options.redact ?? [])]);
  const store = new ResultStore(path.join(options.resultsDir ?? path.join(projectRoot, 'cypress/ai-vitals/results'), runId), redact);
  const reportsDir = options.reportsDir ?? path.join(projectRoot, 'cypress/ai-vitals/reports');
  configureMl({
    cacheDir: options.modelCacheDir ?? path.join(projectRoot, '.cache/ai-vitals-models'),
    offline: options.offline ?? env.AI_VITALS_OFFLINE === '1',
  });

  const cassette = withCassette(providerGenerate, {
    mode,
    dir: options.cassetteDir ?? path.join(fixturesFolder, 'ai-cassettes'),
    redact,
  });
  /** Registers tasks whose results and error messages are redacted before they reach the browser. */
  const onTask = (handlers: Record<string, (arg: any) => unknown>) =>
    on(
      'task',
      Object.fromEntries(
        Object.entries(handlers).map(([name, fn]) => [
          name,
          async (arg: unknown) => {
            try {
              return redactDeep(await fn(arg), redact);
            } catch (err) {
              if (err instanceof Error) err.message = redact(err.message);
              throw err;
            }
          },
        ]),
      ),
    );

  async function call(model: ModelConfig, req: GenerateRequest, scope: string, run?: string): Promise<GenerateResult & { vitals: Vitals }> {
    const result = await withRetry(
      () => cassette(model, req, { scope, run }),
      MAX_RETRIES,
      (err, waitMs) => console.log(`  [ai-vitals] ${model.name}: ${err.status}, retrying in ${Math.round(waitMs / 100) / 10}s`),
    );
    // Per-minute prices apply to the audio a model hears (transcription) or produces (speech).
    const clip = req.task === 'transcribe' ? req.audio?.data : req.task === 'speech' ? result.media?.data : undefined;
    const audioSeconds = clip ? audioDurationSec(clip) : undefined;
    return {
      ...result,
      vitals: {
        model: model.name,
        provider: model.preset,
        modelId: model.model,
        settings: describeSettings(model.params),
        latencyMs: result.latencyMs,
        latencySource: result.cassette === 'hit' ? 'cassette' : 'provider',
        usage: result.usage,
        costUsd: computeCost(model, result.usage, {
          images: req.task === 'image' ? 1 : 0,
          audioSeconds,
          characters: req.task === 'speech' ? (req.prompt ?? '').length : undefined,
        }),
      },
    };
  }

  /** Started on first use, in cypress open only, so the panel can open a report in a new tab. */
  let reportServer: Promise<ReportServer> | undefined;
  const judgeGenerate = (scope: string, run?: string) => (name: string, req: GenerateRequest) => call(requireModel(registry, name), req, `${scope}::judge`, run);
  const scope = (meta: Meta) => `${meta.spec}::${meta.test}`;
  const ctx = { projectRoot, fixturesFolder };

  function finish(
    meta: Meta,
    modality: Modality | undefined,
    checks: CheckResult[],
    started: number,
    extra: Partial<ScoreResult> & { gates?: CompareSpec['gates'] } = {},
  ): ScoreResult & { record: ResultRecord } {
    const allPassed = checks.every((c) => c.pass);
    // An assertion that ran no check fails even with shouldFail, so a misspelled option cannot pass silently.
    const ranNothing = checks.some((c) => c.name === NOTHING_RAN);
    const pass = ranNothing ? false : meta.shouldFail ? checks.length > 0 && !allPassed : allPassed;
    const record: ResultRecord = {
      ts: new Date().toISOString(),
      spec: meta.spec,
      test: meta.test,
      run: meta.run,
      command: meta.command,
      label: meta.label,
      modality,
      model: meta.model ?? extra.vitals?.model,
      pass,
      soft: meta.soft,
      shouldFail: meta.shouldFail,
      checks,
      vitals: extra.vitals,
      output: extra.output?.slice(0, 1000),
      gates: extra.gates,
    };
    store.add(record);
    const { gates: _gates, ...rest } = extra;
    return { pass, checks, scoringMs: performance.now() - started, ...rest, record };
  }

  onTask({
    async 'aiVitals:scoreText'({ output, spec, meta }: { output: string; spec: TextSpec; meta: Meta }): Promise<ScoreResult> {
      const started = performance.now();
      const checks = await scoreText(output, spec, { ...ctx, generate: judgeGenerate(scope(meta), meta.run), defaultJudge: judge, question: meta.question });
      return finish(meta, 'text', orNothingRan(checks, spec), started, { output });
    },

    async 'aiVitals:scoreImage'({ src, spec, meta }: { src: string; spec: ImageSpec; meta: Meta }): Promise<ScoreResult> {
      const started = performance.now();
      const media = await loadMedia(src, projectRoot);
      const checks = await scoreImage(media.data, media.mime, spec, { ...ctx, generate: judgeGenerate(scope(meta), meta.run), defaultJudge: judge });
      return finish(meta, 'image', orNothingRan(checks, spec), started);
    },

    async 'aiVitals:scoreAudio'({ src, spec, meta }: { src: string; spec: AudioSpec; meta: Meta }): Promise<ScoreResult> {
      const started = performance.now();
      const media = await loadMedia(src, projectRoot);
      const result = await scoreAudio(media.data, media.mime, spec, {
        ...ctx,
        defaultEngine: stt,
        generate: (name, req) => call(requireModel(registry, name), req, `${scope(meta)}::stt`, meta.run),
      });
      return finish(meta, 'audio', orNothingRan(result.checks, spec), started, { output: result.transcript });
    },

    'aiVitals:vitals'({ vitals, thresholds, meta }: { vitals: Vitals; thresholds?: VitalsThresholds; meta: Meta }): ScoreResult {
      const started = performance.now();
      const known = vitals.model ? registry.get(vitals.model.toLowerCase()) : undefined;
      const enriched: Vitals = {
        ...vitals,
        provider: vitals.provider ?? known?.preset,
        modelId: vitals.modelId ?? known?.model,
        settings: vitals.settings ?? (known ? describeSettings(known.params) : undefined),
        costUsd: vitals.costUsd ?? computeCost(known, vitals.usage),
      };
      return finish(meta, undefined, vitalsChecks(enriched, thresholds), started, { vitals: enriched });
    },

    async 'aiVitals:generate'({ model, request, meta }: { model: string; request: GenerateRequest & { imageSrc?: string }; meta: Meta }) {
      const config = requireModel(registry, model);
      const req: GenerateRequest = { ...request };
      if (request.imageSrc) {
        const media = await loadMedia(request.imageSrc, projectRoot);
        req.images = [{ data: media.data, mime: media.mime }];
      }
      const result = await call(config, req, scope(meta), meta.run);
      const started = performance.now();
      const scored = finish({ ...meta, model }, req.task === 'image' ? 'image' : 'text', [], started, {
        vitals: result.vitals,
        output: result.text,
      });
      return {
        text: result.text ?? null,
        media: result.media ? `data:${result.media.mime};base64,${result.media.data.toString('base64')}` : null,
        finishReason: result.finishReason ?? null,
        servedModel: result.servedModel ?? null,
        vitals: scored.vitals,
      };
    },

    async 'aiVitals:compare'({ spec, meta }: { spec: CompareSpec; meta: Meta }): Promise<CompareResult> {
      if (!spec.cases?.length && !spec.dataset) throw new Error('aiCompare needs `dataset` (a fixture file) or `cases` (inline).');
      if (!spec.models?.length) throw new Error('aiCompare needs at least one model name in `models`.');
      const unknownScorers = (spec.scorers ?? []).filter((s) => !COMPARE_SCORERS.includes(s));
      if (unknownScorers.length) throw new Error(`aiCompare does not support the scorer(s) ${unknownScorers.join(', ')}. Use: ${COMPARE_SCORERS.join(', ')}.`);
      const label = spec.label ?? (spec.dataset ? path.basename(spec.dataset) : 'inline');
      const cases = spec.cases?.length ? spec.cases : await loadDataset(path.resolve(fixturesFolder, spec.dataset!));
      const runs = spec.runs ?? 1;
      const summaries = [];
      const calls: NonNullable<CompareResult['calls']> = [];
      for (const name of spec.models) {
        const model = requireModel(registry, name);
        const records: ResultRecord[] = [];
        for (const [i, testCase] of cases.entries()) {
          for (let run = 0; run < runs; run++) {
            const started = performance.now();
            const caseMeta: Meta = { ...meta, command: 'aiCompare', label, model: name, test: `${meta.test} > ${testCase.id ?? i}` };
            let checks: CheckResult[];
            let vitals: Vitals | undefined;
            let output: string | undefined;
            try {
              const result = await call(model, { task: 'text', prompt: testCase.input, system: spec.system }, `compare::${label}`, meta.run);
              vitals = result.vitals;
              output = result.text ?? '';
              const use = new Set(spec.scorers ?? []);
              const textSpec: TextSpec = {};
              if (testCase.answer !== undefined && (!spec.scorers || use.has('exactAnswer'))) textSpec.exactAnswer = testCase.answer;
              if (testCase.expected && (!spec.scorers || use.has('means'))) textSpec.means = testCase.expected;
              if (testCase.mustMention && (!spec.scorers || use.has('mustMention'))) textSpec.mustMention = testCase.mustMention;
              if (testCase.groundedIn && (!spec.scorers || use.has('groundedIn'))) textSpec.groundedIn = { text: testCase.groundedIn };
              if (testCase.rubric && use.has('judge')) textSpec.judge = { rubric: testCase.rubric };
              checks = await scoreText(output, textSpec, { ...ctx, generate: judgeGenerate(`compare::${label}`, meta.run), defaultJudge: judge, question: testCase.input });
              if (result.finishReason === 'length' && !output.trim()) {
                checks.push({ name: 'finished', pass: false, detail: 'ran out of tokens before answering' });
              }
            } catch (err) {
              checks = [{ name: 'error', pass: false, detail: (err as Error).message.slice(0, 200) }];
            }
            const done = finish(caseMeta, 'text', checks, started, { vitals, output, gates: spec.gates });
            records.push(done.record);
            calls.push({ model: name, pass: done.pass, vitals });
          }
        }
        summaries.push(summarizeModel(name, records, spec.gates));
      }
      const winner = pickWinner(summaries);
      console.log(`\n  AI Vitals arena: ${label}\n${leaderboardTable(summaries, winner)}\n`);
      return { label, models: summaries, winner, calls };
    },

    'aiVitals:passRate'({ label, run }: { label: string; run?: string }) {
      // Only scored results from this spec run: not model calls, and not earlier runs in `cypress open`.
      const records = store.forLabel(label).filter((r) => r.checks.length > 0 && (run === undefined || r.run === run));
      return { n: records.length, passRate: records.length ? records.filter((r) => r.pass).length / records.length : 0 };
    },

    'aiVitals:models'() {
      return [...registry.values()].map((m) => ({ name: m.name, provider: m.preset, model: m.model, key: mask(m.apiKey), baseUrl: m.baseUrl ?? null }));
    },

    /** Where the full report for a spec will be: a link in cypress open, the file path in cypress run. */
    async 'aiVitals:reportLink'({ spec }: { spec: string }): Promise<{ url: string | null; path: string | null }> {
      if (options.specReports === false) return { url: null, path: null };
      const dir = specReportDir(reportsDir, spec);
      const file = path.relative(projectRoot, path.join(dir, 'latest.html'));
      if (config.isTextTerminal) return { url: null, path: file };
      // cypress open only sends after:spec, which writes the report, when experimentalInteractiveRunEvents is on.
      if (!config.experimentalInteractiveRunEvents) return { url: null, path: null };
      reportServer ??= startReportServer(reportsDir);
      const { url } = await reportServer;
      const folder = path.relative(reportsDir, dir).split(path.sep).join('/');
      return { url: `${url}/open?spec=${encodeURIComponent(folder)}&since=${Date.now()}`, path: file };
    },

    async 'aiVitals:warm'() {
      await warmAll((msg) => console.log(`  [ai-vitals] ${msg}`));
      return null;
    },
  });

  const afterSpec = (spec: Cypress.Spec, results?: CypressCommandLine.RunResult) => {
    const records = store.forSpec(spec.relative);
    if (options.terminalSummary !== false) {
      const summary = specSummary(spec.relative, records);
      if (summary) console.log(summary);
    }
    if (options.specReports !== false) {
      const stats = results?.stats;
      const file = writeSpecReport(
        reportsDir,
        {
          spec: spec.relative,
          tests: stats ? { total: stats.tests, passed: stats.passes, failed: stats.failures, pending: stats.pending, durationMs: stats.duration } : undefined,
          video: results?.video ?? null,
          screenshots: results?.screenshots?.map((s) => s.path) ?? [],
        },
        records,
        options.keepReports ?? 10,
      );
      console.log(`  [ai-vitals] report: ${path.relative(projectRoot, file)}`);
    }
  };
  afterSpecHandler = afterSpec;
  if (options.registerAfterSpec !== false && (options.terminalSummary !== false || options.specReports !== false)) on('after:spec', afterSpec);

  // Lets the support file tell a missing aiVitalsPlugin apart from other task errors.
  config.expose = { ...(config.expose ?? {}), aiVitalsPlugin: VERSION };
  console.log(`  [ai-vitals] ${VERSION} · mode ${mode} · ${registry.size} model(s): ${[...registry.keys()].join(', ') || 'none'}`);
  return config;
}

export { defineScorer } from '../scorers/registry';
export { defineProvider } from '../providers';
export { specSummary, leaderboardTable } from './report/terminal';
export { writeSpecReport, writeIndex } from './report/spec-reports';
export { makeRedactor, secretValues } from './redact';
export type { ModelDefinition } from './registry';
