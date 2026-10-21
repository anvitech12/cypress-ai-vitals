import { ProviderError } from './types';

/** Status codes worth retrying: rate limits and transient provider overload. */
export const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

/** A spent daily allowance will not come back in a few seconds, so these fail fast instead of retrying. */
const DAILY_LIMIT = /daily (free )?allocation|daily quota|ZeroGPU quota/i;

/** Waits longer than this are not worth holding a test for; the call fails with the provider's message instead. */
const MAX_WAIT_MS = 65_000;

/** Parses a wait written like "20s", "1m2.5s", "14m20s", "2h3m" or "500ms" into milliseconds. */
export function parseWait(text: string): number | undefined {
  const m = /^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m(?!s))?(?:(\d+(?:\.\d+)?)s)?(?:(\d+(?:\.\d+)?)ms)?$/.exec(text.trim());
  if (!m || !m.slice(1).some(Boolean)) return undefined;
  const [h, min, s, ms] = m.slice(1).map((v) => Number(v ?? 0));
  return Math.ceil(h * 3_600_000 + min * 60_000 + s * 1000 + ms);
}

function delayFor(err: ProviderError, attempt: number): number {
  if (err.retryAfterMs !== undefined) return Math.ceil(err.retryAfterMs);
  const body = err.body ?? '';
  const seconds = /"retry[-_]after"?\s*[:=]\s*"?(\d+(?:\.\d+)?)/i.exec(body);
  if (seconds) return Math.ceil(Number(seconds[1]) * 1000);
  const written = /try again in ((?:\d+(?:\.\d+)?(?:ms|h|m|s))+)/i.exec(body) ?? /"retryDelay"\s*:\s*"([^"]+)"/i.exec(body);
  const wait = written ? parseWait(written[1]) : undefined;
  return wait ?? 1500 * 2 ** attempt;
}

/** Retries rate limits (429) and overloads (5xx) with backoff, honouring the provider's retry hint. */
export async function withRetry<T>(fn: () => Promise<T>, retries = 3, onRetry?: (err: ProviderError, waitMs: number) => void): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof ProviderError) || !RETRYABLE_STATUS.has(err.status ?? 0) || attempt >= retries) throw err;
      if (DAILY_LIMIT.test(`${err.message} ${err.body ?? ''}`)) throw err;
      const wait = delayFor(err, attempt);
      if (wait > MAX_WAIT_MS) {
        err.message += ` (the provider asks to wait ${wait >= 5_400_000 ? `${(wait / 3_600_000).toFixed(1)} h` : `${Math.ceil(wait / 60_000)} min`})`;
        throw err;
      }
      onRetry?.(err, wait);
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}
