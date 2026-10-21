import { formatCheck, formatMs, formatPercent, formatUsd, formatVitals } from '../shared/format';
import type {
  AudioSpec,
  CommonOptions,
  CompareResult,
  CompareSpec,
  ImageSpec,
  ScoreResult,
  SerializedRegExp,
  TextSpec,
  Vitals,
  VitalsThresholds,
} from '../shared/types';
import { normalizeAnyUsage, serverTimingMs } from '../shared/usage';
import { enablePanel, resetPanel, setReportLink, showPanel, track, type PanelOptions } from './panel';

export type * from '../shared/types';

export interface StableTextOptions {
  /**
   * When chained off an element: wait until its text is non-empty and has not changed for this many milliseconds,
   * so a streaming or typed-out answer is scored only once it is finished. 0 scores straight away. Default 750.
   */
  waitForStableMs?: number;
}

export type AiAssertOptions = TextSpec & CommonOptions & StableTextOptions;
export type AiImageAssertOptions = ImageSpec & CommonOptions;
export type AiAudioAssertOptions = AudioSpec & CommonOptions;
export type AiVitalsOptions = VitalsThresholds & CommonOptions;
export type AiCompareOptions = CompareSpec & Pick<CommonOptions, 'soft' | 'timeout'>;

export interface AiGenerateOptions extends Pick<CommonOptions, 'label' | 'timeout'> {
  task?: 'text' | 'image' | 'speech';
  system?: string;
  /** Image for vision models: a URL, a data: URL, or a path relative to the project root. */
  image?: string;
  params?: Record<string, unknown>;
}

export interface AiGenerateResult {
  text: string | null;
  /** data: URL for image or speech output. */
  media: string | null;
  finishReason: string | null;
  servedModel: string | null;
  vitals: Vitals;
}

export interface RegisterOptions {
  /** Show the live AI Vitals panel in the runner. Defaults to true. */
  panel?: boolean | PanelOptions;
  /** Default timeout for scoring commands in ms. The first call loads local models. Defaults to 120000. */
  timeout?: number;
}

declare global {
  namespace Cypress {
    interface Chainable<Subject = any> {
      /** Scores the subject's text (an element or a string) for meaning, facts, grounding, safety and more. */
      aiAssert(options: AiAssertOptions): Chainable<Subject>;
      /** Scores a generated <img>: what it depicts, brand colors and style, dimensions, and a vision judge. */
      aiImageAssert(options: AiImageAssertOptions): Chainable<Subject>;
      /** Scores generated speech in an <audio> element (or a URL): transcript accuracy and meaning. */
      aiAudioAssert(options: AiAudioAssertOptions): Chainable<Subject>;
      /** Reads tokens, latency and cost from an intercepted AI call (chain it off cy.wait('@alias')). */
      aiVitals(thresholds?: AiVitalsOptions): Chainable<Vitals>;
      /** Calls a named model from ai.env directly and yields its output and vitals. */
      aiGenerate(model: string, prompt: string, options?: AiGenerateOptions): Chainable<AiGenerateResult>;
      /** Runs a dataset against several named models and yields a leaderboard. */
      aiCompare(options: AiCompareOptions): Chainable<CompareResult>;
      /** Fails unless at least `min` (0 to 1) of the soft results with this label passed. */
      aiExpectPassRate(label: string, min: number): Chainable<number>;
      /** Lists the configured models (keys masked). */
      aiModels(): Chainable<Array<{ name: string; provider: string; model: string; key: string; baseUrl: string | null }>>;
    }
  }
}

let defaults: Required<Pick<RegisterOptions, 'timeout'>> = { timeout: 120_000 };
let registered = false;

/** A new id each time the spec loads, including re-runs in `cypress open`. */
const RUN_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

function meta(command: string, opts: Partial<CommonOptions> & { question?: string } = {}) {
  return {
    command,
    run: RUN_ID,
    shouldFail: opts.shouldFail,
    spec: Cypress.spec.relative,
    test: Cypress.currentTest?.titlePath?.join(' > ') ?? '',
    label: opts.label,
    soft: opts.soft,
    model: opts.model,
    question: opts.question,
  };
}

function serializeRegExp(r: RegExp | SerializedRegExp | undefined): SerializedRegExp | undefined {
  if (!r) return undefined;
  return r instanceof RegExp ? { source: r.source, flags: r.flags } : r;
}

function isJQuery(subject: unknown): subject is JQuery<HTMLElement> {
  return !!subject && typeof subject === 'object' && 'jquery' in (subject as object);
}

function textOf(subject: unknown): string {
  if (typeof subject === 'string') return subject;
  if (isJQuery(subject)) return (subject[0]?.innerText ?? subject.text()).trim();
  if (subject && typeof subject === 'object' && 'text' in subject) return String((subject as { text: unknown }).text ?? '');
  throw new Error('aiAssert needs an element or a string, e.g. cy.get("[data-cy=answer]").aiAssert({...}) or cy.wrap(text).aiAssert({...}).');
}

function summarize(result: ScoreResult, shouldFail = false): string {
  const checks = `${shouldFail ? (result.pass ? 'caught: ' : 'NOT caught: ') : ''}${result.checks.map(formatCheck).join(' · ')}`;
  const vitals = formatVitals(result.vitals);
  return [checks || (result.pass ? 'passed' : 'failed'), vitals].filter(Boolean).join(' | ');
}

function failure(command: string, result: ScoreResult, shouldFail = false): Error {
  if (shouldFail) {
    const err = new Error(`${command} expected the checks to catch this output, but all ${result.checks.length} passed.`);
    err.name = 'AssertionError';
    return err;
  }
  const failed = result.checks.filter((c) => !c.pass);
  const lines = failed.map((c) => `  - ${formatCheck(c)}${c.threshold !== undefined ? ` (threshold ${c.threshold})` : ''}${c.detail ? `: ${c.detail}` : ''}`);
  const err = new Error(`${command} failed ${failed.length} of ${result.checks.length} check(s):\n${lines.join('\n')}`);
  err.name = 'AssertionError';
  return err;
}

/** Runs a scoring task with one Command Log row that ends as passed or failed. */
function scored(
  command: string,
  displayName: string,
  task: string,
  payload: Record<string, unknown>,
  opts: CommonOptions,
  $el?: JQuery<HTMLElement>,
): Cypress.Chainable<ScoreResult> {
  const log = Cypress.log({ name: command, displayName, message: 'scoring…', autoEnd: false, $el });
  return cy.task<ScoreResult>(task, payload, { log: false, timeout: opts.timeout ?? defaults.timeout }).then((raw) => {
    // The Node side already inverts `pass` for shouldFail.
    const result = raw;
    log.set({
      message: summarize(result, opts.shouldFail),
      consoleProps: () => ({
        passed: result.pass,
        soft: !!opts.soft,
        checks: result.checks,
        vitals: result.vitals,
        output: result.output,
        'scoring time': formatMs(result.scoringMs),
      }),
    });
    track(result.pass, result.vitals, opts.model);
    if (!result.pass && !opts.soft) {
      const err = failure(command, result, opts.shouldFail);
      log.error(err);
      throw err;
    }
    log.end();
    return result;
  });
}

async function blobToDataUrl(url: string, win: Window): Promise<string> {
  const res = await win.fetch(url);
  if (!res.ok) throw new Error(`Could not load ${url}: ${res.status}`);
  const blob = await res.blob();
  return new Promise((resolve, reject) => {
    const reader = new (win as Window & typeof globalThis).FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/** Retries until the element's text is non-empty and unchanged for stableMs, so streamed answers are scored when complete. */
function waitForStableText(subject: JQuery, stableMs: number, timeout: number): Cypress.Chainable<JQuery> {
  let last = '';
  let since = 0;
  return cy.wrap(subject, { log: false, timeout }).should(($el) => {
    const text = textOf($el);
    const now = Date.now();
    if (!text || text !== last) {
      last = text;
      since = now;
    }
    if (!text) throw new Error('aiAssert is waiting for the element to show an answer (it is empty).');
    if (now - since < stableMs) throw new Error('aiAssert is waiting for the answer to finish (the text is still changing).');
  }) as unknown as Cypress.Chainable<JQuery>;
}

/**
 * Same-site media is fetched in the browser, so the app's cookies and any cy.intercept stubs apply, and reaches Node as a
 * data: URL. Media on another site is loaded by Node, because the browser would need CORS to read it.
 */
async function loadable(url: string, win: Window): Promise<string> {
  if (url.startsWith('data:')) return url;
  if (url.startsWith('blob:') || new URL(url).origin === win.location.origin) return blobToDataUrl(url, win);
  return url;
}

/** Resolves a media element or URL to something Node can load: a data: URL, or an absolute URL on another site. */
function mediaSource(subject: unknown): Cypress.Chainable<string> {
  // The result of cy.aiGenerate(model, prompt, { task: 'image' | 'speech' }) carries its media as a data URL.
  if (subject && typeof subject === 'object' && !isJQuery(subject) && typeof (subject as { media?: unknown }).media === 'string') {
    return mediaSource((subject as { media: string }).media);
  }
  if (typeof subject === 'string') {
    return cy.window({ log: false }).then((win) => cy.wrap(loadable(new URL(subject, win.location.href).toString(), win), { log: false, timeout: 30_000 }));
  }
  if (!isJQuery(subject)) throw new Error('Expected an <img>/<audio> element, a URL, or the result of cy.aiGenerate.');
  const el = subject[0] as HTMLImageElement & HTMLMediaElement;
  const src = el.currentSrc || el.getAttribute('src') || '';
  if (!src) throw new Error('The element has no src yet. Wait for it, e.g. cy.get("img[src]").');
  const win = el.ownerDocument.defaultView!;
  return cy.wrap(loadable(new URL(src, el.baseURI).toString(), win), { log: false, timeout: 30_000 });
}

function extractVitals(interception: any, win: Window, model?: string): Vitals {
  const headers: Record<string, string> = interception?.response?.headers ?? {};
  const body = interception?.response?.body;
  let parsed: any = body;
  if (typeof body === 'string') {
    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = undefined;
    }
  }
  let usage = normalizeAnyUsage(parsed?.usage ?? parsed?.usageMetadata ?? parsed?.vitals?.usage);
  if (!usage && headers['x-ai-usage']) {
    try {
      usage = normalizeAnyUsage(JSON.parse(headers['x-ai-usage']));
    } catch {
      usage = undefined;
    }
  }
  const vitals: Vitals = {
    model: model ?? parsed?.vitals?.model ?? headers['x-ai-model'] ?? parsed?.model,
    usage,
    costUsd: typeof parsed?.vitals?.costUsd === 'number' ? parsed.vitals.costUsd : undefined,
  };
  const serverMs = serverTimingMs(headers['server-timing']);
  if (serverMs !== undefined) {
    vitals.latencyMs = serverMs;
    vitals.latencySource = 'server-timing';
  } else {
    const url = interception?.request?.url;
    const entries = url ? (win.performance.getEntriesByName(url) as PerformanceResourceTiming[]) : [];
    const last = entries[entries.length - 1];
    if (last) {
      vitals.latencyMs = last.duration;
      vitals.latencySource = 'wall-clock';
    }
  }
  if (parsed?.vitals?.latencySource === 'cassette') vitals.latencySource = 'cassette';
  return vitals;
}

/** aiVitalsPlugin leaves its version in the config it returns; without it, every AI command's task would fail. */
function pluginRegistered(): boolean {
  try {
    return Cypress.expose('aiVitalsPlugin') !== undefined;
  } catch {
    return true;
  }
}

export function register(options: RegisterOptions = {}): void {
  if (options.timeout) defaults = { timeout: options.timeout };
  if (options.panel !== false) enablePanel(typeof options.panel === 'object' ? options.panel : {});
  if (registered) return;
  registered = true;

  Cypress.Commands.add('aiAssert', { prevSubject: true }, (subject: unknown, opts: AiAssertOptions) => {
    const { waitForStableMs = 750, ...rest } = opts;
    const spec: TextSpec = { ...rest, regex: serializeRegExp(opts.regex), notRegex: serializeRegExp(opts.notRegex) };
    const ready = isJQuery(subject) && waitForStableMs > 0 ? waitForStableText(subject, waitForStableMs, opts.timeout ?? 60_000) : cy.wrap(subject, { log: false });
    return ready.then(() =>
      scored('aiAssert', 'ai assert', 'aiVitals:scoreText', { output: textOf(subject), spec, meta: meta('aiAssert', rest) }, rest, isJQuery(subject) ? subject : undefined).then(() => subject),
    );
  });

  Cypress.Commands.add('aiImageAssert', { prevSubject: true }, (subject: unknown, opts: AiImageAssertOptions) => {
    if (isJQuery(subject) && subject.is('img')) {
      cy.wrap(subject, { log: false }).should(($img) => {
        const img = $img[0] as unknown as HTMLImageElement;
        expect(img.complete && img.naturalWidth > 0, 'image finished loading').to.equal(true);
      });
    }
    return mediaSource(subject).then((src) =>
      scored('aiImageAssert', 'ai image', 'aiVitals:scoreImage', { src, spec: opts, meta: meta('aiImageAssert', opts) }, opts, isJQuery(subject) ? subject : undefined).then(
        () => subject,
      ),
    );
  });

  Cypress.Commands.add('aiAudioAssert', { prevSubject: true }, (subject: unknown, opts: AiAudioAssertOptions) =>
    mediaSource(subject).then((src) =>
      scored('aiAudioAssert', 'ai audio', 'aiVitals:scoreAudio', { src, spec: opts, meta: meta('aiAudioAssert', opts) }, opts, isJQuery(subject) ? subject : undefined).then(
        () => subject,
      ),
    ),
  );

  Cypress.Commands.add('aiVitals', { prevSubject: true }, (interception: unknown, opts: AiVitalsOptions = {}) =>
    cy.window({ log: false }).then((win) => {
      const vitals = extractVitals(interception, win, opts.model);
      const { soft, label, timeout, model, shouldFail, ...thresholds } = opts;
      return scored('aiVitals', 'ai vitals', 'aiVitals:vitals', { vitals, thresholds, meta: meta('aiVitals', { soft, label, shouldFail, model: vitals.model }) }, { soft, timeout, shouldFail }).then(
        (result) => result.vitals ?? vitals,
      );
    }),
  );

  Cypress.Commands.add('aiGenerate', (model: string, prompt: string, opts: AiGenerateOptions = {}) => {
    const log = Cypress.log({ name: 'aiGenerate', displayName: 'ai generate', message: `${model}: ${prompt.slice(0, 60)}…`, autoEnd: false });
    const request = { task: opts.task ?? 'text', prompt, system: opts.system, params: opts.params, imageSrc: opts.image };
    return cy
      .task<AiGenerateResult>('aiVitals:generate', { model, request, meta: meta('aiGenerate', { label: opts.label, model, question: prompt }) }, { log: false, timeout: opts.timeout ?? defaults.timeout })
      .then((result) => {
        log.set({ message: `${model} | ${formatVitals(result.vitals)}`, consoleProps: () => ({ prompt, ...result, media: result.media ? `${result.media.slice(0, 40)}…` : null }) });
        track(undefined, result.vitals);
        log.end();
        return result;
      });
  });

  Cypress.Commands.add('aiCompare', (opts: AiCompareOptions) => {
    const log = Cypress.log({ name: 'aiCompare', displayName: 'ai compare', message: `${opts.models.join(' vs ')} on ${opts.dataset ?? `${opts.cases?.length ?? 0} inline case(s)`}`, autoEnd: false });
    return cy
      .task<CompareResult>('aiVitals:compare', { spec: opts, meta: meta('aiCompare', { label: opts.label }) }, { log: false, timeout: opts.timeout ?? 600_000 })
      .then((result) => {
        for (const call of result.calls ?? []) track(call.pass, call.vitals, call.model);
        for (const m of result.models) {
          Cypress.log({
            name: 'aiCompare',
            displayName: m.model === result.winner ? 'ai ★ winner' : 'ai model',
            message: `${m.model}${m.modelId ? ` (${m.modelId}${m.settings ? `, ${m.settings}` : ''})` : ''} · ${formatPercent(m.accuracy)} · p95 ${formatMs(m.p95LatencyMs)} · ${m.inputTokens + m.outputTokens} tok · ${formatUsd(m.costPer100Usd)}/100${m.gatesPassed ? '' : ` · ✗ ${m.gateFailures.join('; ')}`}`,
            consoleProps: () => ({ ...m }),
          });
        }
        log.set({ message: `winner: ${result.winner ?? 'n/a'}`, consoleProps: () => result });
        const failed = result.models.filter((m) => !m.gatesPassed);
        if (failed.length && !opts.soft) {
          const err = new Error(`aiCompare gates failed for ${failed.map((m) => `${m.model} (${m.gateFailures.join('; ')})`).join(', ')}`);
          log.error(err);
          throw err;
        }
        log.end();
        return result;
      });
  });

  Cypress.Commands.add('aiExpectPassRate', (label: string, min: number) =>
    cy.task<{ n: number; passRate: number }>('aiVitals:passRate', { label, run: RUN_ID }, { log: false }).then(({ n, passRate }) => {
      const pass = n > 0 && passRate >= min;
      const log = Cypress.log({ name: 'aiExpectPassRate', displayName: 'ai pass rate', message: `${label}: ${(passRate * 100).toFixed(0)}% of ${n} (min ${(min * 100).toFixed(0)}%)` });
      if (!pass) {
        const err = new Error(n === 0 ? `No results labelled "${label}" yet.` : `Pass rate for "${label}" is ${(passRate * 100).toFixed(0)}%, below ${(min * 100).toFixed(0)}%.`);
        err.name = 'AssertionError';
        log.error(err);
        throw err;
      }
      return passRate;
    }),
  );

  Cypress.Commands.add('aiModels', () => cy.task('aiVitals:models', null, { log: false }).then((models: any) => {
    Cypress.log({ name: 'aiModels', displayName: 'ai models', message: models.map((m: any) => m.name).join(', '), consoleProps: () => ({ models }) });
    return models;
  }));

  before(() => {
    resetPanel();
    if (!pluginRegistered()) {
      Cypress.log({ name: 'ai-vitals', message: 'aiVitalsPlugin(on, config) is missing from setupNodeEvents in cypress.config, or its config is not returned. AI commands will fail with "the task event has not been registered".' });
    }
  });
  after(() => {
    if (pluginRegistered()) {
      cy.task<{ url: string | null; path: string | null }>('aiVitals:reportLink', { spec: Cypress.spec.relative }, { log: false }).then((link) => {
        setReportLink(link);
        showPanel();
      });
    } else {
      showPanel();
    }
    // In recorded runs, hold for a moment so the finished panel makes it into the video.
    if (options.panel !== false && !Cypress.config('isInteractive') && Cypress.config('video')) cy.wait(1500, { log: false });
  });
}
