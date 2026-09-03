import { create } from 'zustand';
import type { TtsState } from '../services/voice/tts';

export type ListenPhase = 'off' | 'arming' | 'listening' | 'speech' | 'transcribing';
export type WakeState = 'off' | 'starting' | 'spotting' | 'error';

interface VoiceStore {
  phase: ListenPhase;
  inputLevel: number;
  tts: TtsState;
  handsFree: boolean;
  lastTranscript: string;
  interim: string;
  error: string | null;
  micDevices: Array<{ deviceId: string; label: string }>;
  wake: WakeState;
  wakeKeywords: string[];
  neuralVad: boolean;
  setNeuralVad: (on: boolean) => void;
  setWake: (state: WakeState, keywords?: string[]) => void;
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
  wake: 'off',
  wakeKeywords: [],
  neuralVad: false,
  setNeuralVad: (neuralVad) => set({ neuralVad }),
  setWake: (wake, wakeKeywords) => set(wakeKeywords ? { wake, wakeKeywords } : { wake }),
  setPhase: (phase) => set({ phase }),
  setInputLevel: (inputLevel) => set({ inputLevel }),
  setTts: (tts) => set({ tts }),
  setHandsFree: (handsFree) => set({ handsFree }),
  setTranscript: (lastTranscript) => set({ lastTranscript }),
  setInterim: (interim) => set({ interim }),
  setError: (error) => set({ error }),
  setMicDevices: (micDevices) => set({ micDevices })
}));
