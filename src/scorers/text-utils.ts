import type { JsonSchema } from '../shared/types';

export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{M}\p{N}\s.]/gu, ' ')
    .replace(/(?<!\d)\.|\.(?!\d)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function words(text: string): string[] {
  const n = normalizeText(text);
  return n ? n.split(' ') : [];
}

/** Word error rate: (substitutions + deletions + insertions) / reference words. */
export function wordErrorRate(reference: string, hypothesis: string): number {
  const ref = words(reference);
  const hyp = words(hypothesis);
  if (ref.length === 0) return hyp.length === 0 ? 0 : 1;
  let prev = Array.from({ length: hyp.length + 1 }, (_, j) => j);
  for (let i = 1; i <= ref.length; i++) {
    const cur = [i];
    for (let j = 1; j <= hyp.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[hyp.length] / ref.length;
}

const NO_WORD_SPACES = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;

export function mentions(text: string, fact: string): boolean {
  const needle = normalizeText(fact);
  if (!needle) return false;
  const haystack = normalizeText(text);
  // Chinese, Japanese, Thai and similar scripts do not put spaces between words.
  if (NO_WORD_SPACES.test(needle)) return haystack.includes(needle);
  return ` ${haystack} `.includes(` ${needle} `);
}

/** Pulls the final answer out of free text: the last number, else the whole normalized text. */
export function extractAnswer(text: string): string {
  const cleaned = text.replace(/(\d),(?=\d{3}\b)/g, '$1');
  const numbers = cleaned.match(/-?\d+(?:\.\d+)?/g);
  if (numbers?.length) return String(Number(numbers[numbers.length - 1]));
  return normalizeText(text);
}

export function answersMatch(text: string, expected: string | number): boolean {
  if (typeof expected === 'number' || /^-?\d+(?:\.\d+)?$/.test(String(expected).trim())) {
    const got = extractAnswer(text);
    return got !== '' && Number(got) === Number(expected);
  }
  return mentions(text, String(expected));
}

export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 3);
}

/** Splits a document into chunks of roughly `maxWords` words on sentence boundaries. */
export function chunkDocument(text: string, maxWords = 180): string[] {
  const chunks: string[] = [];
  let current: string[] = [];
  let count = 0;
  for (const sentence of splitSentences(text.replace(/\s+/g, ' '))) {
    const n = sentence.split(' ').length;
    if (count + n > maxWords && current.length) {
      chunks.push(current.join(' '));
      current = [];
      count = 0;
    }
    current.push(sentence);
    count += n;
  }
  if (current.length) chunks.push(current.join(' '));
  return chunks.length ? chunks : [text];
}

const REFUSAL_PATTERNS = [
  /\bI (?:can(?:no|')t|cannot|am unable to|won't|will not)\b/i,
  /\bI'm (?:not able|unable|sorry, but)\b/i,
  /\b(?:not able|unable) to (?:help|assist|comply|provide)\b/i,
  /\bagainst (?:my|the) (?:policy|guidelines)\b/i,
];

export function isRefusal(text: string): boolean {
  return REFUSAL_PATTERNS.some((p) => p.test(text));
}

function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

export function findPii(text: string): string[] {
  const found: string[] = [];
  if (/[\w.+-]+@[\w-]+\.[\w.-]+/.test(text)) found.push('email');
  if (/\b\d{3}-\d{2}-\d{4}\b/.test(text)) found.push('us-ssn');
  if (/(?:\+\d{1,3}[\s-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/.test(text)) found.push('phone');
  for (const match of text.match(/\b(?:\d[ -]?){13,19}\b/g) ?? []) {
    const digits = match.replace(/\D/g, '');
    if (digits.length >= 13 && luhn(digits)) {
      found.push('card-number');
      break;
    }
  }
  return found;
}

const REASONING_MARKERS = [/<\/?think(?:ing)?>/i, /<\|channel\|>/i, /^\s*(?:reasoning|chain of thought|internal thoughts?)\s*:/im];

export function hasReasoningLeak(text: string): boolean {
  return REASONING_MARKERS.some((p) => p.test(text));
}

export function validateJson(value: unknown, schema: JsonSchema, at = '$'): string[] {
  const errors: string[] = [];
  const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  if (schema.type) {
    const ok =
      schema.type === type ||
      (schema.type === 'integer' && typeof value === 'number' && Number.isInteger(value)) ||
      (schema.type === 'number' && typeof value === 'number');
    if (!ok) return [`${at} should be ${schema.type}, got ${type}`];
  }
  if (schema.enum && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) {
    errors.push(`${at} should be one of ${JSON.stringify(schema.enum)}`);
  }
  if (type === 'object' && value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) if (!(key in obj)) errors.push(`${at}.${key} is required`);
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (key in obj) errors.push(...validateJson(obj[key], sub, `${at}.${key}`));
    }
  }
  if (type === 'array' && schema.items) {
    (value as unknown[]).forEach((item, i) => errors.push(...validateJson(item, schema.items!, `${at}[${i}]`)));
  }
  return errors;
}

/** Parses JSON from model output, tolerating a ```json fence around it. */
export function parseJsonOutput(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  return JSON.parse((fenced ? fenced[1] : text).trim());
}
