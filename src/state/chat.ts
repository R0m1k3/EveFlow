import { create } from 'zustand';
import { uid } from '../lib/id';
import type { HermesUsage } from '../services/hermes/types';

export type HudState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'alert' | 'error' | 'success';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  reasoning?: string;
  images?: string[];
  source?: string; // eveflow | telegram | cron | webhook ...
  timestamp: number;
  status?: 'streaming' | 'done' | 'error' | 'cancelled';
  usage?: HermesUsage;
  transport?: string;
  jobName?: string;
}

export interface Activity {
  id: string;
  kind: 'tool' | 'subagent' | 'system' | 'job';
  name: string;
  status: 'running' | 'done' | 'error';
  detail?: string;
  output?: string;
  startedAt: number;
  endedAt?: number;
}

export interface PendingRequest {
  id: string; // requestId or synthetic
  requestId: string;
  runId: string;
  kind: 'approval' | 'clarify' | 'input';
  title: string;
  description: string;
  options?: string[];
  tool?: string;
  args?: string;
  secret?: boolean;
  createdAt: number;
}

interface ChatStore {
  messages: ChatMessage[];
  activity: Activity[];
  pending: PendingRequest[];
  isSending: boolean;
  currentRunId: string | null;
  hud: HudState;
  hudOverride: HudState | null;
  error: string | null;
  draft: string;
  /** Incremented to make the core flash briefly. */
  pingCount: number;
  /** Time to first token of the current reply, in ms. */
  latencyMs: number | null;

  addMessage: (message: Omit<ChatMessage, 'id' | 'timestamp'> & Partial<Pick<ChatMessage, 'id' | 'timestamp'>>) => string;
  updateMessage: (id: string, patch: Partial<ChatMessage> | ((m: ChatMessage) => Partial<ChatMessage>)) => void;
  appendToMessage: (id: string, delta: string, field?: 'content' | 'reasoning') => void;
  removeMessage: (id: string) => void;
  clear: () => void;
  pushActivity: (activity: Omit<Activity, 'id' | 'startedAt'> & Partial<Pick<Activity, 'id' | 'startedAt'>>) => string;
  finishActivity: (match: { id?: string; name?: string }, patch: Partial<Activity>) => void;
  addPending: (request: Omit<PendingRequest, 'id' | 'createdAt'>) => void;
  removePending: (id: string) => void;
  setSending: (sending: boolean, runId?: string | null) => void;
  setHud: (state: HudState) => void;
  setHudOverride: (state: HudState | null) => void;
  setError: (error: string | null) => void;
  setDraft: (draft: string) => void;
  ping: () => void;
  setLatency: (ms: number | null) => void;
}

const MAX_MESSAGES = 400;
const MAX_ACTIVITY = 120;

export const useChat = create<ChatStore>((set, get) => ({
  messages: [],
  activity: [],
  pending: [],
  isSending: false,
  currentRunId: null,
  hud: 'idle',
  hudOverride: null,
  error: null,
  draft: '',
  pingCount: 0,
  latencyMs: null,

  addMessage: (message) => {
    const id = message.id ?? uid('msg');
    const entry: ChatMessage = { ...message, id, timestamp: message.timestamp ?? Date.now() };
    set((s) => ({ messages: [...s.messages.slice(-MAX_MESSAGES), entry] }));
    return id;
  },
  updateMessage: (id, patch) =>
    set((s) => ({
      messages: s.messages.map((m) => (m.id === id ? { ...m, ...(typeof patch === 'function' ? patch(m) : patch) } : m))
    })),
  appendToMessage: (id, delta, field = 'content') =>
    set((s) => ({
      messages: s.messages.map((m) => (m.id === id ? { ...m, [field]: (m[field] ?? '') + delta } : m))
    })),
  removeMessage: (id) => set((s) => ({ messages: s.messages.filter((m) => m.id !== id) })),
  clear: () => set({ messages: [], activity: [], pending: [], error: null }),

  pushActivity: (activity) => {
    const id = activity.id ?? uid('act');
    const entry: Activity = { ...activity, id, startedAt: activity.startedAt ?? Date.now() };
    set((s) => ({ activity: [...s.activity.slice(-MAX_ACTIVITY), entry] }));
    return id;
  },
  finishActivity: (match, patch) =>
    set((s) => {
      const list = [...s.activity];
      let index = -1;
      if (match.id) index = list.findIndex((a) => a.id === match.id);
      if (index === -1 && match.name) {
        for (let i = list.length - 1; i >= 0; i--) {
          if (list[i].name === match.name && list[i].status === 'running') {
            index = i;
            break;
          }
        }
      }
      if (index === -1) return {};
      list[index] = { ...list[index], endedAt: Date.now(), ...patch };
      return { activity: list };
    }),

  addPending: (request) =>
    set((s) => ({
      pending: [...s.pending.filter((p) => p.requestId !== request.requestId || !request.requestId), { ...request, id: uid('req'), createdAt: Date.now() }]
    })),
  removePending: (id) => set((s) => ({ pending: s.pending.filter((p) => p.id !== id && p.requestId !== id) })),

  setSending: (isSending, runId = null) => set({ isSending, currentRunId: isSending ? runId : null }),
  setHud: (hud) => {
    if (get().hud !== hud) set({ hud });
  },
  setHudOverride: (hudOverride) => set({ hudOverride }),
  setError: (error) => set({ error }),
  setDraft: (draft) => set({ draft }),
  ping: () => set((s) => ({ pingCount: s.pingCount + 1 })),
  setLatency: (latencyMs) => set({ latencyMs })
}));
