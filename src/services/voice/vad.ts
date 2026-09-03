/**
 * Energy-based voice activity detector with an adaptive noise floor.
 * Pure logic (no Web Audio) so it can be unit tested.
 */
export interface VadOptions {
  /** Signal must exceed noiseFloor * ratio (and absolute minimum) to count as speech. */
  speechRatio: number;
  minRms: number;
  /** Silence duration that ends an utterance. */
  silenceMs: number;
  /** Minimum duration of speech before it is considered a real utterance. */
  minSpeechMs: number;
  /** Hard cap on one utterance. */
  maxUtteranceMs: number;
  /** Give up if nobody speaks for this long after starting. */
  noSpeechTimeoutMs: number;
}

export const DEFAULT_VAD: VadOptions = {
  speechRatio: 2.6,
  minRms: 0.012,
  silenceMs: 900,
  minSpeechMs: 250,
  maxUtteranceMs: 45_000,
  noSpeechTimeoutMs: 9_000
};

export type VadSignal = 'idle' | 'speech-start' | 'speaking' | 'speech-end' | 'too-short' | 'no-speech' | 'max-length';

export class EnergyVad {
  private noiseFloor: number;
  private speaking = false;
  private speechMs = 0;
  private silenceMs = 0;
  private elapsedMs = 0;
  private calibrationMs = 0;
  readonly options: VadOptions;

  constructor(options: Partial<VadOptions> = {}) {
    this.options = { ...DEFAULT_VAD, ...options };
    this.noiseFloor = this.options.minRms;
  }

  get isSpeaking(): boolean {
    return this.speaking;
  }

  get floor(): number {
    return this.noiseFloor;
  }

  /** Feed one analysis frame. Returns the transition that occurred. */
  feed(frameRms: number, frameMs: number): VadSignal {
    const o = this.options;
    this.elapsedMs += frameMs;
    const threshold = Math.max(o.minRms, this.noiseFloor * o.speechRatio);
    const loud = frameRms > threshold;

    // Adaptive noise floor: fast during the first 400 ms, slow afterwards, only while not speaking.
    if (!loud || this.calibrationMs < 400) {
      const alpha = this.calibrationMs < 400 ? 0.25 : 0.02;
      this.noiseFloor = this.noiseFloor * (1 - alpha) + frameRms * alpha;
      this.calibrationMs += frameMs;
    }

    if (!this.speaking) {
      if (loud) {
        this.speechMs += frameMs;
        if (this.speechMs >= Math.min(120, o.minSpeechMs)) {
          this.speaking = true;
          this.silenceMs = 0;
          return 'speech-start';
        }
      } else {
        this.speechMs = 0;
        if (this.elapsedMs >= o.noSpeechTimeoutMs) return 'no-speech';
      }
      return 'idle';
    }

    // speaking
    this.speechMs += frameMs;
    if (loud) this.silenceMs = 0;
    else this.silenceMs += frameMs;

    if (this.speechMs >= o.maxUtteranceMs) return this.finish('max-length');
    if (this.silenceMs >= o.silenceMs) {
      const spoken = this.speechMs - this.silenceMs;
      return this.finish(spoken >= o.minSpeechMs ? 'speech-end' : 'too-short');
    }
    return 'speaking';
  }

  private finish(signal: VadSignal): VadSignal {
    this.speaking = false;
    this.speechMs = 0;
    this.silenceMs = 0;
    return signal;
  }

  reset(): void {
    this.speaking = false;
    this.speechMs = 0;
    this.silenceMs = 0;
    this.elapsedMs = 0;
  }
}
