import type { Provider } from '../providers/types';

const KEY = Symbol.for('cypress-ai-vitals.custom-providers');

/**
 * Providers registered with defineProvider(). Kept on globalThis so the ESM and CommonJS builds of
 * `cypress-ai-vitals/plugin` and `cypress-ai-vitals/providers` share one list.
 */
export function customProviders(): Map<string, Provider> {
  const g = globalThis as unknown as Record<symbol, Map<string, Provider> | undefined>;
  g[KEY] ??= new Map();
  return g[KEY];
}
