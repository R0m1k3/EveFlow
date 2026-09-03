/** PCM utilities: merge, resample and encode 16-bit mono WAV. */

export function mergeChunks(chunks: Float32Array[], totalLength?: number): Float32Array {
  const length = totalLength ?? chunks.reduce((n, c) => n + c.length, 0);
  const out = new Float32Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    if (offset + chunk.length > length) {
      out.set(chunk.subarray(0, length - offset), offset);
      break;
    }
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** Linear-interpolation resampler with a box pre-filter when downsampling. */
export function resample(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate || input.length === 0) return input;
  const ratio = fromRate / toRate;
  const outLength = Math.max(1, Math.round(input.length / ratio));
  const out = new Float32Array(outLength);
  if (ratio > 1) {
    for (let i = 0; i < outLength; i++) {
      const start = Math.floor(i * ratio);
      const end = Math.min(input.length, Math.floor((i + 1) * ratio));
      let sum = 0;
      let count = 0;
      for (let j = start; j < end; j++) {
        sum += input[j];
        count++;
      }
      out[i] = count > 0 ? sum / count : input[Math.min(start, input.length - 1)];
    }
  } else {
    for (let i = 0; i < outLength; i++) {
      const pos = i * ratio;
      const idx = Math.floor(pos);
      const frac = pos - idx;
      const a = input[Math.min(idx, input.length - 1)];
      const b = input[Math.min(idx + 1, input.length - 1)];
      out[i] = a + (b - a) * frac;
    }
  }
  return out;
}

export function rms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

/** Peak-normalise quiet recordings so ASR models get a healthy signal. */
export function normalizeGain(samples: Float32Array, targetPeak = 0.9): Float32Array {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]));
  if (peak === 0 || peak >= targetPeak * 0.8) return samples;
  const gain = Math.min(8, targetPeak / peak);
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = samples[i] * gain;
  return out;
}

export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeString = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeString(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Uint8Array(buffer);
}

export interface WavResult {
  bytes: Uint8Array;
  sampleRate: number;
  durationSec: number;
}

/** Build a 16 kHz mono WAV (the format every OpenAI-compatible ASR accepts) from captured chunks. */
export function buildWav16k(chunks: Float32Array[], captureRate: number): WavResult {
  const merged = mergeChunks(chunks);
  const resampled = resample(merged, captureRate, 16_000);
  const normalized = normalizeGain(resampled);
  return { bytes: encodeWav(normalized, 16_000), sampleRate: 16_000, durationSec: normalized.length / 16_000 };
}
