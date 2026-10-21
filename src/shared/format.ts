import type { CheckResult, Vitals } from './types';

export function formatMs(ms: number | null | undefined): string {
  // null: NaN becomes null when a result travels from Node to the browser as JSON.
  if (ms === undefined || ms === null || Number.isNaN(ms)) return 'n/a';
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

export function formatPercent(rate: number | null | undefined): string {
  if (rate === undefined || rate === null || Number.isNaN(rate)) return 'n/a';
  return `${(rate * 100).toFixed(0)}%`;
}

export function formatTokens(n: number | undefined): string {
  if (n === undefined) return 'n/a';
  return n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export function formatUsd(usd: number | null | undefined): string {
  if (usd === null || usd === undefined) return 'n/a';
  if (usd === 0) return '$0';
  return usd < 0.01 ? `$${usd.toFixed(5)}` : `$${usd.toFixed(3)}`;
}

export function formatScore(score: number | undefined): string {
  if (score === undefined) return '';
  return Number.isInteger(score) ? String(score) : score.toFixed(2);
}

export function formatCheck(check: CheckResult): string {
  const mark = check.pass ? '✓' : '✗';
  const score = formatScore(check.score);
  return score ? `${check.name} ${score} ${mark}` : `${check.name} ${mark}`;
}

export function formatVitals(vitals: Vitals | undefined): string {
  if (!vitals) return '';
  const parts: string[] = [];
  if (vitals.usage) {
    const reasoning = vitals.usage.reasoningTokens ? ` (${formatTokens(vitals.usage.reasoningTokens)} thinking)` : '';
    parts.push(`${formatTokens(vitals.usage.totalTokens)} tok${reasoning}`);
  }
  if (vitals.latencyMs !== undefined) parts.push(formatMs(vitals.latencyMs));
  if (vitals.costUsd !== undefined) parts.push(formatUsd(vitals.costUsd));
  return parts.join(' · ');
}
