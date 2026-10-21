import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ResultRecord } from '../../shared/types';
import { renderHtml } from './html';

export interface SpecRunInfo {
  spec: string;
  /** Cypress results for the spec, when available. */
  tests?: { total: number; passed: number; failed: number; pending: number; durationMs?: number };
  video?: string | null;
  screenshots?: string[];
}

const REPORT = /^report-(\d+)\.html$/;

function esc(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** Folder for one spec's reports: cypress/e2e/text/01-single.cy.ts → <root>/text/01-single.cy.ts */
export function specReportDir(reportsDir: string, specRelative: string): string {
  const trimmed = specRelative.replace(/^cypress\/e2e\//, '');
  return path.join(reportsDir, trimmed);
}

/**
 * Writes report-NNN.html for this spec run (numbering continues across runs), refreshes latest.html,
 * prunes old reports beyond `keep`, and rebuilds the index of every spec. Returns the new report path.
 */
export function writeSpecReport(reportsDir: string, info: SpecRunInfo, records: ResultRecord[], keep = 10): string {
  const dir = specReportDir(reportsDir, info.spec);
  mkdirSync(dir, { recursive: true });
  const existing = readdirSync(dir)
    .map((f) => REPORT.exec(f))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => Number(m[1]));
  const next = (existing.length ? Math.max(...existing) : 0) + 1;
  const id = `report-${String(next).padStart(3, '0')}`;
  const file = path.join(dir, `${id}.html`);
  // Cypress deletes its videos and screenshots before each `cypress run`, so keep copies with the report.
  const keepCopy = (source: string, name: string): string | undefined => {
    if (!existsSync(source)) return undefined;
    copyFileSync(source, path.join(dir, name));
    return name;
  };
  const video = info.video ? keepCopy(info.video, `${id}${path.extname(info.video)}`) : undefined;
  const shots = (info.screenshots ?? []).map((s, i) => keepCopy(s, `${id}-screenshot-${i + 1}${path.extname(s)}`)).filter((s): s is string => !!s);
  const t = info.tests;
  const links = [video ? `<a href="${esc(video)}">video</a>` : '', ...shots.map((s, i) => `<a href="${esc(s)}">screenshot ${i + 1}</a>`)].filter(Boolean);
  writeFileSync(
    file,
    renderHtml(records, new Date(), {
      title: info.spec,
      subtitle: [
        `run #${next}`,
        t ? `${t.passed}/${t.total} tests passed${t.failed ? `, ${t.failed} failed` : ''}${t.pending ? `, ${t.pending} pending` : ''}` : '',
        t?.durationMs !== undefined ? `${(t.durationMs / 1000).toFixed(1)}s` : '',
      ]
        .filter(Boolean)
        .join(' · '),
      linksHtml: links.join(' · '),
      emptyText: 'This spec ran no AI checks. Its test results and video are linked above.',
    }),
  );
  copyFileSync(file, path.join(dir, 'latest.html'));
  const all = readdirSync(dir)
    .filter((f) => REPORT.test(f))
    .sort();
  for (const old of all.slice(0, Math.max(0, all.length - keep))) {
    const prefix = old.replace(/\.html$/, '');
    for (const f of readdirSync(dir)) if (f === old || f.startsWith(`${prefix}.`) || f.startsWith(`${prefix}-screenshot-`)) rmSync(path.join(dir, f));
  }
  writeIndex(reportsDir);
  return file;
}

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return existsSync(path.join(full, 'latest.html')) ? [full, ...walk(full)] : walk(full);
    return [];
  });
}

/** index.html: every spec with its latest report and history, newest first. */
export function writeIndex(reportsDir: string): void {
  const specs = walk(reportsDir)
    .map((dir) => {
      const reports = readdirSync(dir)
        .filter((f) => REPORT.test(f))
        .sort()
        .reverse();
      return { dir, name: path.relative(reportsDir, dir), reports, updated: statSync(path.join(dir, 'latest.html')).mtime };
    })
    .sort((a, b) => b.updated.getTime() - a.updated.getTime());
  const rows = specs
    .map(
      (s) => `<tr><th scope="row"><a href="${esc(path.join(s.name, 'latest.html'))}">${esc(s.name)}</a></th>
      <td>${esc(s.updated.toLocaleString())}</td>
      <td>${s.reports.map((r) => `<a href="${esc(path.join(s.name, r))}">#${Number(REPORT.exec(r)![1])}</a>`).join(' ')}</td></tr>`,
    )
    .join('');
  writeFileSync(
    path.join(reportsDir, 'index.html'),
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>AI Vitals reports</title>
<style>:root{--bg:#f6f7fb;--card:#fff;--text:#161827;--muted:#5b6178;--line:#e3e5ee;--accent:#4f5be8;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#11131f;--card:#1a1d2e;--text:#e8eaf2;--muted:#9aa0b8;--line:#2c3046;--accent:#8b93ff;color-scheme:dark}}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,sans-serif;padding-inline:16px}main{max-width:1000px;margin:0 auto;padding-block:32px}
h1{margin:0 0 4px}p{color:var(--muted)}table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden}
th,td{text-align:left;padding:10px 12px;border-bottom:1px solid var(--line)}a{color:var(--accent)}td a{margin-right:8px;font-variant-numeric:tabular-nums}</style></head>
<body><main><h1>AI Vitals reports</h1><p>One folder per spec. Every run adds a numbered report; latest.html is always the newest.</p>
<table><thead><tr><th>spec</th><th>last run</th><th>history</th></tr></thead><tbody>${rows || '<tr><td colspan="3">No reports yet.</td></tr>'}</tbody></table></main></body></html>`,
  );
}
