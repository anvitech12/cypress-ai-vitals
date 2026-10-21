import { formatMs, formatTokens, formatUsd } from '../shared/format';
import type { Vitals } from '../shared/types';
import { percentile as sharedPercentile } from '../plugin/stats';

export interface PanelOptions {
  position?: 'bottom-right' | 'bottom-left' | 'top-right';
  /** 'end' (default) shows the panel when the spec finishes; 'live' updates it during the run. */
  show?: 'end' | 'live';
  /** Start minimized to the header. The viewer's own choice (minimize, close) is remembered after that. */
  startCollapsed?: boolean;
}

interface ModelTotals {
  calls: number;
  scored: number;
  passes: number;
  tokens: number;
  latencies: number[];
  costUsd: number | null;
}

interface LastCall {
  name?: string;
  latencyMs?: number;
  tokens?: number;
  costUsd?: number | null;
  pass?: boolean;
  at: number;
}

interface Totals {
  calls: number;
  passes: number;
  checks: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  costUsd: number;
  costKnown: boolean;
  latencies: number[];
  models: Map<string, ModelTotals>;
  last?: LastCall;
}

type ViewState = 'open' | 'collapsed' | 'closed';

const PANEL_ID = 'cypress-ai-vitals-panel';
const STATE_KEY = 'cypress-ai-vitals:panel-state';
const COLORS = ['#7c8cff', '#3cc48f', '#f5a524', '#a78bfa', '#22b8cf', '#f25f5c', '#ec4899', '#84cc16'];
/** How long the latest call stays highlighted. */
const HIGHLIGHT_MS = 6000;

function esc(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function fresh(): Totals {
  return { calls: 0, passes: 0, checks: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, costUsd: 0, costKnown: false, latencies: [], models: new Map() };
}

let totals = fresh();
let options: PanelOptions = {};
let enabled = false;
/** Set when the spec has finished, so the panel may appear in 'end' mode. */
let finished = false;
/**
 * The panel lives in the runner's window, but its click handlers belong to this spec frame. A re-run replaces the frame,
 * which leaves an old panel with dead buttons. Each frame tags the panel it builds, and removes any panel it did not build.
 */
const FRAME_ID = Math.random().toString(36).slice(2);
let highlightTimer: ReturnType<typeof setTimeout> | undefined;
/** Where this spec's full report is: a link in cypress open, a file path in cypress run. */
let report: { url: string | null; path: string | null } = { url: null, path: null };

/** Called when the spec ends, before the panel shows. */
export function setReportLink(link: { url: string | null; path: string | null } | null): void {
  report = link ?? { url: null, path: null };
}

/** The same percentile as the reports use, so the panel and the HTML report agree on p50 and p95. */
function percentile(values: number[], p: number): number | undefined {
  const value = sharedPercentile(values, p);
  return Number.isNaN(value) ? undefined : value;
}

function topWindow(): Window | undefined {
  try {
    return window.top ?? undefined;
  } catch {
    return undefined;
  }
}

function readState(): ViewState {
  try {
    const saved = topWindow()?.localStorage.getItem(STATE_KEY) as ViewState | null;
    if (saved === 'open' || saved === 'collapsed' || saved === 'closed') return saved;
  } catch {
    // storage blocked
  }
  return options.startCollapsed ? 'collapsed' : 'open';
}

function saveState(state: ViewState): void {
  try {
    topWindow()?.localStorage.setItem(STATE_KEY, state);
  } catch {
    // storage blocked; the panel still works for this session
  }
}

function specName(): string {
  try {
    return Cypress.spec?.relative ?? Cypress.spec?.name ?? '';
  } catch {
    return '';
  }
}

/** The numbers as a Markdown summary, for pasting into a PR, an issue or a chat. */
export function panelSummaryMarkdown(): string {
  const rate = totals.checks ? `${Math.round((totals.passes / totals.checks) * 100)}% (${totals.passes}/${totals.checks})` : 'n/a';
  const lines = [
    `**AI Vitals**${specName() ? ` for \`${specName()}\`` : ''}`,
    '',
    `- Calls: ${totals.calls}`,
    `- Accuracy: ${rate}`,
    `- Tokens: ${formatTokens(totals.inputTokens)} in, ${formatTokens(totals.outputTokens)} out${totals.reasoningTokens ? `, ${formatTokens(totals.reasoningTokens)} thinking` : ''}`,
    `- Latency: p50 ${formatMs(percentile(totals.latencies, 50))}, p95 ${formatMs(percentile(totals.latencies, 95))}`,
    `- Cost: ${totals.costKnown ? formatUsd(totals.costUsd) : 'n/a'} (list price)`,
  ];
  if (totals.models.size) {
    lines.push('', '| model | calls | accuracy | p95 | tokens | cost |', '|---|---|---|---|---|---|');
    for (const [name, m] of totals.models) {
      lines.push(`| ${name} | ${m.calls} | ${m.scored ? `${Math.round((m.passes / m.scored) * 100)}%` : 'n/a'} | ${formatMs(percentile(m.latencies, 95))} | ${formatTokens(m.tokens)} | ${formatUsd(m.costUsd)} |`);
    }
  }
  return `${lines.join('\n')}\n`;
}

async function copySummary(doc: Document): Promise<boolean> {
  const text = panelSummaryMarkdown();
  try {
    await topWindow()!.navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard API refused (focus or permissions): fall back to a hidden textarea.
    const area = doc.createElement('textarea');
    area.value = text;
    area.style.cssText = 'position:fixed;left:-9999px;top:0';
    doc.body.appendChild(area);
    area.select();
    const ok = doc.execCommand('copy');
    area.remove();
    return ok;
  }
}

const CSS = `
#${PANEL_ID}{position:fixed;z-index:2147483647;width:400px;max-width:calc(100vw - 24px);font:13px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;color:#e8eaf2;background:#131523;border:1px solid #343a5c;border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,.45);overflow:hidden}
#${PANEL_ID}.bottom-right{right:14px;bottom:14px}#${PANEL_ID}.bottom-left{left:14px;bottom:14px}#${PANEL_ID}.top-right{right:14px;top:56px}
#${PANEL_ID} .head{display:flex;align-items:center;gap:8px;padding:10px 12px;background:rgba(255,255,255,.03);border-bottom:1px solid #2b3050}
#${PANEL_ID} .title{font-weight:700;letter-spacing:.04em;color:#3cc48f;flex:1;display:flex;align-items:center;gap:8px;min-width:0;white-space:nowrap}
#${PANEL_ID} .title small{color:#8d93ad;font-weight:400;letter-spacing:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#${PANEL_ID} .pulse{width:8px;height:8px;border-radius:50%;background:#3cc48f;box-shadow:0 0 0 0 rgba(60,196,143,.6);animation:aiv-pulse 1.6s infinite;flex:none}
@keyframes aiv-pulse{to{box-shadow:0 0 0 8px rgba(60,196,143,0)}}
#${PANEL_ID} .actions{display:flex;gap:6px;flex:none}
#${PANEL_ID} button{all:unset;cursor:pointer;color:#c7cbe0;font-size:12px;line-height:18px;min-width:12px;text-align:center;padding:3px 8px;border-radius:7px;border:1px solid #343a5c}
#${PANEL_ID} button:hover{background:#262b47;color:#fff}
#${PANEL_ID} .body{padding:12px}
#${PANEL_ID} .tiles{display:grid;grid-template-columns:repeat(2,1fr);gap:8px}
#${PANEL_ID} .tile{background:#1c2036;border:1px solid #2b3050;border-radius:10px;padding:8px 10px}
#${PANEL_ID} .tile .k{display:block;color:#8d93ad;font-size:10.5px;letter-spacing:.08em;text-transform:uppercase}
#${PANEL_ID} .tile b{display:block;font:700 17px/1.25 ui-monospace,SFMono-Regular,Menlo,monospace;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#${PANEL_ID} .tile .s{color:#8d93ad;font-size:11.5px}
#${PANEL_ID} .ok{color:#3cc48f}#${PANEL_ID} .bad{color:#f25f5c}
#${PANEL_ID} .last{margin-top:10px;padding:7px 10px;border-radius:9px;background:#1c2036;color:#c7cbe0;font:12px ui-monospace,SFMono-Regular,Menlo,monospace;transition:background .6s,box-shadow .6s}
#${PANEL_ID} .last.fresh{background:#1f3a31;box-shadow:inset 0 0 0 1px #3cc48f}
#${PANEL_ID} table{margin-top:10px;border-collapse:collapse;width:100%;font:12px ui-monospace,SFMono-Regular,Menlo,monospace}
#${PANEL_ID} th{color:#8d93ad;font-weight:400;text-align:left;padding:3px 6px 3px 0;border-bottom:1px solid #2b3050}
#${PANEL_ID} td{padding:4px 6px 4px 0;text-align:left;white-space:nowrap}
#${PANEL_ID} td.name{max-width:140px;overflow:hidden;text-overflow:ellipsis}
#${PANEL_ID} .dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px}
#${PANEL_ID} .report{margin-top:8px;color:#8d93ad;font-size:11.5px;overflow-wrap:anywhere}#${PANEL_ID} .report code{color:#c7cbe0;font:11px ui-monospace,SFMono-Regular,Menlo,monospace}
#${PANEL_ID} .foot{margin-top:8px;color:#8d93ad;font-size:11.5px;min-height:15px}
#${PANEL_ID}.collapsed .body{display:none}
#${PANEL_ID}.closed{width:auto;border-radius:999px}
#${PANEL_ID}.closed .head{border:0;padding:7px 12px;cursor:pointer}
#${PANEL_ID}.closed .body,#${PANEL_ID}.closed .actions{display:none}
`;

function tile(label: string, value: string, sub: string, cls = ''): string {
  return `<div class="tile"><span class="k">${label}</span><b class="${cls}">${value}</b><span class="s">${sub}</span></div>`;
}

function render(): void {
  if (!enabled) return;
  let doc: Document | undefined;
  try {
    doc = window.top?.document;
  } catch {
    doc = undefined;
  }
  if (!doc?.body) return;
  if (!doc.getElementById(`${PANEL_ID}-style`)) {
    const style = doc.createElement('style');
    style.id = `${PANEL_ID}-style`;
    style.textContent = CSS;
    doc.head.appendChild(style);
  }
  let panel = doc.getElementById(PANEL_ID);
  if (panel && panel.dataset.frame !== FRAME_ID) {
    panel.remove();
    panel = null;
  }
  if (options.show !== 'live' && !finished) return;
  if (!panel) {
    panel = doc.createElement('div');
    panel.id = PANEL_ID;
    panel.dataset.frame = FRAME_ID;
    panel.dataset.state = readState();
    panel.addEventListener('click', async (e) => {
      const target = e.target as HTMLElement;
      const action = target.closest<HTMLElement>('[data-action]')?.dataset.action;
      const el = panel!;
      if (el.dataset.state === 'closed') {
        el.dataset.state = 'open';
      } else if (action === 'collapse') {
        el.dataset.state = el.dataset.state === 'collapsed' ? 'open' : 'collapsed';
      } else if (action === 'close') {
        el.dataset.state = 'closed';
      } else if (action === 'report') {
        if (report.url) topWindow()?.open(report.url, '_blank', 'noopener');
        return;
      } else if (action === 'copy') {
        const foot = el.querySelector('.foot');
        const ok = await copySummary(doc!);
        if (foot) foot.textContent = ok ? 'Copied as Markdown.' : 'Copy failed: the browser blocked the clipboard.';
        return;
      } else {
        return;
      }
      saveState(el.dataset.state as ViewState);
      render();
    });
    doc.body.appendChild(panel);
  }
  const state = (panel.dataset.state as ViewState) ?? 'open';
  panel.className = `${options.position ?? 'bottom-right'} ${state}`;
  const rate = totals.checks ? totals.passes / totals.checks : undefined;
  const colors = new Map([...totals.models.keys()].map((name, i) => [name, COLORS[i % COLORS.length]]));
  const rows = [...totals.models.entries()]
    .map(
      ([name, m]) =>
        `<tr><td class="name" title="${esc(name)}"><i class="dot" style="background:${colors.get(name)}"></i>${esc(name)}</td><td>${m.calls}</td><td class="${m.scored ? (m.passes === m.scored ? 'ok' : 'bad') : ''}">${m.scored ? `${Math.round((m.passes / m.scored) * 100)}%` : '–'}</td><td>${formatMs(percentile(m.latencies, 95))}</td><td>${formatTokens(m.tokens)}</td><td>${formatUsd(m.costUsd)}</td></tr>`,
    )
    .join('');
  const last = totals.last;
  const isFresh = !!last && Date.now() - last.at < HIGHLIGHT_MS;
  const lastLine = last
    ? `${last.pass === undefined ? '•' : last.pass ? '<span class="ok">✓</span>' : '<span class="bad">✗</span>'} ${esc(last.name ?? 'check')}${last.latencyMs !== undefined ? ` · ${formatMs(last.latencyMs)}` : ''}${last.tokens ? ` · ${formatTokens(last.tokens)} tok` : ''}${typeof last.costUsd === 'number' ? ` · ${formatUsd(last.costUsd)}` : ''}`
    : 'Waiting for the first AI call…';
  const spec = specName();
  panel.innerHTML = `
    <div class="head" ${state === 'closed' ? 'title="Show AI Vitals"' : ''}>
      <span class="title"><i class="pulse"></i>AI VITALS${state === 'closed' ? ` <small>${totals.calls} calls</small>` : spec ? ` <small title="${esc(spec)}">${esc(spec)}</small>` : ''}</span>
      <span class="actions">
        ${report.url ? '<button type="button" data-action="report" title="Open the full report in a new tab">Report</button>' : ''}
        <button type="button" data-action="copy" title="Copy these numbers as Markdown">Copy</button>
        <button type="button" data-action="collapse" title="${state === 'collapsed' ? 'Expand' : 'Minimize'}">${state === 'collapsed' ? '+' : '−'}</button>
        <button type="button" data-action="close" title="Close (click the pill to reopen)">✕</button>
      </span>
    </div>
    <div class="body">
      <div class="tiles">
        ${tile('Accuracy', rate === undefined ? 'n/a' : `${Math.round(rate * 100)}%`, rate === undefined ? 'no checks yet' : `${totals.passes} of ${totals.checks} checks`, rate === undefined ? '' : rate >= 0.8 ? 'ok' : 'bad')}
        ${tile('Calls', String(totals.calls), `${totals.models.size} model${totals.models.size === 1 ? '' : 's'}`)}
        ${tile('Tokens', formatTokens(totals.inputTokens + totals.outputTokens), `${formatTokens(totals.inputTokens)} in · ${formatTokens(totals.outputTokens)} out${totals.reasoningTokens ? ` · ${formatTokens(totals.reasoningTokens)} thinking` : ''}`)}
        ${tile('Cost', totals.costKnown ? formatUsd(totals.costUsd) : 'n/a', `p50 ${formatMs(percentile(totals.latencies, 50))} · p95 ${formatMs(percentile(totals.latencies, 95))}`)}
      </div>
      <div class="last${isFresh ? ' fresh' : ''}">${lastLine}</div>
      ${rows ? `<table><tr><th>model</th><th>calls</th><th>acc</th><th>p95</th><th>tok</th><th>$</th></tr>${rows}</table>` : ''}
      ${!report.url && report.path ? `<div class="report">Full report: <code>${esc(report.path)}</code></div>` : ''}
      <div class="foot"></div>
    </div>`;
  if (isFresh) {
    clearTimeout(highlightTimer);
    highlightTimer = setTimeout(render, HIGHLIGHT_MS);
  }
}

export function enablePanel(opts: PanelOptions = {}): void {
  enabled = true;
  options = opts;
  // A re-run or a new spec starts here: take down the previous run's panel straight away.
  removePanel();
}

/** Removes the panel from the runner window, if it is there. */
export function removePanel(): void {
  try {
    window.top?.document.getElementById(PANEL_ID)?.remove();
  } catch {
    // cross-origin top window; nothing to remove
  }
}

/** Called before the spec's first test: clear the totals and any old panel. */
export function resetPanel(): void {
  totals = fresh();
  report = { url: null, path: null };
  finished = false;
  removePanel();
  render();
}

/** Called after the spec's last test: show the finished numbers. */
export function showPanel(): void {
  finished = true;
  render();
}

/** Adds one model call and/or one scored result to the running totals. */
export function track(pass: boolean | undefined, vitals?: Vitals, modelName?: string): void {
  if (pass !== undefined) {
    totals.checks++;
    if (pass) totals.passes++;
  }
  const called = !!vitals && (!!vitals.usage || vitals.latencyMs !== undefined);
  if (called) {
    totals.calls++;
    totals.inputTokens += vitals.usage?.inputTokens ?? 0;
    totals.outputTokens += vitals.usage?.outputTokens ?? 0;
    totals.reasoningTokens += vitals.usage?.reasoningTokens ?? 0;
    if (vitals.latencyMs !== undefined) totals.latencies.push(vitals.latencyMs);
    if (typeof vitals.costUsd === 'number') {
      totals.costUsd += vitals.costUsd;
      totals.costKnown = true;
    }
  }
  const name = modelName ?? vitals?.model;
  if (name) {
    const m = totals.models.get(name) ?? { calls: 0, scored: 0, passes: 0, tokens: 0, latencies: [], costUsd: null };
    if (called) {
      m.calls++;
      m.tokens += vitals.usage?.totalTokens ?? 0;
      if (vitals.latencyMs !== undefined) m.latencies.push(vitals.latencyMs);
      if (typeof vitals.costUsd === 'number') m.costUsd = (m.costUsd ?? 0) + vitals.costUsd;
    }
    if (pass !== undefined) {
      m.scored++;
      if (pass) m.passes++;
    }
    totals.models.set(name, m);
  }
  if (called) {
    totals.last = { name, latencyMs: vitals.latencyMs, tokens: vitals.usage?.totalTokens, costUsd: vitals.costUsd, pass, at: Date.now() };
  } else if (pass !== undefined) {
    // A check right after its model call completes that call's line instead of replacing it.
    totals.last = totals.last && totals.last.name === name && totals.last.pass === undefined ? { ...totals.last, pass, at: Date.now() } : { name, pass, at: Date.now() };
  }
  render();
}
