import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { BrandSpec, CheckResult, ImageSpec } from '../shared/types';
import { clipEmbed, cosine } from '../plugin/ml';
import { judgeCheck, type JudgeGenerate } from './judge';
import { coverage, dominantColors } from './palette';
import { runCustom, type ScorerContext } from './registry';

export const IMAGE_DEFAULTS = { depictsMargin: 0.2, tolerance: 12, minCoverage: 0.05, maxForbidden: 0.05 };

/** Generic captions the prompt must also beat, so a blank or broken image cannot pass by default. */
export const DISTRACTORS = ['a blank image', 'random noise', 'a screenshot of text', 'a black square'];

export interface ImageScoringDeps extends ScorerContext {
  generate: JudgeGenerate;
  defaultJudge?: string;
}

async function sharpLib() {
  try {
    return (await import('sharp')).default;
  } catch {
    throw new Error('Image checks need sharp, which comes with @huggingface/transformers: npm i -D @huggingface/transformers');
  }
}

function softmax(values: number[], scale = 100): number[] {
  const scaled = values.map((v) => v * scale);
  const max = Math.max(...scaled);
  const exps = scaled.map((v) => Math.exp(v - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map((e) => e / sum);
}

async function loadBrand(brand: ImageSpec['brand'], ctx: ScorerContext): Promise<BrandSpec | undefined> {
  if (!brand) return undefined;
  if ('fixture' in brand && typeof brand.fixture === 'string') {
    return JSON.parse(await readFile(path.resolve(ctx.fixturesFolder, brand.fixture), 'utf8')) as BrandSpec;
  }
  return brand as BrandSpec;
}

const refEmbeddings = new Map<string, number[]>();

async function refEmbedding(file: string, ctx: ScorerContext): Promise<number[]> {
  const full = path.resolve(ctx.fixturesFolder, file);
  if (!refEmbeddings.has(full)) refEmbeddings.set(full, (await clipEmbed(await readFile(full), [])).image);
  return refEmbeddings.get(full)!;
}

export async function scoreImage(image: Buffer, mime: string, spec: ImageSpec, deps: ImageScoringDeps): Promise<CheckResult[]> {
  const checks: CheckResult[] = [];
  const sharp = await sharpLib();
  const brand = await loadBrand(spec.brand, deps);
  const margin = spec.thresholds?.depictsMargin ?? IMAGE_DEFAULTS.depictsMargin;

  if (spec.notDepicts?.length && !spec.depicts) {
    checks.push({ name: 'notDepicts', pass: false, detail: 'notDepicts needs depicts: CLIP ranks the captions against each other' });
  }

  if (spec.depicts || brand?.onBrand?.length) {
    const captions = spec.depicts ? [spec.depicts, ...(spec.notDepicts ?? []), ...DISTRACTORS] : [];
    const { image: imageEmbed, texts } = await clipEmbed(image, captions);
    if (spec.depicts) {
      const probs = softmax(texts.map((t) => cosine(imageEmbed, t)));
      const best = probs[0];
      const runnerUp = Math.max(...probs.slice(1));
      const runnerUpCaption = captions[probs.indexOf(runnerUp)];
      checks.push({
        name: 'depicts',
        pass: best - runnerUp >= margin,
        score: best,
        threshold: margin,
        detail: `beats "${runnerUpCaption}" by ${(best - runnerUp).toFixed(2)}`,
      });
      for (const [i, caption] of (spec.notDepicts ?? []).entries()) {
        const p = probs[i + 1];
        checks.push({ name: `notDepicts`, pass: p < best && p < 0.3, score: p, detail: `"${caption}"` });
      }
    }
    if (brand?.onBrand?.length) {
      const on = await Promise.all(brand.onBrand.map((f) => refEmbedding(f, deps)));
      const off = await Promise.all((brand.offBrand ?? []).map((f) => refEmbedding(f, deps)));
      const avg = (refs: number[][]) => (refs.length ? refs.reduce((s, r) => s + cosine(imageEmbed, r), 0) / refs.length : 0);
      const onScore = avg(on);
      const offScore = avg(off);
      checks.push({
        name: 'styleLike',
        pass: off.length ? onScore > offScore : onScore >= 0.7,
        score: onScore - offScore,
        detail: `on-brand ${onScore.toFixed(2)} vs off-brand ${offScore.toFixed(2)}`,
      });
    }
  }

  if (brand?.palette?.length || brand?.forbidden?.length) {
    const { data } = await sharp(image).resize(64, 64, { fit: 'fill' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const tolerance = brand.tolerance ?? IMAGE_DEFAULTS.tolerance;
    const swatches = dominantColors(data, 5)
      .map((s) => `${s.hex} ${(s.share * 100).toFixed(0)}%`)
      .join(', ');
    for (const color of brand.palette ?? []) {
      const share = coverage(data, color.hex, tolerance);
      const min = color.minCoverage ?? IMAGE_DEFAULTS.minCoverage;
      checks.push({ name: `palette ${color.hex}`, pass: share >= min, score: share, threshold: min, detail: `dominant: ${swatches}` });
    }
    for (const color of brand.forbidden ?? []) {
      const share = coverage(data, color.hex, tolerance);
      const max = color.maxCoverage ?? IMAGE_DEFAULTS.maxForbidden;
      checks.push({ name: `forbidden ${color.hex}`, pass: share <= max, score: share, threshold: max });
    }
  }

  if (spec.dimensions) {
    const meta = await sharp(image).metadata();
    const d = spec.dimensions;
    const w = meta.width ?? 0;
    const h = meta.height ?? 0;
    const ok =
      (d.width === undefined || w === d.width) &&
      (d.height === undefined || h === d.height) &&
      (d.minWidth === undefined || w >= d.minWidth) &&
      (d.minHeight === undefined || h >= d.minHeight);
    checks.push({ name: 'dimensions', pass: ok, detail: `${w}x${h}` });
  }

  if (spec.judge) {
    checks.push(await judgeCheck(deps.generate, spec.judge, deps.defaultJudge, { image: { data: image, mime } }));
  }
  checks.push(...(await runCustom('image', image, spec.custom, deps)));
  return checks;
}
