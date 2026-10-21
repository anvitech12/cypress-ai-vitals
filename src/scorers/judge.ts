import type { CheckResult, JudgeSpec } from '../shared/types';
import type { GenerateRequest, GenerateResult, MediaInput } from '../providers/types';
import { parseJsonOutput } from './text-utils';

export type JudgeGenerate = (modelName: string, req: GenerateRequest) => Promise<GenerateResult>;

const SYSTEM = [
  'You are a strict evaluator for automated tests.',
  'Score the response against the rubric from 1 to 5, where 5 means it fully meets every point and 1 means it fails.',
  'Judge only what is asked. Do not reward length.',
  'Reply with JSON only: {"score": <integer 1-5>, "reason": "<one short sentence>"}',
].join(' ');

export async function judgeCheck(
  generate: JudgeGenerate,
  spec: JudgeSpec,
  defaultJudge: string | undefined,
  subject: { text?: string; image?: MediaInput; question?: string },
): Promise<CheckResult> {
  const model = spec.model ?? defaultJudge;
  if (!model) throw new Error('judge needs a model. Set AI_JUDGE=<model name> in ai.env or pass judge.model.');
  const min = spec.min ?? 4;
  const prompt = [
    `Rubric: ${spec.rubric}`,
    subject.question ? `Question that produced the response: ${subject.question}` : '',
    subject.text !== undefined ? `Response to evaluate:\n<<<\n${subject.text}\n>>>` : 'Evaluate the attached image.',
  ]
    .filter(Boolean)
    .join('\n\n');
  const result = await generate(model, {
    task: 'text',
    system: SYSTEM,
    prompt,
    images: subject.image ? [subject.image] : undefined,
    params: { json: true },
  });
  let score = 0;
  let reason = '';
  try {
    const parsed = parseJsonOutput(result.text ?? '') as { score?: number; reason?: string };
    score = Number(parsed.score);
    reason = String(parsed.reason ?? '');
  } catch {
    reason = `judge returned unparseable output: ${(result.text ?? '').slice(0, 120)}`;
  }
  return {
    name: 'judge',
    pass: Number.isFinite(score) && score >= min,
    score: Number.isFinite(score) ? score : undefined,
    threshold: min,
    detail: `${model}: ${reason}`,
  };
}
