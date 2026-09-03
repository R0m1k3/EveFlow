import { create } from 'zustand';
import type { VoiceDownloadProgress, VoiceEngineStatus, VoiceModelStatus } from '../../shared/voice';
import { bridge } from '../lib/bridge';
import { Log } from '../lib/log';

interface VoiceModelsStore {
  models: VoiceModelStatus[];
  progress: Record<string, VoiceDownloadProgress>;
  engine: VoiceEngineStatus | null;
  error: string | null;
  refresh: () => Promise<void>;
  checkEngine: () => Promise<void>;
  download: (id: string) => Promise<void>;
  cancel: (id: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  subscribe: () => () => void;
}

export const useVoiceModels = create<VoiceModelsStore>((set, get) => ({
  models: [],
  progress: {},
  engine: null,
  error: null,

  refresh: async () => {
    const api = bridge();
    if (!api) return;
    try {
      set({ models: await api.voice.listModels(), error: null });
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },
  checkEngine: async () => {
    const api = bridge();
    if (!api) return;
    try {
      set({ engine: await api.voice.status() });
    } catch (err) {
      set({ engine: { available: false, error: (err as Error).message, loaded: [], modelsDir: '' } });
    }
  },
  download: async (id) => {
    const api = bridge();
    if (!api) return;
    set((s) => ({ progress: { ...s.progress, [id]: { id, phase: 'download', received: 0, total: 0, percent: 0 } }, error: null }));
    try {
      await api.voice.downloadModel(id);
    } catch (err) {
      const message = (err as Error).message;
      Log.error('voice', `download ${id} failed: ${message}`);
      set({ error: message });
    } finally {
      await get().refresh();
    }
  },
  cancel: async (id) => {
    await bridge()?.voice.cancelDownload(id);
  },
  remove: async (id) => {
    const api = bridge();
    if (!api) return;
    try {
      set({ models: await api.voice.removeModel(id) });
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },
  subscribe: () => {
    const api = bridge();
    if (!api) return () => undefined;
    return api.voice.onProgress((p) => {
      set((s) => {
        const progress = { ...s.progress, [p.id]: p };
        if (p.phase === 'done' || p.phase === 'error' || p.phase === 'cancelled') {
          setTimeout(() => {
            set((s2) => {
              const next = { ...s2.progress };
              delete next[p.id];
              return { progress: next };
            });
            void get().refresh();
          }, 1500);
        }
        return { progress };
      });
    });
  }
}));

export const installedModels = (models: VoiceModelStatus[], kind: 'stt' | 'tts') => models.filter((m) => m.kind === kind && m.installed);
