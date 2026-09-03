import { Log } from '../../lib/log';
import { httpFetch } from '../../lib/transport';

export type SttProvider = 'openai-compatible' | 'browser';

export interface SttConfig {
  provider: SttProvider;
  apiUrl: string;
  apiKey: string;
  model: string;
  language: string; // BCP-47, e.g. fr-FR
  prompt?: string;
}

export function sttEndpoint(apiUrl: string): string {
  const base = apiUrl.trim().replace(/\/+$/, '');
  if (base.endsWith('/transcriptions')) return base;
  if (base.endsWith('/audio')) return `${base}/transcriptions`;
  if (/\/v\d+$/.test(base)) return `${base}/audio/transcriptions`;
  return `${base}/v1/audio/transcriptions`;
}

/** Transcribe a WAV buffer through any OpenAI-compatible `/v1/audio/transcriptions` endpoint. */
export async function transcribeWav(wav: Uint8Array, config: SttConfig): Promise<string> {
  if (!config.apiUrl.trim()) throw new Error("URL de l'API de transcription non configurée.");
  const endpoint = sttEndpoint(config.apiUrl);
  const fields: Record<string, string> = {
    model: config.model || 'whisper-1',
    response_format: 'json'
  };
  if (config.language) fields.language = config.language.split('-')[0];
  if (config.prompt) fields.prompt = config.prompt;
  const headers: Record<string, string> = {};
  if (config.apiKey.trim()) headers.Authorization = `Bearer ${config.apiKey.trim()}`;

  Log.info('stt', `POST ${endpoint}`, { model: fields.model, bytes: wav.length });
  const res = await httpFetch({
    url: endpoint,
    method: 'POST',
    headers,
    multipart: { fields, file: { name: 'audio.wav', type: 'audio/wav', data: wav } },
    timeoutMs: 90_000
  });
  if (!res.ok) {
    let detail = res.text ?? '';
    try {
      const parsed = JSON.parse(detail) as { error?: { message?: string }; message?: string; detail?: string };
      detail = parsed.error?.message ?? parsed.message ?? parsed.detail ?? detail;
    } catch {
      /* raw text */
    }
    throw new Error(`Transcription refusée (HTTP ${res.status}) : ${detail.slice(0, 240)}`);
  }
  const text = res.text ?? '';
  try {
    const parsed = JSON.parse(text) as { text?: string; transcript?: string; segments?: Array<{ text: string }> };
    const value = parsed.text ?? parsed.transcript ?? parsed.segments?.map((s) => s.text).join(' ');
    if (typeof value === 'string') return value.trim();
  } catch {
    if (text.trim()) return text.trim();
  }
  throw new Error('Réponse de transcription invalide.');
}

/** Web Speech API fallback (Chromium routes it to Google; works only online, quality varies). */
export class BrowserRecognizer {
  private recognition: SpeechRecognition | null = null;

  static isSupported(): boolean {
    return typeof window !== 'undefined' && !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  }

  start(lang: string, onResult: (text: string) => void, onError: (message: string) => void, onEnd: () => void): void {
    const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Ctor) {
      onError("La reconnaissance vocale du navigateur n'est pas disponible.");
      return;
    }
    this.stop();
    const rec = new Ctor();
    rec.lang = lang;
    rec.continuous = false;
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    rec.onresult = (event) => {
      const text = event.results[0]?.[0]?.transcript ?? '';
      onResult(text);
    };
    rec.onerror = (event) => onError(event.error === 'not-allowed' ? 'Micro refusé par le navigateur.' : `Reconnaissance: ${event.error}`);
    rec.onend = () => {
      this.recognition = null;
      onEnd();
    };
    this.recognition = rec;
    try {
      rec.start();
    } catch (err) {
      onError((err as Error).message);
    }
  }

  stop(): void {
    try {
      this.recognition?.stop();
    } catch {
      /* ignore */
    }
    this.recognition = null;
  }
}
