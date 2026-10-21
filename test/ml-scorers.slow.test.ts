import path from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import sharp from 'sharp';
import { beforeAll, describe, expect, it } from 'vitest';
import { configureMl } from '../src/plugin/ml';
import { scoreText, groundedCheck } from '../src/scorers/text';
import { scoreImage } from '../src/scorers/image';
import { scoreAudio } from '../src/scorers/audio';

const ctx = { projectRoot: process.cwd(), fixturesFolder: path.join(process.cwd(), 'test/fixtures') };
const noJudge = async () => {
  throw new Error('judge not used in these tests');
};
const SOURCE = 'Canberra is the capital city of Australia. Sydney is the largest city in Australia.';

describe.runIf(process.env.AI_VITALS_ML_TESTS === '1')('local model scorers (slow)', () => {
  beforeAll(() => configureMl({ cacheDir: path.join(process.cwd(), '.cache/models'), offline: false }));

  it('means accepts paraphrases but is fooled by the Sydney answer', async () => {
    const [paraphrase] = await scoreText("Australia's capital city is Canberra.", { means: 'Canberra is the capital of Australia.' }, { ...ctx, generate: noJudge });
    const [sydney] = await scoreText('Sydney is the capital of Australia.', { means: 'Canberra is the capital of Australia.' }, { ...ctx, generate: noJudge });
    expect(paraphrase.pass).toBe(true);
    expect(sydney.pass).toBe(true);
  });

  it('mustMention and groundedIn catch the Sydney answer', async () => {
    const checks = await scoreText(
      'Sydney is the capital of Australia.',
      { means: 'Canberra is the capital of Australia.', mustMention: ['Canberra'], groundedIn: { text: SOURCE } },
      { ...ctx, generate: noJudge },
    );
    expect(checks.find((c) => c.name === 'mustMention')?.pass).toBe(false);
    const grounded = checks.find((c) => c.name === 'groundedIn')!;
    expect(grounded.pass).toBe(false);
    expect(grounded.detail).toMatch(/contradicts the source/);
  });

  it('groundedIn on a richer fact sheet: Sydney fails, Canberra passes', async () => {
    const sheet =
      'Canberra is the capital city of Australia. It became the seat of government in 1927. Sydney is the largest city in Australia and is the capital of the state of New South Wales. Melbourne is the capital of the state of Victoria.';
    expect((await groundedCheck('Sydney is the capital of Australia.', sheet, 0.5)).pass).toBe(false);
    expect((await groundedCheck('Canberra is the capital of Australia.', sheet, 0.5)).pass).toBe(true);
    expect((await groundedCheck('The capital is Canberra. Sydney is the biggest city.', sheet, 0.5)).pass).toBe(true);
  });

  it('groundedIn on a USA fact sheet: a wrong capital fails even when the whole sheet seems to support it', async () => {
    const sheet =
      '# United States fact sheet\n\nWashington, D.C. is the capital of the United States. It became the seat of the federal government in 1800.\nNew York City is the largest city in the United States.\nLos Angeles is the second largest city.\nThe US dollar is the national currency.\n';
    const newYork = await groundedCheck('New York is the capital of the United States.', sheet, 0.5);
    expect(newYork.pass).toBe(false);
    expect(newYork.detail).toMatch(/contradicts the source/);
    expect((await groundedCheck('Washington, D.C. is the capital of the United States.', sheet, 0.5)).pass).toBe(true);
    expect((await groundedCheck("The USA's capital is Washington, D.C.", sheet, 0.5)).pass).toBe(true);
    expect((await groundedCheck('Washington, D.C. is the capital of the United States, and Los Angeles is its largest city.', sheet, 0.5)).pass).toBe(false);
  });

  it('groundedIn accepts correct answers that combine two facts from the source', async () => {
    const hours = 'The library opens at 8 AM on weekdays. It closes at 9 PM Monday through Thursday. On Friday it closes at 5 PM. The library is closed on Sundays. On Saturdays it is open from 10 AM to 4 PM.';
    const product = 'The X200 laptop has a 14-inch screen. It weighs 1.2 kilograms. The battery lasts up to 12 hours. It ships with 16 GB of memory. A 32 GB model costs 200 dollars more.';
    expect((await groundedCheck('The library is closed on Sundays and opens at 10 AM on Saturdays.', hours, 0.5)).pass).toBe(true);
    expect((await groundedCheck('From Monday to Thursday it is open 8 AM to 9 PM.', hours, 0.5)).pass).toBe(true);
    expect((await groundedCheck('The 32 GB X200 costs 200 dollars more than the 16 GB model.', product, 0.5)).pass).toBe(true);
  });

  it('groundedIn accepts a supported answer with filler', async () => {
    const result = await groundedCheck('Great question! Canberra is the capital of Australia.', SOURCE, 0.5);
    expect(result.pass).toBe(true);
  });

  it('CLIP picks the right caption for a solid red image', async () => {
    const red = await sharp({ create: { width: 224, height: 224, channels: 3, background: '#e53935' } }).png().toBuffer();
    const checks = await scoreImage(red, 'image/png', { depicts: 'a plain red image', notDepicts: ['a photo of a dog'], brand: { palette: [{ hex: '#e53935', minCoverage: 0.9 }], forbidden: [{ hex: '#1e40af' }] }, dimensions: { width: 224 } }, { ...ctx, generate: noJudge });
    expect(checks.map((c) => [c.name, c.pass])).toEqual([
      ['depicts', true],
      ['notDepicts', true],
      ['palette #e53935', true],
      ['forbidden #1e40af', true],
      ['dimensions', true],
    ]);
  });

  const spike = path.join(process.cwd(), '../cypress-demo/app/generated/spike.wav');
  it.runIf(existsSync(spike))('speech: WER passes on the Cypress/Cyprus homophone while meaning similarity drops', async () => {
    const { checks, transcript } = await scoreAudio(readFileSync(spike), 'audio/wav', {
      transcript: { means: 'Your order ships tomorrow morning. Thank you for testing with Cypress.', maxWer: 0.15 },
    }, { ...ctx, generate: noJudge as never });
    expect(transcript).toMatch(/order ships tomorrow/i);
    const wer = checks.find((c) => c.name === 'wer')!;
    const means = checks.find((c) => c.name === 'means')!;
    expect(wer.pass).toBe(true);
    expect(wer.score).toBeLessThan(0.1);
    expect(means.score!).toBeLessThan(0.8);
  });
});
