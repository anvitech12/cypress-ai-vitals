export function mean(values: number[]): number {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

/** Linear-interpolated percentile, p in [0, 100]. */
export function percentile(values: number[], p: number): number {
  if (!values.length) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const pos = ((s.length - 1) * p) / 100;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

function seeded(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}

/** Percentile bootstrap confidence interval for the mean. Seeded, so reports are reproducible. */
export function bootstrapCi(values: number[], level = 0.95, resamples = 2000, seed = 42): [number, number] {
  if (values.length === 0) return [NaN, NaN];
  if (values.length === 1) return [values[0], values[0]];
  const rand = seeded(seed);
  const means: number[] = [];
  for (let r = 0; r < resamples; r++) {
    let sum = 0;
    for (let i = 0; i < values.length; i++) sum += values[Math.floor(rand() * values.length)];
    means.push(sum / values.length);
  }
  const alpha = (1 - level) / 2;
  return [percentile(means, alpha * 100), percentile(means, (1 - alpha) * 100)];
}

export function passRate(passes: boolean[]): number {
  return passes.length ? passes.filter(Boolean).length / passes.length : 0;
}
