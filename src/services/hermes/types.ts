export type HermesTransport = 'auto' | 'runs' | 'sessions' | 'completions';

export interface HermesConfig {
  url: string;
  apiKey: string;
  model: string;
  /** Stable per-user key for long-term memory (X-Hermes-Session-Key). */
  sessionKey: string;
  transport: HermesTransport;
  reasoningEffort: '' | 'low' | 'medium' | 'high';
  /** Extra instructions layered on top of the Hermes system prompt. */
  instructions: string;
  /** Model used in "mission" mode (long tasks); empty = same as `model`. */
  missionModel: string;
  /** Expose EveFlow client tools in chat-completions mode. */
  localTools: boolean;
}

export interface HermesCapabilities {
  object?: string;
  platform?: string;
  model?: string;
  version?: string;
  auth?: { type?: string; required?: boolean };
  features?: Record<string, boolean | string>;
  endpoints?: Record<string, boolean>;
  [key: string]: unknown;
}

export interface HermesHealth {
  status: string;
  readiness?: { checks?: Record<string, unknown> };
  [key: string]: unknown;
}

export interface HermesModel {
  id: string;
  name?: string;
  available?: boolean;
  owned_by?: string;
  provider?: string;
  [key: string]: unknown;
}

export interface HermesSkill {
  name: string;
  description?: string;
  category?: string;
  [key: string]: unknown;
}

export interface HermesToolset {
  name: string;
  label?: string;
  description?: string;
  enabled?: boolean;
  configured?: boolean;
  tools?: string[];
  [key: string]: unknown;
}

export interface HermesSession {
  id: string;
  title?: string;
  created_at?: string | number;
  updated_at?: string | number;
  end_reason?: string | null;
  message_count?: number;
  platform?: string;
  source?: string;
  [key: string]: unknown;
}

export interface HermesSessionMessage {
  role: string;
  content: string;
  timestamp?: string | number;
  tool_calls?: unknown[];
  [key: string]: unknown;
}

export interface HermesJobSchedule {
  kind?: string;
  expr?: string;
  display?: string;
}

export interface HermesJob {
  id: string;
  name?: string;
  prompt?: string;
  schedule?: string | HermesJobSchedule;
  state?: string;
  status?: string;
  enabled?: boolean;
  deliver?: string;
  next_run_at?: string | number;
  last_run_at?: string | number;
  last_status?: string;
  last_output?: string;
  last_error?: string;
  repeat?: number | { times?: number | null; completed?: number };
  skills?: string[];
  skill?: string;
  provider?: string | null;
  model?: string | null;
  created_at?: string | number;
  updated_at?: string | number;
  [key: string]: unknown;
}

export interface HermesJobDraft {
  name: string;
  schedule: string;
  prompt: string;
  deliver?: string;
  skills?: string[];
}

export interface HermesRunInfo {
  run_id: string;
  status: string;
  session_id?: string;
  model?: string;
  output?: string;
  usage?: Record<string, number>;
  [key: string]: unknown;
}

export interface HermesUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  [key: string]: unknown;
}

export type HermesStreamEvent =
  | { kind: 'delta'; text: string }
  | { kind: 'reasoning'; text: string }
  | { kind: 'tool.start'; id: string; name: string; args?: string }
  | { kind: 'tool.progress'; id?: string; name: string; label?: string; detail?: string }
  | { kind: 'tool.end'; id: string; name?: string; output?: string; ok: boolean }
  | { kind: 'subagent.start'; id: string; childSessionId?: string; label?: string }
  | { kind: 'subagent.end'; id: string; status: string; summary?: string; durationMs?: number }
  | { kind: 'approval.request'; requestId: string; tool?: string; description: string; args?: string; options?: string[] }
  | { kind: 'clarify.request'; requestId: string; question: string; options?: string[] }
  | { kind: 'input.request'; requestId: string; prompt: string; secret: boolean; variant: 'sudo' | 'secret' }
  | { kind: 'request.expire'; requestId: string }
  | { kind: 'session'; sessionId: string }
  | { kind: 'run.started'; runId: string }
  | { kind: 'completed'; text?: string; status: string; usage?: HermesUsage }
  | { kind: 'error'; message: string }
  | { kind: 'raw'; event: string; data: unknown };

export interface HermesChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string | null | Array<{ type: string; text?: string; image_url?: { url: string } }>;
  tool_call_id?: string;
  tool_calls?: unknown[];
}

export interface SendOptions {
  text: string;
  images?: string[];
  /** Recent turns used only by the stateless chat-completions transport. */
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  sessionId: string;
  onEvent: (event: HermesStreamEvent) => void;
  localToolExecutor?: (name: string, args: string) => Promise<string>;
  localToolDefinitions?: unknown[];
}

export interface SendHandle {
  /** Resolves with the final assistant text (partial text when aborted). */
  result: Promise<string>;
  abort: () => void;
  /** True once abort() was called; the caller must not treat the result as a completed reply. */
  readonly aborted: boolean;
  transport: Exclude<HermesTransport, 'auto'>;
}
