import type * as Transformers from '@huggingface/transformers';

export const MODELS = {
  embeddings: 'Xenova/all-MiniLM-L6-v2',
  nli: 'Xenova/nli-deberta-v3-xsmall',
  clip: 'Xenova/clip-vit-base-patch32',
  whisper: 'onnx-community/whisper-tiny.en',
} as const;

export interface MlOptions {
  cacheDir: string;
  /** Never download models; fail fast if they are not cached. */
  offline: boolean;
}

let options: MlOptions | undefined;
let lib: Promise<typeof Transformers> | undefined;
const cache = new Map<string, Promise<unknown>>();

export function configureMl(next: MlOptions): void {
  options = next;
}

async function transformers(): Promise<typeof Transformers> {
  lib ??= import('@huggingface/transformers')
    .then((t) => {
      if (options) {
        t.env.cacheDir = options.cacheDir;
        t.env.allowRemoteModels = !options.offline;
      }
      return t;
    })
    .catch((err: unknown) => {
      lib = undefined;
      const { code, message } = (err ?? {}) as NodeJS.ErrnoException;
      if ((code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') && String(message).includes('@huggingface/transformers')) {
        throw new Error('This check runs a local model, which needs @huggingface/transformers: npm i -D @huggingface/transformers');
      }
      throw err;
    });
  return lib;
}

function once<T>(key: string, load: () => Promise<T>): Promise<T> {
  if (!cache.has(key)) {
    cache.set(
      key,
      load().catch((err) => {
        cache.delete(key);
        throw err;
      }),
    );
  }
  return cache.get(key) as Promise<T>;
}

const Q8 = { dtype: 'q8' } as const;

export async function embed(texts: string[]): Promise<number[][]> {
  const t = await transformers();
  const extractor = await once('embeddings', () => t.pipeline('feature-extraction', MODELS.embeddings, Q8));
  const output = await extractor(texts, { pooling: 'mean', normalize: true });
  return output.tolist() as number[][];
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

export interface Entailment {
  entailment: number;
  contradiction: number;
  neutral: number;
}

export async function entailment(premise: string, hypothesis: string): Promise<Entailment> {
  const t = await transformers();
  const [tokenizer, model] = await once('nli', () =>
    Promise.all([t.AutoTokenizer.from_pretrained(MODELS.nli), t.AutoModelForSequenceClassification.from_pretrained(MODELS.nli, Q8)]),
  );
  const inputs = tokenizer(premise, { text_pair: hypothesis, truncation: true });
  const { logits } = await model(inputs);
  const values = Array.from(logits.data as Float32Array);
  const max = Math.max(...values);
  const exps = values.map((v) => Math.exp(v - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  const labels = (model.config as unknown as { id2label: Record<string, string> }).id2label;
  const out: Entailment = { entailment: 0, contradiction: 0, neutral: 0 };
  exps.forEach((e, i) => {
    const label = labels[i]?.toLowerCase() as keyof Entailment;
    if (label in out) out[label] = e / sum;
  });
  return out;
}

export interface ClipEmbeddings {
  image: number[];
  texts: number[][];
}

export async function clipEmbed(image: Buffer, texts: string[]): Promise<ClipEmbeddings> {
  const t = await transformers();
  const [tokenizer, processor, textModel, visionModel] = await once('clip', () =>
    Promise.all([
      t.AutoTokenizer.from_pretrained(MODELS.clip),
      t.AutoProcessor.from_pretrained(MODELS.clip),
      t.CLIPTextModelWithProjection.from_pretrained(MODELS.clip, Q8),
      t.CLIPVisionModelWithProjection.from_pretrained(MODELS.clip, Q8),
    ]),
  );
  const raw = await t.RawImage.fromBlob(new Blob([new Uint8Array(image)]));
  const { image_embeds } = await visionModel(await processor(raw));
  let textEmbeds: number[][] = [];
  if (texts.length) {
    const { text_embeds } = await textModel(tokenizer(texts, { padding: true, truncation: true }));
    textEmbeds = text_embeds.tolist() as number[][];
  }
  return { image: (image_embeds.tolist() as number[][])[0], texts: textEmbeds };
}

export async function transcribeLocal(samples16k: Float32Array): Promise<string> {
  const t = await transformers();
  const asr = await once('whisper', () => t.pipeline('automatic-speech-recognition', MODELS.whisper, Q8));
  const result = (await asr(samples16k)) as { text: string } | { text: string }[];
  return (Array.isArray(result) ? result.map((r) => r.text).join(' ') : result.text).trim();
}

/** Downloads and loads every local model so the first test does not pay for it. */
export async function warmAll(log: (msg: string) => void = () => {}): Promise<void> {
  const started = performance.now();
  await embed(['warm up']);
  log(`embeddings ready (${MODELS.embeddings})`);
  await entailment('The sky is blue.', 'The sky has a color.');
  log(`entailment ready (${MODELS.nli})`);
  const { default: sharp } = await import('sharp');
  const png = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#ff0000' } }).png().toBuffer();
  await clipEmbed(png, ['a red square']);
  log(`CLIP ready (${MODELS.clip})`);
  await transcribeLocal(new Float32Array(16000));
  log(`Whisper ready (${MODELS.whisper})`);
  log(`all local models ready in ${((performance.now() - started) / 1000).toFixed(1)}s`);
}
