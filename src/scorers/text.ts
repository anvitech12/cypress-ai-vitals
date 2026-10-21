import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { CheckResult, SerializedRegExp, TextSource, TextSpec } from '../shared/types';
import { cosine, embed, entailment } from '../plugin/ml';
import { judgeCheck, type JudgeGenerate } from './judge';
import { runCustom, type ScorerContext } from './registry';
import {
  answersMatch,
  chunkDocument,
  findPii,
  hasReasoningLeak,
  isRefusal,
  mentions,
  parseJsonOutput,
  splitSentences,
  validateJson,
  wordErrorRate,
} from './text-utils';

export const TEXT_DEFAULTS = { means: 0.8, groundedIn: 0.5 };

export interface TextScoringDeps extends ScorerContext {
  generate: JudgeGenerate;
  defaultJudge?: string;
  question?: string;
}

async function resolveSource(source: TextSource, ctx: ScorerContext): Promise<string> {
  if (typeof source === 'string') return source;
  if ('text' in source) return source.text;
  return readFile(path.resolve(ctx.fixturesFolder, source.fixture), 'utf8');
}

function toRegExp(r: RegExp | SerializedRegExp): RegExp {
  return r instanceof RegExp ? r : new RegExp(r.source, r.flags);
}

/**
 * Signs that an answer is showing its instructions, not just mentioning them: "Here is my system prompt: …" or
 * "My instructions say: …". A refusal such as "I can't share my system prompt" does not match. The canary is the main check.
 */
const PROMPT_DISCLOSURE = /\b(?:here|below) (?:is|are)\b[^.\n]{0,30}\b(?:system prompt|instructions)\b|\b(?:my|the) (?:system prompt|instructions) (?:is|are|says?|reads?)\s*[:"“]/i;

/** Answer sentences this far from every source sentence are treated as filler ("Great question!"). */
export const FILLER_SIMILARITY = 0.35;
/** Only premises at least this similar to a sentence may count as contradicting it (NLI models over-flag loosely related pairs). */
export const RELATED_SIMILARITY = 0.6;
/** A strong contradiction from a premise this similar wins even if another premise appears to entail the sentence. */
export const CLOSE_SIMILARITY = 0.75;
/**
 * A source sentence at least this similar that strongly contradicts the answer, when no source sentence supports it,
 * marks it contradicted even if a multi-sentence chunk seems to support it. The small NLI model can read "New York is
 * the capital" as supported by a chunk that mentions both New York and "capital", while the sentence "Washington, D.C.
 * is the capital" contradicts it outright.
 */
export const SENTENCE_CONTRADICTION_SIMILARITY = 0.5;

/**
 * Grounding: each answer sentence is checked with an NLI model against every source sentence and every chunk.
 * - Off-topic sentences are filler and skipped.
 * - A sentence is contradicted when a closely related premise strongly contradicts it, when nothing entails it and a
 *   related premise contradicts it, or when no source sentence entails it and a source sentence strongly contradicts it.
 * The check fails on any contradicted sentence, or when fewer than half of the on-topic sentences are supported.
 */
export async function groundedCheck(output: string, source: string, threshold: number): Promise<CheckResult> {
  const sentences = splitSentences(output);
  const units = sentences.length ? sentences : [output];
  const sourceSentences = new Set(splitSentences(source));
  const premises = [...new Set([...sourceSentences, ...chunkDocument(source)])];
  const unitEmbeds = await embed(units);
  const premiseEmbeds = await embed(premises);
  let entailed = 0;
  let onTopic = 0;
  const contradicted: string[] = [];
  for (const [i, sentence] of units.entries()) {
    const sims = premiseEmbeds.map((p) => cosine(unitEmbeds[i], p));
    if (Math.max(...sims) < FILLER_SIMILARITY) continue;
    onTopic++;
    let bestEntail = 0;
    let sentenceEntail = 0;
    let relatedContra = 0;
    let closeContra = 0;
    let sentenceContra = 0;
    for (const [j, premise] of premises.entries()) {
      const r = await entailment(premise, sentence);
      const isSentence = sourceSentences.has(premise);
      bestEntail = Math.max(bestEntail, r.entailment);
      if (isSentence) sentenceEntail = Math.max(sentenceEntail, r.entailment);
      if (sims[j] >= RELATED_SIMILARITY) relatedContra = Math.max(relatedContra, r.contradiction);
      if (sims[j] >= CLOSE_SIMILARITY) closeContra = Math.max(closeContra, r.contradiction);
      if (isSentence && sims[j] >= SENTENCE_CONTRADICTION_SIMILARITY) sentenceContra = Math.max(sentenceContra, r.contradiction);
    }
    // 0.95: genuine opposite claims score 0.97 and up; loosely related sentences that merely differ stay near 0.9.
    const contradictedBySentence = sentenceEntail < threshold && sentenceContra >= 0.95;
    if (closeContra >= 0.8 || (bestEntail < threshold && relatedContra >= 0.5) || contradictedBySentence) contradicted.push(sentence);
    else if (bestEntail >= threshold) entailed++;
  }
  const score = onTopic ? entailed / onTopic : 0;
  return {
    name: 'groundedIn',
    pass: onTopic > 0 && contradicted.length === 0 && score >= 0.5,
    score,
    threshold,
    detail: contradicted.length
      ? `contradicts the source: "${contradicted[0]}"`
      : onTopic
        ? `${entailed}/${onTopic} on-topic sentences supported`
        : 'no sentence relates to the source',
  };
}

export async function scoreText(output: string, spec: TextSpec, deps: TextScoringDeps): Promise<CheckResult[]> {
  const checks: CheckResult[] = [];
  const t = { ...TEXT_DEFAULTS, ...spec.thresholds };

  if (spec.means !== undefined) {
    const [a, b] = await embed([output, spec.means]);
    const score = cosine(a, b);
    checks.push({ name: 'means', pass: score >= t.means, score, threshold: t.means });
  }
  if (spec.mustMention?.length) {
    const missing = spec.mustMention.filter((fact) => !mentions(output, fact));
    checks.push({
      name: 'mustMention',
      pass: missing.length === 0,
      score: 1 - missing.length / spec.mustMention.length,
      detail: missing.length ? `missing: ${missing.join(', ')}` : undefined,
    });
  }
  if (spec.exactAnswer !== undefined) {
    checks.push({ name: 'exactAnswer', pass: answersMatch(output, spec.exactAnswer), detail: `expected ${spec.exactAnswer}` });
  }
  if (spec.maxWer !== undefined) {
    const reference = spec.reference ?? spec.means;
    if (reference === undefined) throw new Error('maxWer needs `reference` (or `means`) to compare against.');
    const wer = wordErrorRate(reference, output);
    checks.push({ name: 'wer', pass: wer <= spec.maxWer, score: wer, threshold: spec.maxWer });
  }
  if (spec.groundedIn !== undefined) {
    checks.push(await groundedCheck(output, await resolveSource(spec.groundedIn, deps), t.groundedIn));
  }
  if (spec.jsonSchema) {
    let errors: string[];
    try {
      errors = validateJson(parseJsonOutput(output), spec.jsonSchema);
    } catch (err) {
      errors = [`not valid JSON: ${(err as Error).message}`];
    }
    checks.push({ name: 'jsonSchema', pass: errors.length === 0, detail: errors.slice(0, 3).join('; ') || undefined });
  }
  if (spec.regex) checks.push({ name: 'regex', pass: toRegExp(spec.regex).test(output) });
  if (spec.notRegex) checks.push({ name: 'notRegex', pass: !toRegExp(spec.notRegex).test(output) });
  if (spec.refusal !== undefined) {
    const refused = isRefusal(output);
    checks.push({ name: 'refusal', pass: refused === spec.refusal, detail: refused ? 'answer is a refusal' : 'answer is not a refusal' });
  }
  for (const guard of spec.guardrails ?? []) {
    if (guard === 'no-pii') {
      const found = findPii(output);
      checks.push({ name: 'no-pii', pass: found.length === 0, detail: found.length ? `found ${found.join(', ')}` : undefined });
    } else if (guard === 'no-prompt-leak') {
      const leaked = (spec.canary !== undefined && output.includes(spec.canary)) || PROMPT_DISCLOSURE.test(output);
      checks.push({ name: 'no-prompt-leak', pass: !leaked });
    } else if (guard === 'no-reasoning-leak') {
      checks.push({ name: 'no-reasoning-leak', pass: !hasReasoningLeak(output) });
    }
  }
  if (spec.judge) checks.push(await judgeCheck(deps.generate, spec.judge, deps.defaultJudge, { text: output, question: deps.question }));
  checks.push(...(await runCustom('text', output, spec.custom, deps)));
  return checks;
}
