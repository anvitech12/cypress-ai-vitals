import { formatMs, formatTokens, formatUsd } from '../../shared/format';
import type { ModelSummary, ResultRecord } from '../../shared/types';
import { gatesCell, groupBy, latestGates, summarizeModel } from '../summary';

function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells: string[]) => `  │ ${cells.map((c, i) => c.padEnd(widths[i])).join(' │ ')} │`;
  const rule = (l: string, m: string, r: string) => `  ${l}${widths.map((w) => '─'.repeat(w + 2)).join(m)}${r}`;
  return [rule('┌', '┬', '┐'), line(headers), rule('├', '┼', '┤'), ...rows.map(line), rule('└', '┴', '┘')].join('\n');
}

export function leaderboardTable(models: ModelSummary[], winner?: string): string {
  const rows = models.map((m) => [
    `${m.model === winner ? '★ ' : ''}${m.model}`,
    [m.provider, m.modelId, m.settings].filter(Boolean).join(' · ') || '-',
    String(m.calls),
    Number.isNaN(m.accuracy) ? 'n/a' : `${(m.accuracy * 100).toFixed(0)}%`,
    Number.isFinite(m.accuracyCi[0]) ? `${(m.accuracyCi[0] * 100).toFixed(0)}-${(m.accuracyCi[1] * 100).toFixed(0)}%` : 'n/a',
    formatMs(m.p50LatencyMs),
    formatMs(m.p95LatencyMs),
    `${formatTokens(m.inputTokens)}/${formatTokens(m.outputTokens)}`,
    Number.isNaN(m.reasoningTokens) ? 'n/a' : formatTokens(m.reasoningTokens),
    formatUsd(m.costPer100Usd),
    gatesCell(m),
  ]);
  return table(['model', 'runs on', 'calls', 'accuracy', '95% CI', 'p50', 'p95', 'tokens in/out', 'thinking', '$/100 calls', 'gates'], rows);
}

/** Per-spec summary printed after each spec: one row per model, plus unattributed checks. */
export function specSummary(spec: string, records: ResultRecord[]): string {
  if (!records.length) return '';
  const byModel = groupBy(records, (r) => r.model ?? '(no model)');
  const models = [...byModel.entries()].map(([model, recs]) => summarizeModel(model, recs, latestGates(recs)));
  return `\n  AI Vitals: ${spec}\n${leaderboardTable(models)}\n`;
}
