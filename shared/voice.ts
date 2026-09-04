/** Local voice engine contract (sherpa-onnx in a utility process). Shared by main and renderer. */

export type VoiceModelKind = 'stt' | 'tts' | 'kws' | 'vad';
export type VoiceEngineKind = 'whisper' | 'sense-voice' | 'nemo-transducer' | 'kokoro' | 'piper' | 'kws-transducer' | 'silero';

export interface VoiceSpeaker {
  id: number;
  name: string;
  lang: string;
  /** m = masculine, f = feminine (from the catalog label). */
  gender?: 'm' | 'f';
}

export interface VoiceModelSpec {
  id: string;
  kind: VoiceModelKind;
  engine: VoiceEngineKind;
  name: string;
  description: string;
  languages: string[];
  sizeMb: number;
  url: string;
  /** Folder created by the archive (files are referenced relative to it). */
  dir: string;
  /** Files that must exist once installed. */
  files: string[];
  speakers?: VoiceSpeaker[];
  sampleRate?: number;
  recommended?: boolean;
}

export interface VoiceModelStatus extends VoiceModelSpec {
  installed: boolean;
  downloading: boolean;
  installedBytes: number;
}

export interface VoiceDownloadProgress {
  id: string;
  phase: 'download' | 'extract' | 'done' | 'error' | 'cancelled';
  received: number;
  total: number;
  percent: number;
  message?: string;
}

export interface TranscribeRequest {
  modelId: string;
  wav: Uint8Array;
  language: string; // 'fr', 'en', 'auto'
}

export interface TranscribeResult {
  text: string;
  language?: string;
  durationMs: number;
  audioSec: number;
}

export interface SynthesizeRequest {
  modelId: string;
  text: string;
  speaker: number;
  speed: number;
}

export interface SynthesizeResult {
  wav: Uint8Array;
  sampleRate: number;
  durationMs: number;
  audioSec: number;
}

export interface KwsStartRequest {
  modelId: string;
  /** Wake phrases in plain text (e.g. "jarvis", "hey jarvis"). */
  keywords: string[];
  /** 1 (strict) .. 5 (eager) */
  sensitivity: number;
}

export interface KwsDetection {
  keyword: string;
  at: number;
}

export interface VadStartRequest {
  modelId: string;
  /** Silence that ends an utterance, in ms. */
  silenceMs: number;
  /** Detection threshold 0..1 (0.5 default). */
  threshold: number;
  maxUtteranceSec: number;
}

export type VadEvent =
  | { type: 'speech-start' }
  | { type: 'segment'; wav: Uint8Array; durationSec: number }
  | { type: 'error'; message: string };

export interface VoiceEngineStatus {
  available: boolean;
  error?: string;
  version?: string;
  loaded: string[];
  modelsDir: string;
}

export const VOICE_IPC = {
  status: 'voice:status',
  modelsList: 'voice:models:list',
  modelsDownload: 'voice:models:download',
  modelsCancel: 'voice:models:cancel',
  modelsRemove: 'voice:models:remove',
  modelsProgress: 'voice:models:progress',
  transcribe: 'voice:transcribe',
  synthesize: 'voice:synthesize',
  unload: 'voice:unload',
  kwsStart: 'voice:kws:start',
  kwsStop: 'voice:kws:stop',
  kwsAudio: 'voice:kws:audio',
  kwsDetected: 'voice:kws:detected',
  vadStart: 'voice:vad:start',
  vadStop: 'voice:vad:stop',
  vadAudio: 'voice:vad:audio',
  vadEvent: 'voice:vad:event'
} as const;
