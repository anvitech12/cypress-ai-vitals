import { readFile } from 'node:fs/promises';
import path from 'node:path';

export interface LoadedMedia {
  data: Buffer;
  mime: string;
  source: string;
}

const EXT_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.webm': 'audio/webm',
  '.ogg': 'audio/ogg',
};

/** Loads media from a data: URL, an http(s) URL, or a path relative to the project root. */
export async function loadMedia(source: string, projectRoot: string): Promise<LoadedMedia> {
  if (source.startsWith('data:')) {
    // Parameters may sit between the type and the data, e.g. data:audio/webm;codecs=opus;base64,… from MediaRecorder.
    const match = /^data:([^;,]*)((?:;[^;,=]+=[^;,]*)*)(;base64)?,(.*)$/s.exec(source);
    if (!match) throw new Error('Malformed data: URL');
    const data = match[3] ? Buffer.from(match[4], 'base64') : Buffer.from(decodeURIComponent(match[4]));
    return { data, mime: match[1] || 'text/plain', source: 'data-url' };
  }
  if (/^https?:\/\//.test(source)) {
    const res = await fetch(source);
    if (!res.ok) throw new Error(`Could not load ${source}: ${res.status}`);
    return { data: Buffer.from(await res.arrayBuffer()), mime: res.headers.get('content-type') ?? 'application/octet-stream', source };
  }
  const full = path.resolve(projectRoot, source);
  return { data: await readFile(full), mime: EXT_MIME[path.extname(full).toLowerCase()] ?? 'application/octet-stream', source: full };
}

export function pcm16ToWav(pcm: Buffer, sampleRate: number, channels = 1): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export interface DecodedAudio {
  samples: Float32Array;
  sampleRate: number;
  durationSec: number;
}

/** Decodes 16-bit PCM or 32-bit float WAV into mono float samples. */
export function decodeWav(wav: Buffer): DecodedAudio {
  if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Not a WAV file. Convert MP3/WebM to WAV first, or pass a WAV URL.');
  }
  let offset = 12;
  let format = 1;
  let channels = 1;
  let sampleRate = 16000;
  let bits = 16;
  while (offset + 8 <= wav.length) {
    const id = wav.toString('ascii', offset, offset + 4);
    let size = wav.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      format = wav.readUInt16LE(body);
      channels = wav.readUInt16LE(body + 2);
      sampleRate = wav.readUInt32LE(body + 4);
      bits = wav.readUInt16LE(body + 14);
    } else if (id === 'data') {
      // Streaming writers sometimes leave the size as 0 or 0xFFFFFFFF.
      if (size === 0 || body + size > wav.length) size = wav.length - body;
      const bytesPerSample = bits / 8;
      const frames = Math.floor(size / (bytesPerSample * channels));
      const samples = new Float32Array(frames);
      for (let f = 0; f < frames; f++) {
        let sum = 0;
        for (let c = 0; c < channels; c++) {
          const at = body + (f * channels + c) * bytesPerSample;
          if (format === 3 && bits === 32) sum += wav.readFloatLE(at);
          else if (bits === 16) sum += wav.readInt16LE(at) / 32768;
          else if (bits === 8) sum += (wav.readUInt8(at) - 128) / 128;
          else if (bits === 24) sum += wav.readIntLE(at, 3) / 8388608;
          else if (bits === 32) sum += wav.readInt32LE(at) / 2147483648;
        }
        samples[f] = sum / channels;
      }
      return { samples, sampleRate, durationSec: frames / sampleRate };
    }
    offset = body + size + (size % 2);
  }
  throw new Error('WAV file has no data chunk.');
}

/** Linear resampling; good enough for speech recognition input. */
export function resample(samples: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return samples;
  const ratio = from / to;
  const out = new Float32Array(Math.floor(samples.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const pos = i * ratio;
    const left = Math.floor(pos);
    const right = Math.min(left + 1, samples.length - 1);
    const t = pos - left;
    out[i] = samples[left] * (1 - t) + samples[right] * t;
  }
  return out;
}

/**
 * Appends silence to a 16-bit PCM WAV. Browser speech recognition drops the last word when the
 * audio track ends at the final syllable, so apps that caption generated speech should pad it.
 */
export function padWavWithSilence(wav: Buffer, seconds: number): Buffer {
  const decoded = decodeWav(wav);
  const pcm = Buffer.alloc((decoded.samples.length + Math.round(seconds * decoded.sampleRate)) * 2);
  decoded.samples.forEach((s, i) => pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(s * 32767))), i * 2));
  return pcm16ToWav(pcm, decoded.sampleRate);
}

// kbps by [MPEG-1 ? 0 : 1][layer 1..3]; MPEG-2 and 2.5 share a table.
const MP3_BITRATES: number[][][] = [
  [[], [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448], [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384], [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]],
  [[], [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256], [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160], [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]],
];
const MP3_SAMPLE_RATES: Record<number, number[]> = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

/** Adds up MP3 frame durations (works for constant and variable bitrate). Returns undefined if no frames are found. */
function mp3Seconds(data: Buffer): number | undefined {
  let i = 0;
  if (data.toString('latin1', 0, 3) === 'ID3' && data.length > 10) {
    i = 10 + (((data[6] & 0x7f) << 21) | ((data[7] & 0x7f) << 14) | ((data[8] & 0x7f) << 7) | (data[9] & 0x7f)) + (data[5] & 0x10 ? 10 : 0);
  }
  let seconds = 0;
  let frames = 0;
  while (i + 4 <= data.length) {
    if (data[i] !== 0xff || (data[i + 1] & 0xe0) !== 0xe0) {
      i++;
      continue;
    }
    const version = (data[i + 1] >> 3) & 3;
    const layer = 4 - ((data[i + 1] >> 1) & 3);
    const bitrateIndex = data[i + 2] >> 4;
    const rateIndex = (data[i + 2] >> 2) & 3;
    if (version === 1 || layer === 4 || bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) {
      i++;
      continue;
    }
    const kbps = MP3_BITRATES[version === 3 ? 0 : 1][layer][bitrateIndex];
    const rate = MP3_SAMPLE_RATES[version][rateIndex];
    const padding = (data[i + 2] >> 1) & 1;
    const samples = layer === 1 ? 384 : layer === 3 && version !== 3 ? 576 : 1152;
    const length = layer === 1 ? Math.floor((12 * kbps * 1000) / rate + padding) * 4 : Math.floor(((samples / 8) * kbps * 1000) / rate) + padding;
    seconds += samples / rate;
    frames++;
    i += length;
  }
  return frames ? seconds : undefined;
}

/** Length of a WAV or MP3 clip in seconds, for per-minute pricing. Undefined for other formats. */
export function audioDurationSec(data: Buffer): number | undefined {
  try {
    if (data.toString('latin1', 0, 4) === 'RIFF') return decodeWav(data).durationSec;
    return mp3Seconds(data);
  } catch {
    return undefined;
  }
}
