import { describe, expect, it } from 'vitest';
import { coverage, deltaE2000, dominantColors, hexToRgb, rgbToLab } from '../src/scorers/palette';
import { bootstrapCi, percentile } from '../src/plugin/stats';

describe('deltaE2000', () => {
  it('matches published reference pairs (Sharma et al. 2005)', () => {
    expect(deltaE2000([50, 2.6772, -79.7751], [50, 0, -82.7485])).toBeCloseTo(2.0425, 3);
    expect(deltaE2000([50, -1.3802, -84.2814], [50, 0, -82.7485])).toBeCloseTo(1.0, 3);
    expect(deltaE2000([50, 2.5, 0], [56, -27, -3])).toBeCloseTo(31.903, 2);
  });

  it('is 0 for identical colours and large for red vs blue', () => {
    const red = rgbToLab(hexToRgb('#e53935'));
    expect(deltaE2000(red, red)).toBe(0);
    expect(deltaE2000(red, rgbToLab(hexToRgb('#1e40af')))).toBeGreaterThan(40);
  });
});

describe('dominantColors and coverage', () => {
  const pixels = (spec: Array<[string, number]>) => {
    const out: number[] = [];
    for (const [hex, count] of spec) for (let i = 0; i < count; i++) out.push(...hexToRgb(hex));
    return Uint8Array.from(out);
  };

  it('finds the main colours with their shares', () => {
    const img = pixels([['#ff6600', 700], ['#ffffff', 300]]);
    const swatches = dominantColors(img, 3);
    expect(swatches[0].hex).toBe('#ff6600');
    expect(swatches[0].share).toBeCloseTo(0.7, 2);
  });

  it('counts near-brand shades within tolerance', () => {
    const img = pixels([['#ff6a05', 500], ['#0000ff', 500]]);
    expect(coverage(img, '#ff6600', 12)).toBeCloseTo(0.5, 2);
    expect(coverage(img, '#00ff00', 12)).toBe(0);
  });
});

describe('stats', () => {
  it('computes percentiles', () => {
    expect(percentile([1, 2, 3, 4, 5], 50)).toBe(3);
    expect(percentile([100, 200], 95)).toBe(195);
  });

  it('gives a reproducible bootstrap interval around the mean', () => {
    const values = [1, 1, 1, 0, 1, 1, 0, 1, 1, 1];
    const [lo, hi] = bootstrapCi(values);
    expect(lo).toBeLessThan(0.8);
    expect(hi).toBeGreaterThan(0.8);
    expect(bootstrapCi(values)).toEqual([lo, hi]);
  });
});

describe('gates in reports', async () => {
  const { gatesCell, latestGates, summarizeModel } = await import('../src/plugin/summary');
  const record = (ts: string, pass: boolean, gates?: { accuracy?: number }) =>
    ({ ts, spec: 's', test: 't', command: 'aiCompare', model: 'm', pass, checks: [{ name: 'exactAnswer', pass, score: pass ? 1 : 0 }], gates }) as never;

  it('shows a dash when no gates were set', () => {
    expect(gatesCell(summarizeModel('m', [record('2026-10-06T00:00:00Z', true)]))).toBe('–');
  });

  it('uses the newest gates, so an older run without gates cannot hide a failure', () => {
    const records = [record('2026-10-05T00:00:00Z', false), record('2026-10-06T00:00:00Z', false, { accuracy: 0.8 })];
    expect(latestGates(records)).toEqual({ accuracy: 0.8 });
    expect(gatesCell(summarizeModel('m', records, latestGates(records)))).toMatch(/^✗ accuracy 0% < 80%/);
  });
});

describe('accuracy vs cost chart', async () => {
  const { renderHtml } = await import('../src/plugin/report/html');
  it('never overlaps model labels, even when every model scores the same', () => {
    const names = ['mistral-small', 'llama-4-scout', 'gpt-oss-20b', 'gemma-4', 'gpt-oss-120b'];
    // The real run that showed the bug: gpt-oss-20b missed 1 of 16, so its dot sat just below and right of llama-4-scout's.
    const costs = [0.00173, 0.00274, 0.00316, 0.00536, 0.00741];
    const records = names.flatMap((model, i) =>
      Array.from({ length: 16 }, (_, k) => k).map((k) => {
        const pass = !(model === 'gpt-oss-20b' && k === 0);
        return { ts: `2026-10-07T00:00:${String(k).padStart(2, '0')}Z`, spec: 's', test: 't', command: 'aiCompare', label: 'arena', model, pass, checks: [{ name: 'exactAnswer', pass, score: pass ? 1 : 0 }], vitals: { model, costUsd: costs[i], latencyMs: 100 } };
      }),
    ) as never[];
    const html = renderHtml(records);
    const boxes = [...html.matchAll(/<text x="([\d.]+)" text-anchor="(start|end)" y="([\d.]+)" class="point">([^<]+)<\/text>/g)].map((m) => {
      const x = Number(m[1]);
      const w = m[4].length * 7.4;
      return { x1: m[2] === 'end' ? x - w : x, x2: m[2] === 'end' ? x : x + w, y1: Number(m[3]) - 12, y2: Number(m[3]) + 3 };
    });
    expect(boxes).toHaveLength(names.length);
    const dots = [...html.matchAll(/<circle cx="([\d.]+)" cy="([\d.]+)" r="7"/g)].map((m) => ({ x1: Number(m[1]) - 7, x2: Number(m[1]) + 7, y1: Number(m[2]) - 7, y2: Number(m[2]) + 7 }));
    for (const box of boxes) for (const dot of dots) expect(box.x1 < dot.x2 && box.x2 > dot.x1 && box.y1 < dot.y2 && box.y2 > dot.y1, 'a label covers a dot').toBe(false);
    for (let a = 0; a < boxes.length; a++)
      for (let b = a + 1; b < boxes.length; b++) {
        const A = boxes[a];
        const B = boxes[b];
        expect(A.x1 < B.x2 && A.x2 > B.x1 && A.y1 < B.y2 && A.y2 > B.y1, `labels ${a} and ${b} overlap`).toBe(false);
      }
  });
});
