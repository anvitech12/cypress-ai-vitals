import { describe, expect, it } from 'vitest';
import { audioDurationSec, pcm16ToWav } from '../src/plugin/media';

/** MPEG-1 Layer III, 128 kbps, 44.1 kHz frames: 417 bytes each, 1152 samples each. */
function mp3Frames(count: number, id3 = false): Buffer {
  const frame = Buffer.alloc(417);
  frame.set([0xff, 0xfb, 0x90, 0x00]);
  const frames = Buffer.concat(Array.from({ length: count }, () => frame));
  if (!id3) return frames;
  const tag = Buffer.alloc(30);
  tag.write('ID3', 0, 'latin1');
  tag[9] = 20; // syncsafe size: 20 bytes after the 10-byte header
  return Buffer.concat([tag, frames]);
}

describe('audioDurationSec', () => {
  it('reads WAV length', () => {
    expect(audioDurationSec(pcm16ToWav(Buffer.alloc(16000 * 2 * 3), 16000))).toBeCloseTo(3, 5);
  });

  it('adds up MP3 frames, with or without an ID3 tag', () => {
    expect(audioDurationSec(mp3Frames(100))).toBeCloseTo((100 * 1152) / 44100, 5);
    expect(audioDurationSec(mp3Frames(100, true))).toBeCloseTo((100 * 1152) / 44100, 5);
  });

  it('returns undefined for formats it cannot measure', () => {
    expect(audioDurationSec(Buffer.from('OggS not really audio'))).toBeUndefined();
  });
});
