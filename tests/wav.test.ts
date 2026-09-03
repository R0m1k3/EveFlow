import { describe, expect, it } from 'vitest';
import { buildWav16k, encodeWav, resample } from '../src/services/voice/wav';

describe('wav', () => {
  it('encodes a valid RIFF header at 16 kHz', () => {
    const samples = new Float32Array(1600).fill(0.5);
    const bytes = encodeWav(samples, 16000);
    const view = new DataView(bytes.buffer);
    expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe('RIFF');
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(bytes.length).toBe(44 + 1600 * 2);
  });

  it('resamples 48k to 16k and builds a wav', () => {
    const chunk = new Float32Array(4800).map((_, i) => Math.sin(i / 10) * 0.1);
    const wav = buildWav16k([chunk, chunk], 48000);
    expect(wav.sampleRate).toBe(16000);
    expect(Math.round(wav.durationSec * 100)).toBe(20);
    expect(resample(new Float32Array([0, 1]), 1, 2).length).toBe(4);
  });
});
