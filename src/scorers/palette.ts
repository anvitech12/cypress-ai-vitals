export type Rgb = [number, number, number];
export type Lab = [number, number, number];

export function hexToRgb(hex: string): Rgb {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex([r, g, b]: Rgb): string {
  return `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
}

export function rgbToLab([r, g, b]: Rgb): Lab {
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const [R, G, B] = [lin(r), lin(g), lin(b)];
  const x = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
  const y = R * 0.2126 + G * 0.7152 + B * 0.0722;
  const z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

/** CIEDE2000 colour difference. Around 2 is barely visible; above 10 reads as a different colour. */
export function deltaE2000(lab1: Lab, lab2: Lab): number {
  const [L1, a1, b1] = lab1;
  const [L2, a2, b2] = lab2;
  const rad = Math.PI / 180;
  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const Cbar = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cbar ** 7 / (Cbar ** 7 + 25 ** 7)));
  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1);
  const C2p = Math.hypot(a2p, b2);
  const h = (a: number, b: number) => {
    if (a === 0 && b === 0) return 0;
    const deg = Math.atan2(b, a) / rad;
    return deg >= 0 ? deg : deg + 360;
  };
  const h1p = h(a1p, b1);
  const h2p = h(a2p, b2);
  const dLp = L2 - L1;
  const dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp / 2) * rad);
  const Lbar = (L1 + L2) / 2;
  const Cbarp = (C1p + C2p) / 2;
  let hbar = h1p + h2p;
  if (C1p * C2p !== 0) {
    if (Math.abs(h1p - h2p) > 180) hbar = h1p + h2p < 360 ? (h1p + h2p + 360) / 2 : (h1p + h2p - 360) / 2;
    else hbar = (h1p + h2p) / 2;
  }
  const T =
    1 -
    0.17 * Math.cos((hbar - 30) * rad) +
    0.24 * Math.cos(2 * hbar * rad) +
    0.32 * Math.cos((3 * hbar + 6) * rad) -
    0.2 * Math.cos((4 * hbar - 63) * rad);
  const dTheta = 30 * Math.exp(-(((hbar - 275) / 25) ** 2));
  const Rc = 2 * Math.sqrt(Cbarp ** 7 / (Cbarp ** 7 + 25 ** 7));
  const Sl = 1 + (0.015 * (Lbar - 50) ** 2) / Math.sqrt(20 + (Lbar - 50) ** 2);
  const Sc = 1 + 0.045 * Cbarp;
  const Sh = 1 + 0.015 * Cbarp * T;
  const Rt = -Math.sin(2 * dTheta * rad) * Rc;
  return Math.sqrt((dLp / Sl) ** 2 + (dCp / Sc) ** 2 + (dHp / Sh) ** 2 + Rt * (dCp / Sc) * (dHp / Sh));
}

export interface Swatch {
  hex: string;
  lab: Lab;
  share: number;
}

/** Deterministic k-means in Lab space over raw RGB pixels. Returns swatches sorted by share. */
export function dominantColors(rgb: Uint8Array | Buffer, k = 6, iterations = 12): Swatch[] {
  const pixels: Lab[] = [];
  const raw: Rgb[] = [];
  for (let i = 0; i + 2 < rgb.length; i += 3) {
    const px: Rgb = [rgb[i], rgb[i + 1], rgb[i + 2]];
    raw.push(px);
    pixels.push(rgbToLab(px));
  }
  if (pixels.length === 0) return [];
  // Spread the initial centroids along the lightness-sorted pixels so results are reproducible.
  const order = pixels.map((_, i) => i).sort((a, b) => pixels[a][0] - pixels[b][0]);
  let centroids: Lab[] = Array.from({ length: Math.min(k, pixels.length) }, (_, c) => pixels[order[Math.floor(((c + 0.5) * order.length) / k)]]);
  const assign = new Array<number>(pixels.length).fill(0);
  for (let it = 0; it < iterations; it++) {
    pixels.forEach((p, i) => {
      let best = 0;
      let bestD = Infinity;
      centroids.forEach((c, j) => {
        const d = (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2 + (p[2] - c[2]) ** 2;
        if (d < bestD) {
          bestD = d;
          best = j;
        }
      });
      assign[i] = best;
    });
    centroids = centroids.map((c, j) => {
      let n = 0;
      const sum: Lab = [0, 0, 0];
      pixels.forEach((p, i) => {
        if (assign[i] !== j) return;
        n++;
        sum[0] += p[0];
        sum[1] += p[1];
        sum[2] += p[2];
      });
      return n ? [sum[0] / n, sum[1] / n, sum[2] / n] : c;
    });
  }
  return centroids
    .map((c, j) => {
      const members = raw.filter((_, i) => assign[i] === j);
      const mean: Rgb = members.length
        ? [0, 1, 2].map((ch) => members.reduce((s, m) => s + m[ch], 0) / members.length) as Rgb
        : [0, 0, 0];
      return { hex: rgbToHex(mean), lab: c, share: members.length / pixels.length };
    })
    .filter((s) => s.share > 0)
    .sort((a, b) => b.share - a.share);
}

/** Share of pixels whose colour is within `tolerance` (CIEDE2000) of `hex`. */
export function coverage(rgb: Uint8Array | Buffer, hex: string, tolerance: number): number {
  const target = rgbToLab(hexToRgb(hex));
  let hits = 0;
  let total = 0;
  for (let i = 0; i + 2 < rgb.length; i += 3) {
    total++;
    if (deltaE2000(rgbToLab([rgb[i], rgb[i + 1], rgb[i + 2]]), target) <= tolerance) hits++;
  }
  return total ? hits / total : 0;
}
