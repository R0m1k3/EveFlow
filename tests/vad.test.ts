import { describe, expect, it } from 'vitest';
import { EnergyVad } from '../src/services/voice/vad';

const feed = (vad: EnergyVad, rms: number, ms: number, step = 64): string[] => {
  const out: string[] = [];
  for (let t = 0; t < ms; t += step) out.push(vad.feed(rms, step));
  return out;
};

describe('EnergyVad', () => {
  it('detects start and end of speech after silence', () => {
    const vad = new EnergyVad({ silenceMs: 500, minSpeechMs: 200 });
    expect(new Set(feed(vad, 0.003, 600))).toEqual(new Set(['idle']));
    expect(feed(vad, 0.2, 800)).toContain('speech-start');
    expect(feed(vad, 0.003, 700)).toContain('speech-end');
    expect(vad.isSpeaking).toBe(false);
  });

  it('reports too-short bursts and no-speech timeouts', () => {
    const vad = new EnergyVad({ silenceMs: 300, minSpeechMs: 400, noSpeechTimeoutMs: 20000 });
    feed(vad, 0.003, 500);
    feed(vad, 0.3, 150);
    expect(feed(vad, 0.003, 400)).toContain('too-short');
    const quiet = new EnergyVad({ noSpeechTimeoutMs: 1000 });
    expect(feed(quiet, 0.002, 1200)).toContain('no-speech');
  });
});
