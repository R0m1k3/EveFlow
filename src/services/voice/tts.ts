/**
 * Text-to-speech engine with a sentence queue, prefetching and Web Audio playback so the HUD
 * reacts to the actual waveform. Providers: OpenAI-compatible /v1/audio/speech, system voices,
 * and the legacy Google Translate endpoint (no key, online only).
 */
import { Log } from '../../lib/log';
import { chunkForSpeech, cleanForSpeech, extractSentences } from '../../lib/text';
import { httpFetch } from '../../lib/transport';
import { audioBus } from './audioBus';

export type TtsProvider = 'openai-compatible' | 'system' | 'google-free' | 'off';

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
}

export type TtsState = 'idle' | 'loading' | 'speaking';

interface QueueItem {
  text: string;
  audio?: Promise<AudioBuffer | null>;
}

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
  private currentSource: AudioBufferSourceNode | null = null;
  private currentUtterance: SpeechSynthesisUtterance | null = null;
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
    audioBus.setVolume(config.volume);
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

  /** Speak a finished text (clears any pending speech first). */
  speak(text: string): void {
    this.stop();
    for (const chunk of chunkForSpeech(text)) this.enqueue(chunk);
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
    if (this.config.provider === 'off') return;
    const clean = cleanForSpeech(text);
    if (!clean || !/[\p{L}\p{N}]/u.test(clean)) return;
    const item: QueueItem = { text: clean };
    if (this.config.provider !== 'system') item.audio = this.prefetch(clean, this.generation);
    this.queue.push(item);
    void this.drain();
  }

  stop(): void {
    this.generation++;
    this.queue = [];
    this.streamBuffer = '';
    if (this.currentSource) {
      try {
        this.currentSource.onended = null;
        this.currentSource.stop();
      } catch {
        /* already stopped */
      }
      this.currentSource = null;
    }
    if (this.currentUtterance) {
      this.currentUtterance.onend = null;
      this.currentUtterance = null;
    }
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
      try {
        if (item.audio) {
          this.setState('loading');
          const buffer = await item.audio;
          if (gen !== this.generation) break;
          if (buffer) {
            this.setState('speaking');
            await this.playBuffer(buffer, gen);
          } else {
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
    const task = this.config.provider === 'google-free' ? this.fetchGoogle(text) : this.fetchOpenAi(text);
    return task
      .then(async (bytes) => {
        if (gen !== this.generation || !bytes) return null;
        await audioBus.resume();
        const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
        return audioBus.context.decodeAudioData(copy);
      })
      .catch((err) => {
        Log.warn('tts', `synthesis failed, falling back to system voice: ${(err as Error).message}`);
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
        voice: voice || 'alloy',
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
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      if (this.config.provider === 'google-free') source.playbackRate.value = Math.max(0.5, Math.min(2, this.config.speed || 1));
      source.connect(audioBus.output);
      source.onended = () => {
        if (this.currentSource === source) this.currentSource = null;
        resolve();
      };
      this.currentSource = source;
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
        if (this.currentUtterance === utterance) this.currentUtterance = null;
        resolve();
      };
      utterance.onend = finish;
      utterance.onerror = finish;
      this.currentUtterance = utterance;
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
    const candidates = voices.filter((v) => v.lang.toLowerCase().startsWith(lang));
    return candidates.sort((a, b) => scoreVoice(b) - scoreVoice(a))[0] ?? voices[0];
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
