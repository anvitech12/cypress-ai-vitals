import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ModelConfig } from './registry';
import type { GenerateRequest, GenerateResult } from '../providers/types';

export type CassetteMode = 'live' | 'record' | 'replay';

export interface CassetteOptions {
  /** Removes secrets from recordings before they are written. */
  redact?: (text: string) => string;
  mode: CassetteMode;
  dir: string;
}

export interface CassetteContext {
  /** Calls are counted per scope (usually spec + test title), so replays stay in order. */
  scope?: string;
  /** One id per spec run; counters start again for each run, e.g. a re-run in `cypress open`. */
  run?: string;
}

export interface CassetteResult extends GenerateResult {
  cassette?: 'hit' | 'recorded';
}

interface StoredResponse extends Omit<GenerateResult, 'media'> {
  media?: { file: string; mime: string };
  /** The scope that recorded this answer, so each test replays its own answers. */
  scope?: string;
}

interface CassetteFile {
  key: string;
  model: string;
  preset: string;
  task: string;
  prompt?: string;
  responses: StoredResponse[];
}

const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'audio/wav': 'wav', 'audio/mpeg': 'mp3' };

function sha(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function sorted(obj: Record<string, unknown> | undefined): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj ?? {}).sort(([a], [b]) => a.localeCompare(b)));
}

export function cassetteKey(model: ModelConfig, req: GenerateRequest): string {
  return sha(
    JSON.stringify({
      preset: model.preset,
      model: model.model,
      task: req.task,
      prompt: req.prompt ?? null,
      system: req.system ?? null,
      params: sorted({ ...model.params, ...req.params }),
      images: (req.images ?? []).map((i) => sha(i.data)),
      audio: req.audio ? sha(req.audio.data) : null,
    }),
  ).slice(0, 24);
}

export class CassetteMissError extends Error {
  constructor(model: ModelConfig, req: GenerateRequest, file: string) {
    super(
      `No recording for model "${model.name}" (${req.task}: "${(req.prompt ?? '').slice(0, 80)}"). ` +
        `Expected ${file}. Run once with AI_MODE=record to capture it.`,
    );
    this.name = 'CassetteMissError';
  }
}

/** Wraps a generate function with record/replay. In live mode it is a pass-through. */
export function withCassette(
  generate: (model: ModelConfig, req: GenerateRequest) => Promise<GenerateResult>,
  options: CassetteOptions,
): (model: ModelConfig, req: GenerateRequest, ctx?: CassetteContext) => Promise<CassetteResult> {
  const counters = new Map<string, number>();
  const freshThisRun = new Set<string>();

  return async (model, req, ctx = {}) => {
    if (options.mode === 'live') return generate(model, req);
    const key = cassetteKey(model, req);
    const file = path.join(options.dir, `${key}.json`);
    const counterKey = `${ctx.run ?? ''}::${ctx.scope ?? ''}::${key}`;
    const index = counters.get(counterKey) ?? 0;
    counters.set(counterKey, index + 1);

    if (options.mode === 'replay') {
      if (!existsSync(file)) throw new CassetteMissError(model, req, file);
      const stored = JSON.parse(readFileSync(file, 'utf8')) as CassetteFile;
      // Recordings made before scopes were stored have none; they replay in order across tests, as before.
      const own = stored.responses.filter((r) => r.scope !== undefined && r.scope === ctx.scope);
      const pool = own.length ? own : stored.responses;
      const hit = pool[index % pool.length];
      const result: CassetteResult = { ...hit, media: undefined, cassette: 'hit' };
      if (hit.media) result.media = { mime: hit.media.mime, data: readFileSync(path.join(options.dir, hit.media.file)) };
      return result;
    }

    const live = await generate(model, req);
    mkdirSync(options.dir, { recursive: true });
    const existing: CassetteFile =
      freshThisRun.has(key) && existsSync(file)
        ? (JSON.parse(readFileSync(file, 'utf8')) as CassetteFile)
        : { key, model: model.model, preset: model.preset, task: req.task, prompt: req.prompt?.slice(0, 200), responses: [] };
    freshThisRun.add(key);
    const stored: StoredResponse = { ...live, media: undefined, scope: ctx.scope };
    if (live.media) {
      const name = `${key}-${existing.responses.length}.${EXT[live.media.mime] ?? 'bin'}`;
      writeFileSync(path.join(options.dir, name), live.media.data);
      stored.media = { file: name, mime: live.media.mime };
    }
    existing.responses.push(stored);
    const json = `${JSON.stringify(existing, null, 2)}\n`;
    writeFileSync(file, options.redact ? options.redact(json) : json);
    return { ...live, cassette: 'recorded' };
  };
}
