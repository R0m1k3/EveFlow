/**
 * Microphone capture built on AudioWorklet (no deprecated ScriptProcessor, no mic monitoring
 * feedback). Produces 16 kHz WAV utterances, with energy VAD for hands-free auto stop.
 */
import { Log } from '../../lib/log';
import { audioBus } from './audioBus';
import { DEFAULT_VAD, EnergyVad, type VadOptions, type VadSignal } from './vad';
import { buildWav16k, rms, type WavResult } from './wav';

const WORKLET_SOURCE = `
class EveFlowCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(2048);
    this.offset = 0;
  }
  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const channel = input[0];
    if (!channel) return true;
    let i = 0;
    while (i < channel.length) {
      const n = Math.min(channel.length - i, this.buffer.length - this.offset);
      this.buffer.set(channel.subarray(i, i + n), this.offset);
      this.offset += n;
      i += n;
      if (this.offset === this.buffer.length) {
        this.port.postMessage(this.buffer, [this.buffer.buffer]);
        this.buffer = new Float32Array(2048);
        this.offset = 0;
      }
    }
    return true;
  }
}
registerProcessor('eveflow-capture', EveFlowCaptureProcessor);
`;

export type CaptureMode = 'auto' | 'manual';

export interface CaptureCallbacks {
  onLevel?: (level: number) => void;
  onSpeechStart?: () => void;
  onUtterance: (wav: WavResult) => void;
  onEnd: (reason: 'stopped' | 'speech-end' | 'no-speech' | 'too-short' | 'max-length' | 'error') => void;
  onError?: (message: string) => void;
}

export interface CaptureOptions {
  deviceId?: string;
  /** Chromium's echo cancellation / noise suppression / auto gain (default on). Off keeps the raw signal for the recogniser. */
  micProcessing?: boolean;
  mode: CaptureMode;
  vad?: Partial<VadOptions>;
  callbacks: CaptureCallbacks;
}

export interface MicDevice {
  deviceId: string;
  label: string;
}

let workletUrl: string | null = null;

function getWorkletUrl(): string {
  if (!workletUrl) workletUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'application/javascript' }));
  return workletUrl;
}

/**
 * Load an AudioWorklet module: first the static file shipped with the app (allowed by the strict
 * CSP, script-src 'self'), then a blob URL for dev servers that do not serve /worklets.
 */
export async function loadWorklet(ctx: AudioContext, name: string, blobUrl: () => string): Promise<void> {
  const staticUrl = new URL(`worklets/${name}.js`, document.baseURI).href;
  try {
    await ctx.audioWorklet.addModule(staticUrl);
    return;
  } catch (err) {
    Log.debug('audio', `static worklet ${name} unavailable (${(err as Error).message}), trying blob`);
  }
  await ctx.audioWorklet.addModule(blobUrl());
}

export async function listMicrophones(): Promise<MicDevice[]> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices
      .filter((d) => d.kind === 'audioinput')
      .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Microphone ${i + 1}` }));
  } catch {
    return [];
  }
}

export class MicCapture {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private worklet: AudioWorkletNode | null = null;
  private legacy: ScriptProcessorNode | null = null;
  private chunks: Float32Array[] = [];
  private totalSamples = 0;
  private vad: EnergyVad | null = null;
  private active = false;
  private options: CaptureOptions | null = null;
  private sampleRate = 16_000;
  private hadSpeech = false;

  get isActive(): boolean {
    return this.active;
  }

  async start(options: CaptureOptions): Promise<void> {
    if (this.active) this.stop('stopped');
    this.options = options;
    this.chunks = [];
    this.totalSamples = 0;
    this.hadSpeech = false;
    this.vad = options.mode === 'auto' ? new EnergyVad(options.vad ?? DEFAULT_VAD) : null;

    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("Le microphone n'est pas accessible dans cet environnement (getUserMedia indisponible).");
    }

    const constraints: MediaStreamConstraints = {
      audio: {
        deviceId: options.deviceId ? { exact: options.deviceId } : undefined,
        echoCancellation: options.micProcessing !== false,
        noiseSuppression: options.micProcessing !== false,
        autoGainControl: options.micProcessing !== false,
        channelCount: 1
      }
    };
    try {
      this.stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      const e = err as DOMException;
      const detail =
        e.name === 'NotAllowedError'
          ? "Accès au micro refusé. Vérifiez les paramètres de confidentialité Windows (Microphone) et relancez EveFlow."
          : e.name === 'NotFoundError'
            ? 'Aucun microphone détecté.'
            : e.name === 'NotReadableError'
              ? 'Le microphone est utilisé par une autre application.'
              : `${e.name}: ${e.message}`;
      Log.error('mic', 'getUserMedia failed', { name: e.name, message: e.message });
      throw new Error(detail);
    }

    try {
      this.ctx = new AudioContext({ sampleRate: 16_000, latencyHint: 'interactive' });
    } catch {
      this.ctx = new AudioContext({ latencyHint: 'interactive' });
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume().catch(() => undefined);
    this.sampleRate = this.ctx.sampleRate;

    const source = this.ctx.createMediaStreamSource(this.stream);
    const analyser = this.ctx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.5;
    source.connect(analyser);
    audioBus.setInputAnalyser(analyser);

    try {
      await loadWorklet(this.ctx, 'eveflow-capture', getWorkletUrl);
      this.worklet = new AudioWorkletNode(this.ctx, 'eveflow-capture', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1 });
      this.worklet.port.onmessage = (event: MessageEvent<Float32Array>) => this.onSamples(event.data);
      source.connect(this.worklet);
    } catch (err) {
      Log.warn('mic', `AudioWorklet unavailable, falling back to ScriptProcessor: ${(err as Error).message}`);
      const processor = this.ctx.createScriptProcessor(2048, 1, 1);
      processor.onaudioprocess = (e) => this.onSamples(new Float32Array(e.inputBuffer.getChannelData(0)));
      const mute = this.ctx.createGain();
      mute.gain.value = 0; // Chrome requires a destination path, but we never want to hear the mic.
      source.connect(processor);
      processor.connect(mute);
      mute.connect(this.ctx.destination);
      this.legacy = processor;
    }

    this.active = true;
    Log.info('mic', `capture started (${this.sampleRate} Hz, mode=${options.mode})`);
  }

  private onSamples(samples: Float32Array): void {
    if (!this.active || !this.options) return;
    this.chunks.push(samples);
    this.totalSamples += samples.length;
    // Before speech starts only a short pre-roll (~400 ms) is kept, so silence is never shipped to STT.
    if (this.vad && !this.hadSpeech) {
      while (this.chunks.length > 1 && this.totalSamples - this.chunks[0].length > this.sampleRate * 0.4) {
        this.totalSamples -= this.chunks.shift()!.length;
      }
    }
    const level = rms(samples);
    this.options.callbacks.onLevel?.(Math.min(1, level * 6));

    if (this.vad) {
      const frameMs = (samples.length / this.sampleRate) * 1000;
      const signal = this.vad.feed(level, frameMs);
      this.handleVad(signal);
    } else if (this.totalSamples / this.sampleRate > 120) {
      this.finishUtterance('max-length');
    }
  }

  private handleVad(signal: VadSignal): void {
    switch (signal) {
      case 'speech-start':
        this.hadSpeech = true;
        this.options?.callbacks.onSpeechStart?.();
        break;
      case 'speech-end':
      case 'max-length':
        this.finishUtterance(signal);
        break;
      case 'too-short':
      case 'no-speech':
        this.stop(signal);
        break;
      default:
        break;
    }
  }

  private finishUtterance(reason: 'speech-end' | 'max-length' | 'stopped'): void {
    const opts = this.options;
    const chunks = this.chunks;
    const rate = this.sampleRate;
    this.teardown();
    if (!opts) return;
    if (chunks.length === 0) {
      opts.callbacks.onEnd('no-speech');
      return;
    }
    const wav = buildWav16k(chunks, rate);
    Log.info('mic', `utterance captured: ${wav.durationSec.toFixed(2)}s, ${wav.bytes.length} bytes`);
    if (wav.durationSec < 0.25) {
      opts.callbacks.onEnd('too-short');
      return;
    }
    opts.callbacks.onUtterance(wav);
    opts.callbacks.onEnd(reason);
  }

  /** Stop capture. In manual mode this finalises the utterance; otherwise reports the reason. */
  stop(reason: 'stopped' | 'no-speech' | 'too-short' = 'stopped'): void {
    if (!this.active) return;
    // Manual stop: transcribe only if something was actually said (or no VAD is running).
    if (reason === 'stopped' && (!this.vad || this.hadSpeech)) {
      this.finishUtterance('stopped');
      return;
    }
    if (reason === 'stopped') reason = 'no-speech';
    const opts = this.options;
    this.teardown();
    opts?.callbacks.onEnd(reason);
  }

  /** Abort without producing an utterance. */
  cancel(): void {
    if (!this.active) return;
    this.teardown();
    this.options?.callbacks.onEnd('stopped');
  }

  private teardown(): void {
    this.active = false;
    audioBus.setInputAnalyser(null);
    if (this.worklet) {
      this.worklet.port.onmessage = null;
      this.worklet.disconnect();
      this.worklet = null;
    }
    if (this.legacy) {
      this.legacy.onaudioprocess = null;
      this.legacy.disconnect();
      this.legacy = null;
    }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
    this.chunks = [];
    this.totalSamples = 0;
  }
}
