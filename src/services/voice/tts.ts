/**
 * Text-to-speech engine with a sentence queue, bounded prefetching and Web Audio playback so
 * the HUD reacts to the actual waveform. Providers: in-app sherpa-onnx (Kokoro / Piper),
 * OpenAI-compatible /v1/audio/speech, system voices, and the legacy Google Translate endpoint.
 */
import { Log } from '../../lib/log';
import { defaultOpenAiVoice, rankSystemVoice } from '../../lib/voicePreference';
import { bridge } from '../../lib/bridge';
import { chunkForSpeech, cleanForSpeech, extractSentences } from '../../lib/text';
import { httpFetch } from '../../lib/transport';
import { audioBus } from './audioBus';

export type TtsProvider = 'openai-compatible' | 'system' | 'google-free' | 'local' | 'off';

export interface TtsConfig {
  provider: TtsProvider;
  apiUrl: string;
  apiKey: string;
  model: string;
  voice: string;
  speed: number; // 0.5 - 2
  format: 'mp3' | 'wav' | 'opus';
  systemVoice: string;
  language: string;
  volume: number;
  /** Catalog id of the local sherpa-onnx voice model (provider 'local'). */
  localModel: string;
  /** Speaker id inside the local model. */
  localSpeaker: number;
  /** Preferred voice gender, applied to every provider's default voice. */
  voiceGender?: 'male' | 'female';
}

export type TtsState = 'idle' | 'loading' | 'speaking';

interface QueueItem {
  text: string;
  audio?: Promise<AudioBuffer | null>;
}

const LOOKAHEAD = 2;

export function ttsEndpoint(apiUrl: string): string {
  const base = apiUrl.trim().replace(/\/+$/, '');
  if (base.endsWith('/speech')) return base;
  if (base.endsWith('/audio')) return `${base}/speech`;
  if (/\/v\d+$/.test(base)) return `${base}/audio/speech`;
  return `${base}/v1/audio/speech`;
}

export class TtsEngine {
  private queue: QueueItem[] = [];
  private playing = false;
  private cancelCurrent: (() => void) | null = null;
  private streamBuffer = '';
  private generation = 0;
  private config: TtsConfig;
  private listeners = new Set<(state: TtsState) => void>();
  private state: TtsState = 'idle';

  constructor(config: TtsConfig) {
    this.config = config;
  }

  updateConfig(config: TtsConfig): void {
    this.config = config;
  }

  onState(listener: (state: TtsState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get isActive(): boolean {
    return this.playing || this.queue.length > 0;
  }

  private setState(state: TtsState): void {
    if (this.state === state) return;
    this.state = state;
    for (const l of this.listeners) l(state);
  }

  /**
   * Speak a finished text. With `interrupt` (default) pending speech is discarded first;
   * without it the text is inserted ahead of the queue and streamed speech resumes afterwards.
   */
  speak(text: string, options: { interrupt?: boolean } = {}): void {
    const interrupt = options.interrupt ?? true;
    if (interrupt) this.stop();
    const items = chunkForSpeech(text).map((chunk) => this.makeItem(chunk)).filter((i): i is QueueItem => !!i);
    if (interrupt) this.queue.push(...items);
    else this.queue.unshift(...items);
    this.fillPrefetch();
    void this.drain();
  }

  /** Feed streamed tokens; complete sentences are spoken as soon as they are available. */
  pushStream(delta: string): void {
    this.streamBuffer += delta;
    const { sentences, rest } = extractSentences(this.streamBuffer);
    this.streamBuffer = rest;
    for (const sentence of sentences) this.enqueue(sentence);
  }

  /** Flush the remainder of a streamed message. */
  endStream(): void {
    const rest = this.streamBuffer.trim();
    this.streamBuffer = '';
    if (rest) for (const chunk of chunkForSpeech(rest)) this.enqueue(chunk);
  }

  enqueue(text: string): void {
    const item = this.makeItem(text);
    if (!item) return;
    this.queue.push(item);
    this.fillPrefetch();
    void this.drain();
  }

  private makeItem(text: string): QueueItem | null {
    if (this.config.provider === 'off') return null;
    const clean = cleanForSpeech(text);
    if (!clean || !/[\p{L}\p{N}]/u.test(clean)) return null;
    return { text: clean };
  }

  /** Keep at most LOOKAHEAD synthesis requests in flight ahead of playback. */
  private fillPrefetch(): void {
    if (this.config.provider === 'system') return;
    for (const item of this.queue.slice(0, LOOKAHEAD)) item.audio ??= this.prefetch(item.text, this.generation);
  }

  stop(): void {
    this.generation++;
    this.queue = [];
    this.streamBuffer = '';
    this.cancelCurrent?.();
    this.cancelCurrent = null;
    if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
    audioBus.setSyntheticLevel(0);
    this.playing = false;
    this.setState('idle');
  }

  private async drain(): Promise<void> {
    if (this.playing) return;
    this.playing = true;
    const gen = this.generation;
    while (this.queue.length > 0 && gen === this.generation) {
      const item = this.queue.shift()!;
      this.fillPrefetch();
      try {
        if (this.config.provider !== 'system') {
          this.setState('loading');
          const buffer = await (item.audio ?? this.prefetch(item.text, gen));
          if (gen !== this.generation) break;
          if (buffer) {
            this.setState('speaking');
            await this.playBuffer(buffer, gen);
          } else {
            this.setState('speaking');
            await this.speakSystem(item.text, gen);
          }
        } else {
          this.setState('speaking');
          await this.speakSystem(item.text, gen);
        }
      } catch (err) {
        Log.warn('tts', `segment failed: ${(err as Error).message}`);
      }
    }
    if (gen === this.generation) {
      this.playing = false;
      this.setState('idle');
    }
  }

  private prefetch(text: string, gen: number): Promise<AudioBuffer | null> {
    const task =
      this.config.provider === 'google-free' ? this.fetchGoogle(text) : this.config.provider === 'local' ? this.fetchLocal(text) : this.fetchOpenAi(text);
    return task
      .then(async (bytes) => {
        if (gen !== this.generation || !bytes) return null;
        await audioBus.resume();
        const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
        return audioBus.context.decodeAudioData(copy);
      })
      .catch((err) => {
        if (gen === this.generation) Log.warn('tts', `synthesis failed, falling back to system voice: ${(err as Error).message}`);
        return null;
      });
  }

  private async fetchOpenAi(text: string): Promise<Uint8Array> {
    const { apiUrl, apiKey, model, voice, speed, format } = this.config;
    if (!apiUrl.trim()) throw new Error('URL TTS non configurée');
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey.trim()) headers.Authorization = `Bearer ${apiKey.trim()}`;
    const res = await httpFetch({
      url: ttsEndpoint(apiUrl),
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: model || 'tts-1',
        input: text,
        voice: voice || defaultOpenAiVoice(this.config.voiceGender ?? 'male'),
        speed: Math.max(0.5, Math.min(2, speed || 1)),
        response_format: format || 'mp3'
      }),
      responseType: 'binary',
      timeoutMs: 60_000
    });
    if (!res.ok || !res.binary) {
      const body = res.binary ? new TextDecoder().decode(res.binary).slice(0, 200) : '';
      throw new Error(`HTTP ${res.status} ${body}`);
    }
    return res.binary;
  }

  private async fetchLocal(text: string): Promise<Uint8Array> {
    const api = bridge();
    if (!api) throw new Error('La synthèse locale nécessite l’application Electron.');
    if (!this.config.localModel) throw new Error('Aucun modèle de voix local sélectionné.');
    const result = await api.voice.synthesize({
      modelId: this.config.localModel,
      text,
      speaker: this.config.localSpeaker,
      speed: Math.max(0.5, Math.min(2, this.config.speed || 1))
    });
    Log.debug('tts', `local synthesis ${result.durationMs} ms for ${result.audioSec.toFixed(1)}s of audio`);
    return result.wav;
  }

  private async fetchGoogle(text: string): Promise<Uint8Array> {
    const url = `https://translate.google.com/translate_tts?ie=UTF-8&tl=${encodeURIComponent(this.config.language.split('-')[0] || 'fr')}&client=tw-ob&q=${encodeURIComponent(text.slice(0, 200))}`;
    const res = await httpFetch({
      url,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
        Referer: 'https://translate.google.com/'
      },
      responseType: 'binary',
      timeoutMs: 15_000
    });
    if (!res.ok || !res.binary) throw new Error(`Google TTS HTTP ${res.status}`);
    return res.binary;
  }

  private playBuffer(buffer: AudioBuffer, gen: number): Promise<void> {
    return new Promise((resolve) => {
      if (gen !== this.generation) return resolve();
      const ctx = audioBus.context;
      audioBus.setVolume(this.config.volume);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      if (this.config.provider === 'google-free') source.playbackRate.value = Math.max(0.5, Math.min(2, this.config.speed || 1));
      source.connect(audioBus.output);
      const finish = () => {
        if (this.cancelCurrent === cancel) this.cancelCurrent = null;
        resolve();
      };
      const cancel = () => {
        source.onended = null;
        try {
          source.stop();
        } catch {
          /* already stopped */
        }
        finish();
      };
      source.onended = finish;
      this.cancelCurrent = cancel;
      source.start();
    });
  }

  private speakSystem(text: string, gen: number): Promise<void> {
    return new Promise((resolve) => {
      if (typeof speechSynthesis === 'undefined' || gen !== this.generation) return resolve();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = this.config.language || 'fr-FR';
      utterance.rate = Math.max(0.5, Math.min(2, this.config.speed || 1));
      utterance.pitch = 1;
      utterance.volume = Math.max(0, Math.min(1, this.config.volume));
      const voice = this.resolveSystemVoice();
      if (voice) utterance.voice = voice;
      let pulse: ReturnType<typeof setInterval> | null = setInterval(() => {
        audioBus.setSyntheticLevel(0.35 + Math.random() * 0.4);
      }, 90);
      const finish = () => {
        if (pulse) clearInterval(pulse);
        pulse = null;
        audioBus.setSyntheticLevel(0);
        if (this.cancelCurrent === cancel) this.cancelCurrent = null;
        resolve();
      };
      const cancel = () => {
        utterance.onend = null;
        utterance.onerror = null;
        finish();
      };
      utterance.onend = finish;
      utterance.onerror = finish;
      this.cancelCurrent = cancel;
      speechSynthesis.speak(utterance);
    });
  }

  private resolveSystemVoice(): SpeechSynthesisVoice | undefined {
    if (typeof speechSynthesis === 'undefined') return undefined;
    const voices = speechSynthesis.getVoices();
    if (this.config.systemVoice) {
      const exact = voices.find((v) => v.name === this.config.systemVoice);
      if (exact) return exact;
    }
    const lang = (this.config.language || 'fr').toLowerCase().split('-')[0];
    const gender = this.config.voiceGender ?? 'male';
    return [...voices].sort((a, b) => rankSystemVoice(b, lang, gender) - rankSystemVoice(a, lang, gender))[0];
  }
}

export function scoreVoice(v: SpeechSynthesisVoice): number {
  const name = v.name.toLowerCase();
  let score = 0;
  if (name.includes('natural') || name.includes('neural') || name.includes('online')) score += 40;
  if (name.includes('google')) score += 30;
  if (name.includes('microsoft')) score += 10;
  if (v.localService) score += 5;
  return score;
}

export function listSystemVoices(): SpeechSynthesisVoice[] {
  if (typeof speechSynthesis === 'undefined') return [];
  return [...speechSynthesis.getVoices()].sort((a, b) => a.lang.localeCompare(b.lang) || scoreVoice(b) - scoreVoice(a));
}
