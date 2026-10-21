import { describe, expect, it } from 'vitest';
import {
  answersMatch,
  chunkDocument,
  extractAnswer,
  findPii,
  hasReasoningLeak,
  isRefusal,
  mentions,
  normalizeText,
  parseJsonOutput,
  splitSentences,
  validateJson,
  wordErrorRate,
} from '../src/scorers/text-utils';

describe('wordErrorRate', () => {
  it('is 0 for identical text, ignoring case and punctuation', () => {
    expect(wordErrorRate('Your order ships tomorrow.', 'your order ships tomorrow')).toBe(0);
  });

  it('counts one substitution in twelve words (the Cypress/Cyprus case)', () => {
    const wer = wordErrorRate(
      'Your order ships tomorrow morning. Thank you for testing with Cypress.',
      'Your order ships tomorrow morning thank you for testing with Cyprus',
    );
    expect(wer).toBeCloseTo(1 / 11, 5);
  });

  it('counts deletions and insertions', () => {
    expect(wordErrorRate('a b c d', 'a c d')).toBe(0.25);
    expect(wordErrorRate('a b', 'a b c d')).toBe(1);
  });
});

describe('answers', () => {
  it('extracts the last number, ignoring thousands separators', () => {
    expect(extractAnswer('First 3 apples, then 1,250 pears. Answer: 1,253')).toBe('1253');
  });

  it('matches numeric and text answers', () => {
    expect(answersMatch('The total is 42.', 42)).toBe(true);
    expect(answersMatch('The total is 41.', '42')).toBe(false);
    expect(answersMatch('The capital is Canberra.', 'Canberra')).toBe(true);
  });

  it('matches whole words only', () => {
    expect(mentions('Canberra is the capital', 'Canberra')).toBe(true);
    expect(mentions('Canberrans live there', 'Canberra')).toBe(false);
  });
});

describe('documents', () => {
  it('splits sentences and chunks by word budget', () => {
    expect(splitSentences('One fact. Two facts! Three?')).toEqual(['One fact.', 'Two facts!', 'Three?']);
    const doc = Array.from({ length: 50 }, (_, i) => `Sentence number ${i} has six words.`).join(' ');
    const chunks = chunkDocument(doc, 60);
    expect(chunks.length).toBeGreaterThan(4);
    expect(chunks.every((c) => c.split(' ').length <= 60)).toBe(true);
  });
});

describe('guardrails', () => {
  it('finds PII including Luhn-valid card numbers', () => {
    expect(findPii('Mail me at jane@example.com')).toContain('email');
    expect(findPii('SSN 123-45-6789')).toContain('us-ssn');
    expect(findPii('Card 4111 1111 1111 1111')).toContain('card-number');
    expect(findPii('Order 1234 5678 9012 3456')).not.toContain('card-number');
    expect(findPii('Canberra is the capital')).toEqual([]);
  });

  it('detects refusals and reasoning leaks', () => {
    expect(isRefusal("I'm sorry, but I can't help with that.")).toBe(true);
    expect(isRefusal('Canberra is the capital.')).toBe(false);
    expect(hasReasoningLeak('<think>let me see</think> 42')).toBe(true);
    expect(hasReasoningLeak('The answer is 42.')).toBe(false);
  });
});

describe('json', () => {
  const schema = {
    type: 'object' as const,
    required: ['city', 'population'],
    properties: { city: { type: 'string' as const }, population: { type: 'integer' as const }, tags: { type: 'array' as const, items: { type: 'string' as const } } },
  };

  it('accepts valid output wrapped in a code fence', () => {
    const value = parseJsonOutput('```json\n{"city":"Canberra","population":467000,"tags":["capital"]}\n```');
    expect(validateJson(value, schema)).toEqual([]);
  });

  it('reports missing and mistyped fields', () => {
    expect(validateJson({ city: 7 }, schema)).toEqual(['$.population is required', '$.city should be string, got number']);
  });

  it('keeps letters from every script, not just a to z', () => {
    expect(normalizeText('Москва — столица России')).toBe('москва столица россии');
    expect(mentions('Москва — столица России.', 'Москва')).toBe(true);
    expect(mentions('The capital is 東京 (Tokyo).', '東京')).toBe(true);
    expect(mentions('首都は東京です', '東京')).toBe(true);
    expect(mentions('大阪は日本の首都です', '東京')).toBe(false);
    expect(wordErrorRate('Москва столица России', 'Париж столица Франции')).toBeGreaterThan(0.5);
  });

  it('does not match an empty fact or an empty answer', () => {
    expect(mentions('anything at all', '—')).toBe(false);
    expect(answersMatch('', 0)).toBe(false);
    expect(answersMatch('The answer is 0.', 0)).toBe(true);
  });
});

