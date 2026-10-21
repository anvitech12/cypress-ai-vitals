import { ProviderError } from './types';

/** Status codes worth retrying: rate limits and transient provider overload. */
export const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

/** A spent daily allowance will not come back in a few seconds, so these fail fast instead of retrying. */
const DAILY_LIMIT = /daily (free )?allocation|daily quota|ZeroGPU quota/i;

/** Waits longer than this are not worth holding a test for; the call fails with the provider's message instead. */
const MAX_WAIT_MS = 65_000;

function delayFor(err: ProviderError, attempt: number): number {
  const hint =
    /"retry[-_]after"?\s*[:=]\s*"?(\d+(?:\.\d+)?)/i.exec(err.body ?? '') ??
    /try again in (\d+(?:\.\d+)?)s/i.exec(err.body ?? '') ??
    /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/i.exec(err.body ?? '');
  return hint ? Math.ceil(Number(hint[1]) * 1000) : 1500 * 2 ** attempt;
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
