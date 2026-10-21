import type { CompareSpec, ModelSummary, ResultRecord } from '../shared/types';
import { bootstrapCi, mean, passRate, percentile } from './stats';

export function summarizeModel(model: string, all: ResultRecord[], gates: CompareSpec['gates'] = {}): ModelSummary {
  // Accuracy only counts results that were scored; tokens, latency and cost only count model calls.
  const scored = all.filter((r) => r.checks.length > 0);
  const records = all.filter((r) => r.vitals?.usage || r.vitals?.latencyMs !== undefined);
  const passes = scored.map((r) => r.pass);
  const accuracyValues = passes.map((p) => (p ? 1 : 0));
  const latencies = records.map((r) => r.vitals?.latencyMs).filter((v): v is number => v !== undefined);
  const sum = (pick: (r: ResultRecord) => number | undefined) => records.reduce((s, r) => s + (pick(r) ?? 0), 0);
  const costs = records.map((r) => r.vitals?.costUsd);
  const costUsd = costs.some((c) => c === null || c === undefined) ? null : costs.reduce<number>((s, c) => s + (c ?? 0), 0);
  const reasoningKnown = records.some((r) => r.vitals?.usage?.reasoningTokens !== undefined);
  const described = all.find((r) => r.vitals?.modelId)?.vitals;
  const summary: ModelSummary = {
    model,
    provider: described?.provider,
    modelId: described?.modelId,
    settings: described?.settings,
    calls: records.length || scored.length,
    passRate: passRate(passes),
    // NaN means nothing was scored (for example plain aiGenerate calls), shown as n/a.
    accuracy: accuracyValues.length ? mean(accuracyValues) : NaN,
    accuracyCi: bootstrapCi(accuracyValues),
    p50LatencyMs: percentile(latencies, 50),
    p95LatencyMs: percentile(latencies, 95),
    inputTokens: sum((r) => r.vitals?.usage?.inputTokens),
    outputTokens: sum((r) => r.vitals?.usage?.outputTokens),
    reasoningTokens: reasoningKnown ? sum((r) => r.vitals?.usage?.reasoningTokens) : NaN,
    costUsd,
    costPer100Usd: costUsd === null || records.length === 0 ? null : (costUsd / records.length) * 100,
    hasGates: Object.values(gates ?? {}).some((v) => v !== undefined),
    gatesPassed: true,
    gateFailures: [],
  };
  // A model with nothing scored (every call failed, or no check applied) fails an accuracy gate rather than passing it.
  if (gates.accuracy !== undefined && !(summary.accuracy >= gates.accuracy)) {
    const got = Number.isNaN(summary.accuracy) ? 'n/a (nothing scored)' : `${(summary.accuracy * 100).toFixed(0)}%`;
    summary.gateFailures.push(`accuracy ${got} < ${(gates.accuracy * 100).toFixed(0)}%`);
  }
  if (gates.p95LatencyMs !== undefined && summary.p95LatencyMs > gates.p95LatencyMs) {
    summary.gateFailures.push(`p95 ${Math.round(summary.p95LatencyMs)}ms > ${gates.p95LatencyMs}ms`);
  }
  if (gates.costPer100Usd !== undefined && summary.costPer100Usd !== null && summary.costPer100Usd > gates.costPer100Usd) {
    summary.gateFailures.push(`$${summary.costPer100Usd.toFixed(4)}/100 calls > $${gates.costPer100Usd}`);
  }
  summary.gatesPassed = summary.gateFailures.length === 0;
  return summary;
}

/** Best accuracy wins; ties go to the cheaper model, then the faster one. */
export function pickWinner(models: ModelSummary[]): string | undefined {
  const ranked = [...models].filter((m) => !Number.isNaN(m.accuracy)).sort(
    (a, b) =>
      b.accuracy - a.accuracy ||
      (a.costPer100Usd ?? Infinity) - (b.costPer100Usd ?? Infinity) ||
      a.p95LatencyMs - b.p95LatencyMs,
  );
  return ranked[0]?.model;
}

export function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    map.set(k, [...(map.get(k) ?? []), item]);
  }
  return map;
}

/** The gates from the newest record that has any, so an older run without gates cannot hide a newer failure. */
export function latestGates(records: ResultRecord[]): CompareSpec['gates'] {
  let newest: ResultRecord | undefined;
  for (const r of records) if (r.gates && (!newest || r.ts >= newest.ts)) newest = r;
  return newest?.gates ?? {};
}

/** The gates cell shown in every table: a dash when no gates were set. */
export function gatesCell(m: ModelSummary): string {
  if (!m.hasGates) return '–';
  return m.gatesPassed ? '✓' : `✗ ${m.gateFailures.join('; ')}`;
}
