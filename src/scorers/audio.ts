import type { AudioSpec, CheckResult } from '../shared/types';
import { decodeWav, resample } from '../plugin/media';
import { cosine, embed, transcribeLocal } from '../plugin/ml';
import type { GenerateRequest, GenerateResult } from '../providers/types';
import { runCustom, type ScorerContext } from './registry';
import { wordErrorRate } from './text-utils';

export interface AudioScoringDeps extends ScorerContext {
  generate: (modelName: string, req: GenerateRequest) => Promise<GenerateResult>;
  defaultEngine?: string;
}

export interface AudioScore {
  checks: CheckResult[];
  transcript?: string;
  durationSec?: number;
}

export async function transcribe(audio: Buffer, mime: string, engine: string, deps: AudioScoringDeps): Promise<{ text: string; durationSec?: number }> {
  if (engine === 'local') {
    const decoded = decodeWav(audio);
    return { text: await transcribeLocal(resample(decoded.samples, decoded.sampleRate, 16000)), durationSec: decoded.durationSec };
  }
  const result = await deps.generate(engine, { task: 'transcribe', audio: { data: audio, mime } });
  let durationSec: number | undefined;
  try {
    durationSec = decodeWav(audio).durationSec;
  } catch {
    durationSec = undefined;
  }
  return { text: result.text ?? '', durationSec };
}

export async function scoreAudio(audio: Buffer, mime: string, spec: AudioSpec, deps: AudioScoringDeps): Promise<AudioScore> {
  const checks: CheckResult[] = [];
  let transcript: string | undefined;
  let durationSec: number | undefined;
  if (spec.transcript) {
    const engine = spec.transcript.engine ?? deps.defaultEngine ?? 'local';
    const result = await transcribe(audio, mime, engine, deps);
    transcript = result.text;
    durationSec = result.durationSec;
    const expected = spec.transcript.expected ?? spec.transcript.means;
    if (spec.transcript.maxWer !== undefined) {
      if (!expected) throw new Error('transcript.maxWer needs transcript.expected or transcript.means.');
      const wer = wordErrorRate(expected, transcript);
      checks.push({ name: 'wer', pass: wer <= spec.transcript.maxWer, score: wer, threshold: spec.transcript.maxWer, detail: `heard "${transcript}"` });
    }
    if (spec.transcript.means) {
      const [a, b] = await embed([transcript, spec.transcript.means]);
      const score = cosine(a, b);
      const min = spec.transcript.minMeans ?? 0.8;
      checks.push({ name: 'means', pass: score >= min, score, threshold: min, detail: `heard "${transcript}" (${engine})` });
    }
  }
  checks.push(...(await runCustom('audio', audio, spec.custom, deps)));
  return { checks, transcript, durationSec };
}
