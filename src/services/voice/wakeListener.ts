/**
 * Always-on microphone for the keyword spotter. Streams 16 kHz PCM to the main process
 * (which feeds the sherpa-onnx spotter); once the wake word is detected it captures the
 * following utterance with the energy VAD and hands back a WAV, then resumes spotting.
 * One microphone stream, no re-opening between phrases.
 */
import { bridge } from '../../lib/bridge';
import { Log } from '../../lib/log';
import { audioBus } from './audioBus';
import { loadWorklet } from './capture';
import { DEFAULT_VAD, EnergyVad, type VadOptions } from './vad';
import { buildWav16k, rms, type WavResult } from './wav';
import type { VadEvent } from '../../../shared/voice';

const WORKLET_SOURCE = `
class EveFlowWakeProcessor extends AudioWorkletProcessor {
  constructor() { super(); this.buffer = new Float32Array(2048); this.offset = 0; }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    let i = 0;
    while (i < channel.length) {
      const n = Math.min(channel.length - i, this.buffer.length - this.offset);
      this.buffer.set(channel.subarray(i, i + n), this.offset);
      this.offset += n; i += n;
      if (this.offset === this.buffer.length) {
        this.port.postMessage(this.buffer, [this.buffer.buffer]);
        this.buffer = new Float32Array(2048); this.offset = 0;
      }
    }
    return true;
  }
}
registerProcessor('eveflow-wake', EveFlowWakeProcessor);
`;

export type WakePhase = 'off' | 'spotting' | 'command' | 'speech';

export interface WakeCallbacks {
  onPhase: (phase: WakePhase) => void;
  onLevel?: (level: number) => void;
  onUtterance: (wav: WavResult) => void;
  onNoSpeech: () => void;
  onError: (message: string) => void;
}

let workletUrl: string | null = null;

export class WakeListener {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;
  private phase: WakePhase = 'off';
  private vad: EnergyVad | null = null;
  private chunks: Float32Array[] = [];
  private totalSamples = 0;
  private sampleRate = 16_000;
  private pending: Float32Array[] = [];
  private pendingSamples = 0;
  private callbacks: WakeCallbacks | null = null;
  private vadOptions: Partial<VadOptions> = {};
  private noSpeechTimer: ReturnType<typeof setTimeout> | null = null;
  /** Neural end-of-speech (Silero in the main process) instead of the energy VAD. */
  private neural = false;
  private unsubscribeVad: (() => void) | null = null;
  private vadPending: Float32Array[] = [];
  private vadPendingSamples = 0;

  get isActive(): boolean {
    return this.phase !== 'off';
  }

  get currentPhase(): WakePhase {
    return this.phase;
  }

  async start(options: { deviceId?: string; vad?: Partial<VadOptions>; neuralVad?: boolean; callbacks: WakeCallbacks }): Promise<void> {
    if (this.phase !== 'off') return;
    this.callbacks = options.callbacks;
    this.vadOptions = options.vad ?? {};
    this.neural = !!options.neuralVad;
    if (this.neural) {
      this.unsubscribeVad?.();
      this.unsubscribeVad = bridge()?.voice.onVadEvent((event) => this.onVadEvent(event)) ?? null;
    }
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: options.deviceId ? { exact: options.deviceId } : undefined,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1
      }
    });
    try {
      this.ctx = new AudioContext({ sampleRate: 16_000, latencyHint: 'playback' });
    } catch {
      this.ctx = new AudioContext({ latencyHint: 'playback' });
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume().catch(() => undefined);
    this.sampleRate = this.ctx.sampleRate;
    const source = this.ctx.createMediaStreamSource(this.stream);
    const analyser = this.ctx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    audioBus.setInputAnalyser(analyser);
    await loadWorklet(this.ctx, 'eveflow-wake', () => {
      if (!workletUrl) workletUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'application/javascript' }));
      return workletUrl;
    });
    this.node = new AudioWorkletNode(this.ctx, 'eveflow-wake', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1 });
    this.node.port.onmessage = (event: MessageEvent<Float32Array>) => this.onSamples(event.data);
    source.connect(this.node);
    this.setPhase('spotting');
    Log.info('wake', `listener started (${this.sampleRate} Hz, fin de phrase ${this.neural ? 'Silero' : 'énergie'})`);
  }

  private onVadEvent(event: VadEvent): void {
    if (!this.neural || (this.phase !== 'command' && this.phase !== 'speech')) return;
    if (event.type === 'speech-start') {
      if (this.phase === 'command') {
        this.setPhase('speech');
        if (this.noSpeechTimer) clearTimeout(this.noSpeechTimer);
        this.noSpeechTimer = null;
      }
    } else if (event.type === 'segment') {
      const wav: WavResult = { bytes: event.wav, sampleRate: 16_000, durationSec: event.durationSec };
      this.resumeSpotting();
      if (wav.durationSec >= 0.25) this.callbacks?.onUtterance(wav);
      else this.callbacks?.onNoSpeech();
    } else if (event.type === 'error') {
      this.callbacks?.onError(event.message);
      this.resumeSpotting();
    }
  }

  /** Called by the controller when the main process reports the wake word (or on manual trigger). */
  beginCommand(): void {
    if (this.phase === 'off' || this.phase === 'command' || this.phase === 'speech') return;
    this.vad = this.neural ? null : new EnergyVad({ ...DEFAULT_VAD, ...this.vadOptions, noSpeechTimeoutMs: Number.POSITIVE_INFINITY });
    this.vadPending = [];
    this.vadPendingSamples = 0;
    this.chunks = [];
    this.totalSamples = 0;
    this.setPhase('command');
    if (this.noSpeechTimer) clearTimeout(this.noSpeechTimer);
    this.noSpeechTimer = setTimeout(() => {
      if (this.phase === 'command') {
        this.resumeSpotting();
        this.callbacks?.onNoSpeech();
      }
    }, 8000);
  }

  /** Abort a command capture and go back to spotting. */
  cancelCommand(): void {
    if (this.phase === 'command' || this.phase === 'speech') this.resumeSpotting();
  }

  stop(): void {
    if (this.phase === 'off') return;
    if (this.noSpeechTimer) clearTimeout(this.noSpeechTimer);
    this.noSpeechTimer = null;
    this.unsubscribeVad?.();
    this.unsubscribeVad = null;
    audioBus.setInputAnalyser(null);
    if (this.node) {
      this.node.port.onmessage = null;
      this.node.disconnect();
      this.node = null;
    }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
    this.chunks = [];
    this.pending = [];
    this.pendingSamples = 0;
    this.vadPending = [];
    this.vadPendingSamples = 0;
    this.setPhase('off');
    Log.info('wake', 'listener stopped');
  }

  private setPhase(phase: WakePhase): void {
    this.phase = phase;
    this.callbacks?.onPhase(phase);
  }

  private resumeSpotting(): void {
    if (this.noSpeechTimer) clearTimeout(this.noSpeechTimer);
    this.noSpeechTimer = null;
    this.vad = null;
    this.chunks = [];
    this.totalSamples = 0;
    this.setPhase('spotting');
  }

  private onSamples(samples: Float32Array): void {
    if (this.phase === 'off') return;
    const level = rms(samples);
    this.callbacks?.onLevel?.(Math.min(1, level * 6));

    if (this.phase === 'spotting') {
      // Batch ~256 ms of audio per IPC message for the keyword spotter.
      this.pending.push(samples);
      this.pendingSamples += samples.length;
      if (this.pendingSamples >= this.sampleRate * 0.25) this.flushToSpotter();
      return;
    }

    if (this.neural) {
      // command / speech with Silero: stream ~128 ms frames to the main process, which returns the segment.
      this.vadPending.push(samples);
      this.vadPendingSamples += samples.length;
      if (this.vadPendingSamples >= this.sampleRate * 0.128) this.flushToVad();
      return;
    }

    // command / speech: collect the utterance
    this.chunks.push(samples);
    this.totalSamples += samples.length;
    if (this.vad && this.phase === 'command') {
      // keep only a short pre-roll before speech starts
      while (this.chunks.length > 1 && this.totalSamples - this.chunks[0].length > this.sampleRate * 0.4) {
        this.totalSamples -= this.chunks.shift()!.length;
      }
    }
    if (!this.vad) return;
    const signal = this.vad.feed(level, (samples.length / this.sampleRate) * 1000);
    if (signal === 'speech-start') {
      this.setPhase('speech');
      if (this.noSpeechTimer) clearTimeout(this.noSpeechTimer);
      this.noSpeechTimer = null;
    } else if (signal === 'speech-end' || signal === 'max-length') {
      const wav = buildWav16k(this.chunks, this.sampleRate);
      this.resumeSpotting();
      if (wav.durationSec >= 0.25) this.callbacks?.onUtterance(wav);
      else this.callbacks?.onNoSpeech();
    } else if (signal === 'too-short') {
      this.resumeSpotting();
      this.callbacks?.onNoSpeech();
    }
  }

  private static toInt16(chunks: Float32Array[], total: number): Uint8Array {
    const merged = new Int16Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      for (let i = 0; i < chunk.length; i++) {
        const s = Math.max(-1, Math.min(1, chunk[i]));
        merged[offset + i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      offset += chunk.length;
    }
    return new Uint8Array(merged.buffer);
  }

  private flushToSpotter(): void {
    const api = bridge();
    if (!api) return;
    const bytes = WakeListener.toInt16(this.pending, this.pendingSamples);
    this.pending = [];
    this.pendingSamples = 0;
    api.voice.kwsAudio(bytes, this.sampleRate);
  }

  private flushToVad(): void {
    const api = bridge();
    if (!api) return;
    const bytes = WakeListener.toInt16(this.vadPending, this.vadPendingSamples);
    this.vadPending = [];
    this.vadPendingSamples = 0;
    api.voice.vadAudio(bytes, this.sampleRate);
  }
}
