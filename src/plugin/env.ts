import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';

export const DEFAULT_ENV_FILES = ['ai.env', '.env'];

/**
 * Reads ai.env (then .env) from the project root without touching process.env.
 * Real environment variables win, so CI can inject secrets without a file.
 */
export function loadAiEnv(projectRoot: string, envFile?: string): Record<string, string> {
  const files = envFile ? [envFile] : DEFAULT_ENV_FILES;
  const fromFiles: Record<string, string> = {};
  for (const file of files) {
    const full = path.resolve(projectRoot, file);
    if (!existsSync(full)) continue;
    const text = readFileSync(full, 'utf8');
    const parsed = parseEnv(text);
    // parseEnv returns keys sorted; keep the file's order so models list in the order they are written.
    const written = [...text.matchAll(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/gm)].map((m) => m[1]);
    for (const key of new Set([...written, ...Object.keys(parsed)])) {
      const value = parsed[key];
      if (value !== undefined && !(key in fromFiles)) fromFiles[key] = value;
    }
  }
  const fromProcess = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[1] !== ''),
  );
  return { ...fromFiles, ...fromProcess };
}

export function mask(secret: string | undefined): string {
  if (!secret) return '(not set)';
  return `set (${secret.length} chars)`;
}
