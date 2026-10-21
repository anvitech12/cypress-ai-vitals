import type { CheckResult, Modality } from '../shared/types';

export interface ScorerContext {
  projectRoot: string;
  fixturesFolder: string;
}

export interface Scorer<TOptions = unknown> {
  name: string;
  modality: Modality;
  /** `output` is text for text scorers and a Buffer (image or WAV bytes) for image and audio scorers. */
  run(output: string | Buffer, options: TOptions, ctx: ScorerContext): Promise<Omit<CheckResult, 'name'>> | Omit<CheckResult, 'name'>;
}

const scorers = new Map<string, Scorer<any>>();

/**
 * Registers a custom check. Use it from a spec with `custom: { <name>: options }`:
 *
 *   defineScorer({ name: 'polite', modality: 'text', run: (text) => ({ pass: /please|thank/i.test(String(text)) }) });
 *   cy.get('[data-cy=answer]').aiAssert({ custom: { polite: true } });
 */
export function defineScorer<TOptions>(scorer: Scorer<TOptions>): void {
  scorers.set(scorer.name, scorer);
}

export async function runCustom(
  modality: Modality,
  output: string | Buffer,
  custom: Record<string, unknown> | undefined,
  ctx: ScorerContext,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const [name, options] of Object.entries(custom ?? {})) {
    const scorer = scorers.get(name);
    if (!scorer) throw new Error(`No scorer named "${name}". Register it with defineScorer() in your Cypress config.`);
    if (scorer.modality !== modality) throw new Error(`Scorer "${name}" is for ${scorer.modality}, not ${modality}.`);
    results.push({ name, ...(await scorer.run(output, options, ctx)) });
  }
  return results;
}
