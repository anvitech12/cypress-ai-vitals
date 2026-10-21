import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';

export const DEFAULT_ENV_FILES = ['ai.env'];

/**
 * Reads ai.env, or the files you name, from the project root without touching process.env.
 * Other files such as your app's .env are read only when named, so the plugin never picks up the app's keys by accident.
 * Real environment variables win, so CI can inject secrets without a file.
 */
export function loadAiEnv(projectRoot: string, envFile?: string | string[]): Record<string, string> {
  const files = envFile === undefined ? DEFAULT_ENV_FILES : [envFile].flat();
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

/** A hint when .env holds AI_* settings that are no longer read by default, or undefined. */
export function unreadEnvHint(projectRoot: string, envFile?: string | string[]): string | undefined {
  if (envFile !== undefined) return undefined;
  const file = path.resolve(projectRoot, '.env');
  if (!existsSync(file) || !/^\s*(?:export\s+)?AI_[A-Z0-9_]*=/m.test(readFileSync(file, 'utf8'))) return undefined;
  return '.env has AI_* settings, but only ai.env is read by default. Move them to ai.env, or set envFile: \'.env\'.';
}

export function mask(secret: string | undefined): string {
  if (!secret) return '(not set)';
  return `set (${secret.length} chars)`;
}
