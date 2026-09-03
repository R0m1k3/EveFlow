import { create } from 'zustand';
import type { TtsState } from '../services/voice/tts';

export type ListenPhase = 'off' | 'arming' | 'listening' | 'speech' | 'transcribing';

interface VoiceStore {
  phase: ListenPhase;
  inputLevel: number;
  tts: TtsState;
  handsFree: boolean;
  lastTranscript: string;
  interim: string;
  error: string | null;
  micDevices: Array<{ deviceId: string; label: string }>;
  setPhase: (phase: ListenPhase) => void;
  setInputLevel: (level: number) => void;
  setTts: (state: TtsState) => void;
  setHandsFree: (on: boolean) => void;
  setTranscript: (text: string) => void;
  setInterim: (text: string) => void;
  setError: (error: string | null) => void;
  setMicDevices: (devices: Array<{ deviceId: string; label: string }>) => void;
}

export const useVoice = create<VoiceStore>((set) => ({
  phase: 'off',
  inputLevel: 0,
  tts: 'idle',
  handsFree: false,
  lastTranscript: '',
  interim: '',
  error: null,
  micDevices: [],
  setPhase: (phase) => set({ phase }),
  setInputLevel: (inputLevel) => set({ inputLevel }),
  setTts: (tts) => set({ tts }),
  setHandsFree: (handsFree) => set({ handsFree }),
  setTranscript: (lastTranscript) => set({ lastTranscript }),
  setInterim: (interim) => set({ interim }),
  setError: (error) => set({ error }),
  setMicDevices: (micDevices) => set({ micDevices })
}));
