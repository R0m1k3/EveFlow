import { create } from 'zustand';
import { persistGet, persistSet } from '../lib/persist';
import { uid } from '../lib/id';
import type { HermesConfig } from '../services/hermes/types';
import type { SttConfig } from '../services/voice/stt';
import type { TtsConfig } from '../services/voice/tts';

export type HudTheme = 'arc' | 'gold' | 'crimson' | 'emerald';

export interface VoiceSettings extends SttConfig {
  /** auto = VAD auto-stop, manual = click to stop */
  captureMode: 'auto' | 'manual';
  handsFree: boolean;
  bargeIn: boolean;
  micDeviceId: string;
  silenceMs: number;
  sensitivity: number; // 1 (low) .. 5 (high)
  wakeChime: boolean;
  /** Hands-free: only react to utterances starting with this word (local STT recommended). */
  wakeWordEnabled: boolean;
  wakeWord: string;
  /** off = push-to-talk / hands-free; transcript = filter after transcription; kws = always-on keyword spotting. */
  wakeMode: 'off' | 'transcript' | 'kws';
  kwsSensitivity: number; // 1..5
}

export interface SpeechSettings extends TtsConfig {
  autoSpeak: boolean;
  speakIncoming: boolean;
}

export interface WebhookSettings {
  enabled: boolean;
  port: number;
  secret: string;
}

export interface Settings {
  version: 2;
  assistantName: string;
  userName: string;
  theme: HudTheme;
  language: string;
  hermes: HermesConfig;
  voice: VoiceSettings;
  speech: SpeechSettings;
  webhook: WebhookSettings;
  ui: {
    showTelemetry: boolean;
    showReasoning: boolean;
    reduceMotion: boolean;
    compactOpacity: number;
  };
  hermesSessionId: string;
}

export const DEFAULT_SETTINGS: Settings = {
  version: 2,
  assistantName: 'JARVIS',
  userName: '',
  theme: 'arc',
  language: 'fr-FR',
  hermes: {
    url: 'http://127.0.0.1:8642',
    apiKey: '',
    model: '',
    sessionKey: 'eveflow-desktop',
    transport: 'auto',
    reasoningEffort: '',
    instructions:
      "Tu es l'interface vocale EveFlow (style JARVIS). Réponds en français, de façon concise et orale quand la question est simple; utilise le Markdown uniquement pour le contenu structuré (code, listes, tableaux). Les images doivent être des URL http(s) ou des fichiers du dossier partagé.",
    localTools: true
  },
  voice: {
    provider: 'openai-compatible',
    apiUrl: 'http://127.0.0.1:8000/v1',
    apiKey: '',
    model: 'Qwen/Qwen3-ASR-0.6B',
    language: 'fr-FR',
    captureMode: 'auto',
    handsFree: false,
    bargeIn: false,
    micDeviceId: '',
    silenceMs: 900,
    sensitivity: 3,
    wakeChime: true,
    wakeWordEnabled: false,
    wakeWord: 'jarvis',
    wakeMode: 'off',
    kwsSensitivity: 3,
    localModel: 'whisper-base'
  },
  speech: {
    provider: 'openai-compatible',
    apiUrl: 'http://127.0.0.1:8000/v1',
    apiKey: '',
    model: 'tts-1',
    voice: 'alloy',
    speed: 1.05,
    format: 'mp3',
    systemVoice: '',
    language: 'fr-FR',
    volume: 1,
    localModel: 'kokoro-v1',
    localSpeaker: 30,
    autoSpeak: true,
    speakIncoming: true
  },
  webhook: { enabled: true, port: 7842, secret: '' },
  ui: { showTelemetry: true, showReasoning: false, reduceMotion: false, compactOpacity: 0.92 },
  hermesSessionId: ''
};

const STORAGE_KEY = 'eveflow.settings.v2';

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

function merge<T extends object>(base: T, patch: DeepPartial<T> | null | undefined): T {
  if (!patch) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch)) {
    const current = (base as Record<string, unknown>)[key];
    if (value && typeof value === 'object' && !Array.isArray(value) && current && typeof current === 'object' && !Array.isArray(current)) {
      out[key] = merge(current as object, value as DeepPartial<object>);
    } else if (value !== undefined) {
      out[key] = value;
    }
  }
  return out as T;
}

/** Import the settings of the 1.x releases (flat keys in the store). */
async function migrateLegacy(): Promise<DeepPartial<Settings>> {
  const patch: DeepPartial<Settings> = { hermes: {}, voice: {}, speech: {} };
  const legacyConfig = await persistGet<string | Record<string, string>>('eveflow_agent_config');
  const parsed = typeof legacyConfig === 'string' ? (JSON.parse(legacyConfig) as Record<string, string>) : legacyConfig;
  if (parsed) {
    if (parsed.hermesUrl) patch.hermes!.url = parsed.hermesUrl;
    if (parsed.hermesApiKey) patch.hermes!.apiKey = parsed.hermesApiKey;
    if (parsed.hermesModel && parsed.hermesModel !== 'hermes-agent') patch.hermes!.model = parsed.hermesModel;
    if (parsed.hermesSessionKey) patch.hermes!.sessionKey = parsed.hermesSessionKey;
  }
  const read = async (key: string) => {
    const v = await persistGet<string>(key);
    return typeof v === 'string' ? v : null;
  };
  const sttUrl = await read('eveflow_stt_api_url');
  if (sttUrl) patch.voice!.apiUrl = sttUrl;
  const sttKey = await read('eveflow_stt_api_key');
  if (sttKey) patch.voice!.apiKey = sttKey;
  const sttModel = await read('eveflow_stt_model');
  if (sttModel) patch.voice!.model = sttModel;
  const ttsUrl = await read('eveflow_tts_api_url');
  if (ttsUrl) patch.speech!.apiUrl = ttsUrl;
  const ttsKey = await read('eveflow_tts_api_key');
  if (ttsKey) patch.speech!.apiKey = ttsKey;
  const ttsModel = await read('eveflow_tts_model');
  if (ttsModel) patch.speech!.model = ttsModel;
  const ttsProvider = await read('eveflow_tts_provider');
  if (ttsProvider === 'system' || ttsProvider === 'google-free') patch.speech!.provider = ttsProvider;
  const sessionId = await read('eveflow_hermes_session_id');
  if (sessionId) patch.hermesSessionId = sessionId;
  return patch;
}

interface SettingsStore {
  settings: Settings;
  loaded: boolean;
  load: () => Promise<void>;
  update: (patch: DeepPartial<Settings>) => void;
  reset: () => void;
  setHermesSessionId: (id: string) => void;
}

export const useSettings = create<SettingsStore>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  loaded: false,
  load: async () => {
    let saved = await persistGet<DeepPartial<Settings>>(STORAGE_KEY);
    if (!saved) {
      try {
        saved = await migrateLegacy();
      } catch {
        saved = null;
      }
    }
    const merged = merge(DEFAULT_SETTINGS, saved);
    if (!merged.hermesSessionId) merged.hermesSessionId = uid('eveflow');
    if (saved && saved.voice && saved.voice.wakeMode === undefined && saved.voice.wakeWordEnabled) merged.voice.wakeMode = 'transcript';
    set({ settings: merged, loaded: true });
    persistSet(STORAGE_KEY, merged);
  },
  update: (patch) => {
    const next = merge(get().settings, patch);
    set({ settings: next });
    persistSet(STORAGE_KEY, next);
  },
  reset: () => {
    const next = { ...DEFAULT_SETTINGS, hermesSessionId: uid('eveflow') };
    set({ settings: next });
    persistSet(STORAGE_KEY, next);
  },
  setHermesSessionId: (id) => get().update({ hermesSessionId: id })
}));

export const selectSettings = (s: SettingsStore) => s.settings;
