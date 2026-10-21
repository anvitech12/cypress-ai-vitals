import type { Usage } from '../shared/types';
import type { ModelConfig } from './registry';

/**
 * Cost from the per-model prices in ai.env (USD per 1M tokens, per image, per audio minute).
 * Returns null when no price is configured, so reports show "n/a" instead of a made-up $0.
 */
export function computeCost(
  model: ModelConfig | undefined,
  usage: Usage | undefined,
  extras: { images?: number; audioSeconds?: number; characters?: number } = {},
): number | null {
  const price = model?.price;
  if (!price) return null;
  let cost = 0;
  let priced = false;
  if (usage && (price.inputPerMTok !== undefined || price.outputPerMTok !== undefined)) {
    cost += (usage.inputTokens * (price.inputPerMTok ?? 0) + usage.outputTokens * (price.outputPerMTok ?? 0)) / 1_000_000;
    priced = true;
  }
  if (extras.images && price.perImage !== undefined) {
    cost += extras.images * price.perImage;
    priced = true;
  }
  if (extras.characters && price.per1kChars !== undefined) {
    cost += (extras.characters / 1000) * price.per1kChars;
    priced = true;
  }
  if (extras.audioSeconds && price.perMinute !== undefined) {
    cost += (extras.audioSeconds / 60) * price.perMinute;
    priced = true;
  }
  return priced ? cost : null;
}
