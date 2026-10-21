export type Modality = 'text' | 'image' | 'audio';

export interface Usage {
  inputTokens: number;
  /** Includes reasoning tokens, normalized across providers. */
  outputTokens: number;
  /** Undefined when the provider does not report it. */
  reasoningTokens?: number;
  totalTokens: number;
}

export type LatencySource = 'server-timing' | 'provider' | 'wall-clock' | 'cassette';

export interface Vitals {
  /** The name from ai.env, e.g. gpt-oss-20b-low. */
  model?: string;
  provider?: string;
  /** The provider's model id, e.g. openai/gpt-oss-20b. */
  modelId?: string;
  /** Settings that change behaviour, e.g. "effort low · max 160 tok". */
  settings?: string;
  latencyMs?: number;
  latencySource?: LatencySource;
  usage?: Usage;
  costUsd?: number | null;
}

export interface CheckResult {
  name: string;
  pass: boolean;
  score?: number;
  threshold?: number;
  detail?: string;
}

export interface ScoreResult {
  pass: boolean;
  checks: CheckResult[];
  vitals?: Vitals;
  output?: string;
  scoringMs: number;
}

export interface JudgeSpec {
  rubric: string;
  /** Minimum score on a 1 to 5 scale. Defaults to 4. */
  min?: number;
  /** Named model from the registry. Defaults to AI_JUDGE. */
  model?: string;
}

export type Guardrail = 'no-pii' | 'no-prompt-leak' | 'no-reasoning-leak';

export interface SerializedRegExp {
  source: string;
  flags: string;
}

export type JsonSchema = {
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
};

export type TextSource = string | { fixture: string } | { text: string };

export interface TextSpec {
  means?: string;
  mustMention?: string[];
  exactAnswer?: string | number;
  maxWer?: number;
  /** Reference text for maxWer. Defaults to `means`. */
  reference?: string;
  groundedIn?: TextSource;
  jsonSchema?: JsonSchema;
  regex?: RegExp | SerializedRegExp;
  notRegex?: RegExp | SerializedRegExp;
  /** true: the answer must be a refusal. false: it must not be. */
  refusal?: boolean;
  guardrails?: Guardrail[];
  /** Secret marker that must never appear in output (for no-prompt-leak). */
  canary?: string;
  judge?: JudgeSpec;
  thresholds?: { means?: number; groundedIn?: number };
  /** Checks registered with defineScorer(), keyed by name. */
  custom?: Record<string, unknown>;
}

export interface BrandSpec {
  palette?: { hex: string; minCoverage?: number }[];
  /** CIEDE2000 distance that still counts as the brand color. Defaults to 12. */
  tolerance?: number;
  forbidden?: { hex: string; maxCoverage?: number }[];
  onBrand?: string[];
  offBrand?: string[];
}

export interface ImageSpec {
  depicts?: string;
  notDepicts?: string[];
  brand?: BrandSpec | { fixture: string };
  dimensions?: { width?: number; height?: number; minWidth?: number; minHeight?: number };
  judge?: JudgeSpec;
  thresholds?: { depictsMargin?: number };
  custom?: Record<string, unknown>;
}

export interface AudioSpec {
  transcript?: {
    means?: string;
    expected?: string;
    maxWer?: number;
    /** Minimum embedding similarity for `means`. Defaults to 0.8. Named entities heard wrong (Cypress/Cyprus) drop it sharply, so prefer maxWer for speech. */
    minMeans?: number;
    /** 'local' (Whisper in Node) or a named model with transcription support. */
    engine?: string;
  };
  custom?: Record<string, unknown>;
}

export interface VitalsThresholds {
  latencyMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  costUsd?: number;
}

export interface CommonOptions {
  /** Record the result without failing the test. Gate later with aiExpectPassRate. */
  soft?: boolean;
  /** Groups results for aiExpectPassRate and the report. */
  label?: string;
  timeout?: number;
  /** Shown in the Command Log and the report, e.g. the model that produced the output. */
  model?: string;
  /** Passes only when at least one check fails: proves a guardrail catches a known-bad output. */
  shouldFail?: boolean;
}

export interface ResultRecord {
  ts: string;
  spec: string;
  test: string;
  /** The spec run this result came from; pass rates only count the current run. */
  run?: string;
  command: string;
  label?: string;
  modality?: Modality;
  model?: string;
  pass: boolean;
  soft?: boolean;
  /** The test expected the checks to catch this output; `pass` is true when they did. */
  shouldFail?: boolean;
  checks: CheckResult[];
  vitals?: Vitals;
  output?: string;
  /** Gates of the aiCompare run this result belongs to. */
  gates?: CompareSpec['gates'];
}

export interface CompareSpec {
  /** Fixture path to a .json array or .jsonl file of cases. Use this or `cases`. */
  dataset?: string;
  /** Cases written inline in the spec. Use this or `dataset`. */
  cases?: CompareCase[];
  /** Named models from the registry. */
  models: string[];
  scorers?: Array<'exactAnswer' | 'means' | 'mustMention' | 'groundedIn' | 'judge'>;
  runs?: number;
  system?: string;
  gates?: { accuracy?: number; p95LatencyMs?: number; costPer100Usd?: number };
  label?: string;
}

export interface CompareCase {
  id?: string;
  input: string;
  expected?: string;
  answer?: string | number;
  mustMention?: string[];
  groundedIn?: string;
  rubric?: string;
}

export interface ModelSummary {
  model: string;
  provider?: string;
  modelId?: string;
  settings?: string;
  calls: number;
  passRate: number;
  accuracy: number;
  accuracyCi: [number, number];
  p50LatencyMs: number;
  p95LatencyMs: number;
  inputTokens: number;
  outputTokens: number;
  /** Undefined when the provider does not report it. */
  reasoningTokens?: number;
  costUsd: number | null;
  costPer100Usd: number | null;
  /** False when no gates were set, so reports show a dash instead of a pass. */
  hasGates: boolean;
  gatesPassed: boolean;
  gateFailures: string[];
}

export interface CompareResult {
  label: string;
  models: ModelSummary[];
  winner?: string;
  /** One entry per model call, for live dashboards. */
  calls?: Array<{ model: string; pass: boolean; vitals?: Vitals }>;
}
