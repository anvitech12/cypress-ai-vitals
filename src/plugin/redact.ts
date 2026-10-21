import type { ModelConfig } from './registry';

/** Env names whose values are secrets, e.g. GROQ_API_KEY, CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, HF_TOKEN. */
const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|ACCOUNT_ID)$/i;

/** Every secret value we know about: env entries with secret-looking names, plus each model's API key. */
export function secretValues(env: Record<string, string>, models: Iterable<ModelConfig> = []): string[] {
  const values = new Set<string>();
  for (const [name, value] of Object.entries(env)) if (SECRET_NAME.test(name) && value && value.length >= 8) values.add(value);
  for (const m of models) if (m.apiKey && m.apiKey.length >= 8) values.add(m.apiKey);
  return [...values].sort((a, b) => b.length - a.length);
}

/** Returns a copy of a value with every known secret replaced in every string, at any depth of plain objects and arrays. */
export function redactDeep<T>(value: T, redact: (text: string) => string): T {
  if (typeof value === 'string') return redact(value) as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, redact)) as T;
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v, redact)])) as T;
  }
  return value;
}

/** Returns a function that replaces every known secret in a string with [redacted]. */
export function makeRedactor(values: string[]): (text: string) => string {
  if (!values.length) return (text) => text;
  return (text) => values.reduce((out, secret) => out.split(secret).join('[redacted]'), text);
}
