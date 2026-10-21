import { formatMs, formatTokens, formatUsd } from '../../shared/format';
import type { ModelSummary, ResultRecord } from '../../shared/types';
import { gatesCell, groupBy, latestGates, pickWinner, summarizeModel } from '../summary';

export interface ReportSection {
  title: string;
  kind: 'arena' | 'spec';
  models: ModelSummary[];
  winner?: string;
  records: ResultRecord[];
}

export function buildSections(records: ResultRecord[]): ReportSection[] {
  const sections: ReportSection[] = [];
  const arenas = groupBy(
    records.filter((r) => r.command === 'aiCompare'),
    (r) => r.label ?? 'arena',
  );
  for (const [label, recs] of arenas) {
    const models = [...groupBy(recs, (r) => r.model ?? '?').entries()].map(([m, rs]) => summarizeModel(m, rs, latestGates(rs)));
    sections.push({ title: `Arena: ${label}`, kind: 'arena', models, winner: pickWinner(models), records: recs });
  }
  const specs = groupBy(
    records.filter((r) => r.command !== 'aiCompare'),
    (r) => r.spec,
  );
  for (const [spec, recs] of specs) {
    const models = [...groupBy(recs, (r) => r.model ?? '(no model)').entries()].map(([m, rs]) => summarizeModel(m, rs, latestGates(rs)));
    sections.push({ title: spec, kind: 'spec', models, records: recs });
  }
  return sections;
}

function esc(text: unknown): string {
  return String(text ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

const PALETTE = ['#3cc48f', '#8b5cf6', '#f59e0b', '#4f5be8', '#22b8cf', '#f25f5c'];

/** Accuracy vs cost per 100 calls (or p95 latency when no prices are set). Up and to the left is better. */
function pareto(models: ModelSummary[]): string {
  models = models.filter((m) => !Number.isNaN(m.accuracy));
  const priced = models.every((m) => m.costPer100Usd !== null);
  const xs = models.map((m) => (priced ? (m.costPer100Usd as number) : m.p95LatencyMs));
  if (!models.length || xs.some((x) => !Number.isFinite(x))) return '';
  const W = 560;
  const H = 300;
  const pad = { l: 56, r: 24, t: 34, b: 44 };
  const maxX = Math.max(...xs) * 1.15 || 1;
  const x = (v: number) => pad.l + (v / maxX) * (W - pad.l - pad.r);
  const y = (acc: number) => pad.t + (1 - acc) * (H - pad.t - pad.b);
  const front = models
    .map((m, i) => ({ m, x: xs[i] }))
    .filter((a) => !models.some((b, j) => xs[j] <= a.x && b.accuracy >= a.m.accuracy && (xs[j] < a.x || b.accuracy > a.m.accuracy)))
    .sort((a, b) => a.x - b.x);
  const xLabel = priced ? 'cost per 100 calls (USD, list price)' : 'p95 latency (ms)';
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  return `<figure class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Accuracy versus ${esc(xLabel)}">
    ${ticks.map((t) => `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(t)}" y2="${y(t)}" class="grid"/><text x="${pad.l - 8}" y="${y(t) + 4}" class="tick" text-anchor="end">${t * 100}%</text>`).join('')}
    <line x1="${pad.l}" x2="${W - pad.r}" y1="${H - pad.b}" y2="${H - pad.b}" class="axis"/>
    <text x="${(W + pad.l) / 2}" y="${H - 10}" class="label" text-anchor="middle">${esc(xLabel)} →</text>
    <text x="14" y="${(H - pad.b) / 2}" class="label" transform="rotate(-90 14 ${(H - pad.b) / 2})" text-anchor="middle">accuracy</text>
    ${front.length > 1 ? `<polyline class="front" points="${front.map((p) => `${x(p.x)},${y(p.m.accuracy)}`).join(' ')}"/>` : ''}
    ${(() => {
      // Place each label in the first free slot above or below its point, so labels never overlap, even when
      // several models share the same accuracy. Labels away from their point get a thin leader line.
      const OFFSETS = [-10, 22, -28, 40, -46, 58];
      // Every point is an obstacle too, so no label is drawn across another model's dot.
      const placed: Array<{ x1: number; x2: number; y1: number; y2: number }> = models.map((m, i) => ({ x1: x(xs[i]) - 9, x2: x(xs[i]) + 9, y1: y(m.accuracy) - 9, y2: y(m.accuracy) + 9 }));
      const order = models.map((_, i) => i).sort((a, b) => xs[a] - xs[b]);
      const labels = new Map<number, { tx: number; ty: number; anchor: string; offset: number }>();
      for (const i of order) {
        const px = x(xs[i]);
        const py = y(models[i].accuracy);
        const width = models[i].model.length * 7.4;
        const left = px > W - 160;
        const tx = left ? px - 10 : px + 10;
        const [x1, x2] = left ? [tx - width, tx] : [tx, tx + width];
        const fits = (ty: number) => ty - 12 >= 0 && ty + 3 <= H - pad.b && !placed.some((b) => x1 < b.x2 && x2 > b.x1 && ty - 12 < b.y2 && ty + 3 > b.y1);
        const offset = OFFSETS.find((o) => fits(py + o)) ?? OFFSETS[0];
        placed.push({ x1, x2, y1: py + offset - 12, y2: py + offset + 3 });
        labels.set(i, { tx, ty: py + offset, anchor: left ? 'end' : 'start', offset });
      }
      return models
        .map((m, i) => {
          const l = labels.get(i)!;
          const leader = l.offset !== -10 && l.offset !== 22 ? `<line x1="${x(xs[i])}" y1="${y(m.accuracy)}" x2="${l.tx}" y2="${l.ty - 4}" class="grid"/>` : '';
          return `<g>${leader}<circle cx="${x(xs[i])}" cy="${y(m.accuracy)}" r="7" fill="${PALETTE[i % PALETTE.length]}"/><text x="${l.tx}" text-anchor="${l.anchor}" y="${l.ty}" class="point">${esc(m.model)}</text></g>`;
        })
        .join('');
    })()}
  </svg><figcaption>Up and to the left is better. The line joins models no other model beats on both accuracy and ${priced ? 'cost' : 'latency'}.</figcaption></figure>`;
}

function leaderboard(models: ModelSummary[], winner?: string): string {
  const rows = models
    .map(
      (m) => `<tr${m.model === winner ? ' class="winner"' : ''}>
      <th scope="row">${m.model === winner ? '★ ' : ''}${esc(m.model)}${m.modelId ? `<small class="runs-on">${esc([m.provider, m.modelId, m.settings].filter(Boolean).join(' · '))}</small>` : ''}</th>
      <td>${m.calls}</td>
      <td>${Number.isNaN(m.accuracy) ? 'n/a' : `${(m.accuracy * 100).toFixed(0)}%`}<small>${Number.isFinite(m.accuracyCi[0]) ? ` ${(m.accuracyCi[0] * 100).toFixed(0)}–${(m.accuracyCi[1] * 100).toFixed(0)}%` : ''}</small></td>
      <td>${formatMs(m.p50LatencyMs)}</td><td>${formatMs(m.p95LatencyMs)}</td>
      <td>${formatTokens(m.inputTokens)} / ${formatTokens(m.outputTokens)}</td>
      <td>${Number.isNaN(m.reasoningTokens) ? 'n/a' : formatTokens(m.reasoningTokens)}</td>
      <td>${formatUsd(m.costPer100Usd)}</td>
      <td class="gates ${!m.hasGates ? '' : m.gatesPassed ? 'ok' : 'bad'}">${esc(gatesCell(m))}</td></tr>`,
    )
    .join('');
  return `<div class="table"><table><thead><tr><th>model</th><th>calls</th><th>accuracy (95% CI)</th><th>p50</th><th>p95</th><th>tokens in / out</th><th>thinking</th><th>$ / 100 calls</th><th>gates</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function details(records: ResultRecord[]): string {
  const items = records
    .map((r) => {
      const checks = r.checks
        .map((c) => `<li class="${c.pass ? 'ok' : 'bad'}">${c.pass ? '✓' : '✗'} ${esc(c.name)}${c.score !== undefined ? ` <b>${esc(Number(c.score.toFixed(3)))}</b>` : ''}${c.threshold !== undefined ? ` <small>threshold ${esc(c.threshold)}</small>` : ''}${c.detail ? ` <small>${esc(c.detail)}</small>` : ''}</li>`)
        .join('');
      const v = r.vitals;
      const vitals = v ? `${formatTokens(v.usage?.totalTokens)} tok · ${formatMs(v.latencyMs)}${v.latencySource ? ` (${v.latencySource})` : ''} · ${formatUsd(v.costUsd)}` : '';
      const name = r.command === 'aiCompare' ? r.test.split(' > ').slice(-1)[0] : r.test;
      return `<details><summary><span class="${r.pass ? 'ok' : 'bad'}">${r.pass ? '✓' : '✗'}</span> ${esc(name)} <small>${esc(r.command)}${r.model ? ` · ${esc(r.model)}` : ''}${vitals ? ` · ${vitals}` : ''}</small></summary>
        ${r.output ? `<pre>${esc(r.output)}</pre>` : ''}${checks ? `<ul>${checks}</ul>` : ''}</details>`;
    })
    .join('');
  return `<details class="drill"><summary><h3>Every result (${records.length})</h3></summary>${items}</details>`;
}

export interface RenderOptions {
  title?: string;
  subtitle?: string;
  /** Pre-escaped HTML links, e.g. to the spec's video and screenshots. */
  linksHtml?: string;
  /** Shown when there are no records. */
  emptyText?: string;
}

export function renderHtml(records: ResultRecord[], generatedAt = new Date(), options: RenderOptions = {}): string {
  const sections = buildSections(records);
  const total = records.filter((r) => r.checks.length).length;
  const passed = records.filter((r) => r.checks.length && r.pass).length;
  const body = sections
    .map(
      (s) => `<section class="block"><h2>${esc(s.title)}</h2>
      ${s.winner ? `<p class="winner-line">Best value: <b>★ ${esc(s.winner)}</b> (highest accuracy, then lowest cost, then lowest p95)</p>` : ''}
      ${leaderboard(s.models, s.winner)}${s.kind === 'arena' ? pareto(s.models) : ''}${details(s.records)}</section>`,
    )
    .join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(options.title ?? 'AI Vitals report')}</title><style>
:root{--bg:#f6f7fb;--card:#fff;--text:#161827;--muted:#5b6178;--line:#e3e5ee;--ok:#1f9d6b;--bad:#d64541;--accent:#4f5be8;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#11131f;--card:#1a1d2e;--text:#e8eaf2;--muted:#9aa0b8;--line:#2c3046;--ok:#3cc48f;--bad:#f25f5c;--accent:#8b93ff;color-scheme:dark}}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:1100px;margin:0 auto;padding:24px 16px 64px}
h1{margin:0 0 4px;font-size:28px}h2{margin:0 0 8px;font-size:20px}h3{font-size:15px;color:var(--muted)}
.sub{color:var(--muted);margin:0 0 24px}.block{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:20px;margin:0 0 20px}
.table{overflow-x:auto}table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}th,td{padding:8px 10px;border-bottom:1px solid var(--line);text-align:left;white-space:nowrap}
thead th{color:var(--muted);font-weight:500;font-size:13px}tr.winner th{color:var(--accent)}small{color:var(--muted);margin-left:4px}.runs-on{display:block;margin:2px 0 0;font-weight:400;font-size:12px}
td.gates{white-space:normal;min-width:150px}.ok{color:var(--ok)}.bad{color:var(--bad)}.winner-line{margin:0 0 12px}
.chart{margin:16px 0 0;max-width:620px}.chart svg{width:100%;height:auto}.chart figcaption{color:var(--muted);font-size:13px}
.grid{stroke:var(--line)}.axis{stroke:var(--muted)}.tick,.label{fill:var(--muted);font-size:11px}.point{fill:var(--text);font-size:12px;font-weight:600}.front{fill:none;stroke:var(--accent);stroke-dasharray:4 4;stroke-width:1.5}
details{border-top:1px solid var(--line);padding:6px 0}.drill>summary h3{display:inline;margin:0}.drill{margin-top:12px}summary{cursor:pointer}pre{white-space:pre-wrap;background:var(--bg);padding:10px;border-radius:8px;font-size:13px}ul{margin:6px 0 6px 18px;padding:0}
</style></head><body><main>
<h1>${esc(options.title ?? 'AI Vitals report')}</h1>
<p class="sub">${options.subtitle ? `${esc(options.subtitle)} · ` : ''}${passed}/${total} AI checks passed · ${records.length} records · ${esc(generatedAt.toLocaleString())}${options.linksHtml ? ` · ${options.linksHtml}` : ''}</p>
${body || `<p>${esc(options.emptyText ?? 'No results yet. Run your Cypress specs first.')}</p>`}
</main></body></html>`;
}

export function renderMarkdown(records: ResultRecord[]): string {
  const lines = ['## AI Vitals', ''];
  for (const s of buildSections(records)) {
    lines.push(`### ${s.title}`, '', '| model | runs on | calls | accuracy | p95 | tokens in/out | thinking | $/100 calls | gates |', '|---|---|---|---|---|---|---|---|---|');
    for (const m of s.models) {
      lines.push(
        `| ${m.model === s.winner ? '★ ' : ''}${m.model} | ${[m.provider, m.modelId, m.settings].filter(Boolean).join(' · ') || '-'} | ${m.calls} | ${Number.isNaN(m.accuracy) ? 'n/a' : `${(m.accuracy * 100).toFixed(0)}%`} | ${formatMs(m.p95LatencyMs)} | ${m.inputTokens}/${m.outputTokens} | ${Number.isNaN(m.reasoningTokens) ? 'n/a' : m.reasoningTokens} | ${formatUsd(m.costPer100Usd)} | ${gatesCell(m)} |`,
      );
    }
    lines.push('');
  }
  return lines.join('\n');
}
