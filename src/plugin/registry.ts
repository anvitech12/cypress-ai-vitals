import { customProviders } from './custom-providers';

export type ProviderKind = 'openai' | 'anthropic' | 'gemini' | 'cloudflare' | 'gradio' | 'http';
export type ModelKind = 'chat' | 'image' | 'speech' | 'transcribe';

/** Guesses what a model does from its id. Override with AI_MODEL_<NAME>_KIND. */
export function inferKind(modelId: string): ModelKind {
  if (/flux|diffusion|sdxl|dreamshaper|lucid|phoenix|dall-e|gpt-image|imagen|-image\b|image-/i.test(modelId)) return 'image';
  if (/whisper|nova-|transcrib|speech-to-text|\bstt\b/i.test(modelId)) return 'transcribe';
  if (/tts|aura|melotts|orpheus|text-to-speech/i.test(modelId)) return 'speech';
  return 'chat';
}

export interface Preset {
  kind: ProviderKind;
  baseUrl?: string | ((env: Record<string, string>) => string | undefined);
  keyEnv?: string[];
  /** Header used for the key. Defaults to Authorization: Bearer. */
  authHeader?: 'bearer' | 'api-key' | 'x-api-key' | 'x-goog-api-key' | 'none';
  keyOptional?: boolean;
}

export const PRESETS: Record<string, Preset> = {
  openai: { kind: 'openai', baseUrl: 'https://api.openai.com/v1', keyEnv: ['OPENAI_API_KEY'] },
  'azure-openai': {
    kind: 'openai',
    baseUrl: (env) => (env.AZURE_OPENAI_ENDPOINT ? `${env.AZURE_OPENAI_ENDPOINT.replace(/\/$/, '')}/openai/v1` : undefined),
    keyEnv: ['AZURE_OPENAI_API_KEY'],
    authHeader: 'api-key',
  },
  groq: { kind: 'openai', baseUrl: 'https://api.groq.com/openai/v1', keyEnv: ['GROQ_API_KEY'] },
  openrouter: { kind: 'openai', baseUrl: 'https://openrouter.ai/api/v1', keyEnv: ['OPENROUTER_API_KEY'] },
  mistral: { kind: 'openai', baseUrl: 'https://api.mistral.ai/v1', keyEnv: ['MISTRAL_API_KEY'] },
  deepseek: { kind: 'openai', baseUrl: 'https://api.deepseek.com/v1', keyEnv: ['DEEPSEEK_API_KEY'] },
  xai: { kind: 'openai', baseUrl: 'https://api.x.ai/v1', keyEnv: ['XAI_API_KEY'] },
  together: { kind: 'openai', baseUrl: 'https://api.together.xyz/v1', keyEnv: ['TOGETHER_API_KEY'] },
  fireworks: { kind: 'openai', baseUrl: 'https://api.fireworks.ai/inference/v1', keyEnv: ['FIREWORKS_API_KEY'] },
  cerebras: { kind: 'openai', baseUrl: 'https://api.cerebras.ai/v1', keyEnv: ['CEREBRAS_API_KEY'] },
  huggingface: { kind: 'openai', baseUrl: 'https://router.huggingface.co/v1', keyEnv: ['HF_TOKEN', 'HUGGINGFACE_API_KEY'] },
  ollama: { kind: 'openai', baseUrl: 'http://localhost:11434/v1', keyOptional: true },
  lmstudio: { kind: 'openai', baseUrl: 'http://localhost:1234/v1', keyOptional: true },
  vllm: { kind: 'openai', baseUrl: 'http://localhost:8000/v1', keyOptional: true },
  'openai-compatible': { kind: 'openai', keyOptional: true },
  anthropic: { kind: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', keyEnv: ['ANTHROPIC_API_KEY'], authHeader: 'x-api-key' },
  gemini: {
    kind: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    keyEnv: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    authHeader: 'x-goog-api-key',
  },
  cloudflare: {
    kind: 'cloudflare',
    baseUrl: (env) =>
      env.CLOUDFLARE_ACCOUNT_ID ? `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/ai` : undefined,
    keyEnv: ['CLOUDFLARE_API_TOKEN'],
  },
  // Free Gradio demos on Hugging Face Spaces (model = the Space id). The token is optional and raises the ZeroGPU quota.
  'hf-space': { kind: 'gradio', keyEnv: ['HF_TOKEN', 'HUGGINGFACE_API_KEY'], keyOptional: true },
  gradio: { kind: 'gradio', keyOptional: true },
  http: { kind: 'http', keyOptional: true },
};

export interface ModelConfig {
  name: string;
  /** Human-friendly display name, e.g. "GPT-OSS 20B". Defaults to the name. */
  label?: string;
  /** Free-form labels shown next to the model, e.g. ["free", "beta"]. */
  tags: string[];
  preset: string;
  kind: ProviderKind;
  /** What the model does: chat, image, speech or transcribe. */
  modality: ModelKind;
  model: string;
  baseUrl?: string;
  apiKey?: string;
  authHeader: NonNullable<Preset['authHeader']>;
  headers: Record<string, string>;
  params: Record<string, unknown>;
  price?: { inputPerMTok?: number; outputPerMTok?: number; perImage?: number; perMinute?: number; per1kChars?: number };
  /** Settings for the generic http provider; endpoint and body also drive the gradio provider. */
  http?: { url?: string; body?: string; endpoint?: string; textPath?: string; inputTokensPath?: string; outputTokensPath?: string };
}

/** What users write in code instead of (or on top of) ai.env. */
export interface ModelDefinition {
  provider: string;
  model: string;
  label?: string;
  tags?: string[];
  modality?: ModelKind;
  baseUrl?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  params?: Record<string, unknown>;
  price?: ModelConfig['price'];
  http?: ModelConfig['http'];
}

const SUFFIXES = [
  'BASE_URL',
  'API_KEY',
  'HEADERS',
  'TEMPERATURE',
  'MAX_TOKENS',
  'REASONING_EFFORT',
  'THINKING_BUDGET',
  'VOICE',
  'PRICE_IN',
  'PRICE_OUT',
  'PRICE_IMAGE',
  'PRICE_MINUTE',
  'PRICE_1K_CHARS',
  'KIND',
  'LABEL',
  'TAGS',
  'URL',
  'BODY',
  'ENDPOINT',
  'TEXT_PATH',
  'INPUT_TOKENS_PATH',
  'OUTPUT_TOKENS_PATH',
];

const MODEL_PREFIX = 'AI_MODEL_';

function envName(name: string): string {
  return name.toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

function num(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

export function parseModelSpec(spec: string): { preset: string; model: string } {
  const i = spec.indexOf(':');
  if (i <= 0) throw new Error(`Model spec "${spec}" must look like "preset:model", e.g. "groq:openai/gpt-oss-20b".`);
  return { preset: spec.slice(0, i).trim(), model: spec.slice(i + 1).trim() };
}

function resolve(name: string, def: ModelDefinition, env: Record<string, string>): ModelConfig {
  // A provider registered with defineProvider() supplies its own calls; the kind only fills the type.
  const preset = PRESETS[def.provider] ?? (customProviders().has(def.provider) ? ({ kind: 'http' } as const) : undefined);
  if (!preset) {
    throw new Error(
      `Unknown provider "${def.provider}" for model "${name}". Known: ${Object.keys(PRESETS).join(', ')}, or register your own with defineProvider() before aiVitalsPlugin().`,
    );
  }
  const presetBase = typeof preset.baseUrl === 'function' ? preset.baseUrl(env) : preset.baseUrl;
  const apiKey = def.apiKey ?? preset.keyEnv?.map((k) => env[k]).find(Boolean);
  return {
    name,
    label: def.label,
    tags: def.tags ?? [],
    preset: def.provider,
    kind: preset.kind,
    modality: def.modality ?? inferKind(def.model),
    model: def.model,
    baseUrl: def.baseUrl ?? presetBase,
    apiKey,
    authHeader: preset.authHeader ?? 'bearer',
    headers: def.headers ?? {},
    params: def.params ?? {},
    price: def.price,
    http: def.http,
  };
}

/** Builds the registry from AI_MODEL_<NAME>=preset:model entries plus definitions passed in code. */
export function buildRegistry(env: Record<string, string>, fromCode: Record<string, ModelDefinition> = {}): Map<string, ModelConfig> {
  const registry = new Map<string, ModelConfig>();
  const allow = env.AI_MODELS?.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith(MODEL_PREFIX)) continue;
    const rest = key.slice(MODEL_PREFIX.length);
    if (SUFFIXES.some((s) => rest.endsWith(`_${s}`))) continue;
    const name = rest.toLowerCase().replace(/_/g, '-');
    if (allow && !allow.includes(name)) continue;
    const { preset, model } = parseModelSpec(value);
    const get = (suffix: string) => env[`${MODEL_PREFIX}${rest}_${suffix}`];
    const params: Record<string, unknown> = {};
    if (num(get('TEMPERATURE')) !== undefined) params.temperature = num(get('TEMPERATURE'));
    if (num(get('MAX_TOKENS')) !== undefined) params.maxTokens = num(get('MAX_TOKENS'));
    if (get('REASONING_EFFORT')) params.reasoningEffort = get('REASONING_EFFORT');
    if (num(get('THINKING_BUDGET')) !== undefined) params.thinkingBudget = num(get('THINKING_BUDGET'));
    if (get('VOICE')) params.voice = get('VOICE');
    const price = {
      inputPerMTok: num(get('PRICE_IN')),
      outputPerMTok: num(get('PRICE_OUT')),
      perImage: num(get('PRICE_IMAGE')),
      perMinute: num(get('PRICE_MINUTE')),
      per1kChars: num(get('PRICE_1K_CHARS')),
    };
    const hasPrice = Object.values(price).some((v) => v !== undefined);
    registry.set(
      name,
      resolve(
        name,
        {
          provider: preset,
          model,
          label: get('LABEL'),
          tags: get('TAGS')?.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean),
          modality: (['chat', 'image', 'speech', 'transcribe'] as const).find((k) => k === get('KIND')),
          baseUrl: get('BASE_URL'),
          apiKey: get('API_KEY'),
          headers: get('HEADERS') ? (JSON.parse(get('HEADERS')!) as Record<string, string>) : undefined,
          params,
          price: hasPrice ? price : undefined,
          http: {
            url: get('URL'),
            body: get('BODY'),
            endpoint: get('ENDPOINT'),
            textPath: get('TEXT_PATH'),
            inputTokensPath: get('INPUT_TOKENS_PATH'),
            outputTokensPath: get('OUTPUT_TOKENS_PATH'),
          },
        },
        env,
      ),
    );
  }

  for (const [name, def] of Object.entries(fromCode)) {
    const key = name.toLowerCase();
    const base = registry.get(key);
    registry.set(key, resolve(key, { ...def, params: { ...base?.params, ...def.params } }, env));
  }
  return registry;
}

export function requireModel(registry: Map<string, ModelConfig>, name: string): ModelConfig {
  const model = registry.get(name.toLowerCase());
  if (!model) {
    const known = [...registry.keys()];
    throw new Error(
      `No model named "${name}". Add AI_MODEL_${envName(name)}=<provider>:<model> to ai.env.` +
        (known.length ? ` Known models: ${known.join(', ')}.` : ' No models are configured yet.'),
    );
  }
  return model;
}

/** Human-readable summary of the settings that change a model's behaviour. */
export function describeSettings(params: Record<string, unknown>): string | undefined {
  const parts: string[] = [];
  if (params.reasoningEffort !== undefined) parts.push(`effort ${params.reasoningEffort}`);
  if (params.thinkingBudget !== undefined) parts.push(`thinking budget ${params.thinkingBudget}`);
  if (params.maxTokens !== undefined) parts.push(`max ${params.maxTokens} tok`);
  if (params.temperature !== undefined) parts.push(`temp ${params.temperature}`);
  if (params.voice !== undefined) parts.push(`voice ${params.voice}`);
  return parts.length ? parts.join(' · ') : undefined;
}
