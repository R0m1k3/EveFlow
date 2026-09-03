/**
 * Shared Web Audio graph. Everything that is played (TTS) or captured (mic) passes through
 * analysers so the JARVIS core can react to the real signal.
 */
class AudioBus {
  private ctx: AudioContext | null = null;
  private outputGain: GainNode | null = null;
  private outputAnalyser: AnalyserNode | null = null;
  private inputAnalyser: AnalyserNode | null = null;
  private timeData = new Float32Array(1024);
  private freqData = new Uint8Array(512);
  private synthetic = 0;

  get context(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: 'interactive' });
      this.outputGain = this.ctx.createGain();
      this.outputAnalyser = this.ctx.createAnalyser();
      this.outputAnalyser.fftSize = 1024;
      this.outputAnalyser.smoothingTimeConstant = 0.6;
      this.outputGain.connect(this.outputAnalyser);
      this.outputAnalyser.connect(this.ctx.destination);
    }
    return this.ctx;
  }

  async resume(): Promise<void> {
    const ctx = this.context;
    if (ctx.state === 'suspended') await ctx.resume().catch(() => undefined);
  }

  get output(): AudioNode {
    this.context;
    return this.outputGain!;
  }

  setVolume(volume: number): void {
    this.context;
    this.outputGain!.gain.value = Math.max(0, Math.min(1.5, volume));
  }

  /** Attach an external analyser (mic capture) so the HUD can read the input level. */
  setInputAnalyser(analyser: AnalyserNode | null): void {
    this.inputAnalyser = analyser;
  }

  /** For engines that bypass Web Audio (system speech synthesis), fake a plausible level. */
  setSyntheticLevel(level: number): void {
    this.synthetic = level;
  }

  private rms(analyser: AnalyserNode): number {
    if (this.timeData.length !== analyser.fftSize) this.timeData = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(this.timeData);
    let sum = 0;
    for (let i = 0; i < this.timeData.length; i++) sum += this.timeData[i] * this.timeData[i];
    return Math.sqrt(sum / this.timeData.length);
  }

  /** Output loudness 0..1 (TTS). */
  outputLevel(): number {
    if (this.synthetic > 0) return this.synthetic;
    if (!this.outputAnalyser) return 0;
    return Math.min(1, this.rms(this.outputAnalyser) * 4);
  }

  /** Input loudness 0..1 (microphone). */
  inputLevel(): number {
    if (!this.inputAnalyser) return 0;
    return Math.min(1, this.rms(this.inputAnalyser) * 6);
  }

  /** Normalised output spectrum (0..1) with `bins` values, low to high frequency. */
  spectrum(bins: number, source: 'output' | 'input' = 'output', out: Float32Array = new Float32Array(bins)): Float32Array {
    const analyser = source === 'output' ? this.outputAnalyser : this.inputAnalyser;
    out.fill(0);
    if (!analyser) {
      if (this.synthetic > 0) {
        const t = performance.now() / 1000;
        for (let i = 0; i < bins; i++) {
          out[i] = Math.max(0, this.synthetic * (0.6 + 0.4 * Math.sin(t * 9 + i * 0.7)) * (1 - i / bins));
        }
      }
      return out;
    }
    if (this.freqData.length !== analyser.frequencyBinCount) this.freqData = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(this.freqData);
    // Only the lower half of the spectrum carries voice energy.
    const usable = Math.floor(this.freqData.length * 0.5);
    for (let i = 0; i < bins; i++) {
      const from = Math.floor((i / bins) * usable);
      const to = Math.max(from + 1, Math.floor(((i + 1) / bins) * usable));
      let sum = 0;
      for (let j = from; j < to; j++) sum += this.freqData[j];
      out[i] = sum / (to - from) / 255;
    }
    return out;
  }
}

export const audioBus = new AudioBus();
