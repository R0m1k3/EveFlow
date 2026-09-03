/**
 * Normalises the various Hermes streaming dialects (runs events, sessions stream,
 * chat-completions chunks) into one HermesStreamEvent vocabulary.
 * Hermes releases have renamed a few events (tool.started/tool.start, token.delta/message.delta),
 * so every reader here is deliberately tolerant.
 */
import type { HermesStreamEvent, HermesUsage } from './types';

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => !!v && typeof v === 'object' && !Array.isArray(v);
const s = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
const first = (obj: Rec, keys: string[]): unknown => {
  for (const k of keys) if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  return undefined;
};

function textOf(data: Rec): string {
  const direct = first(data, ['delta', 'text', 'content', 'output_text', 'token']);
  if (typeof direct === 'string') return direct;
  if (isRec(direct)) return s(first(direct, ['text', 'content', 'delta']));
  return '';
}

function idOf(data: Rec, fallback = ''): string {
  return s(first(data, ['tool_call_id', 'call_id', 'id', 'request_id', 'delegation_id'])) || fallback;
}

function toolName(data: Rec): string {
  const direct = first(data, ['tool_name', 'tool', 'name', 'function']);
  if (typeof direct === 'string') return direct;
  if (isRec(direct)) return s(first(direct, ['name', 'tool']));
  return 'outil';
}

function argsOf(data: Rec): string | undefined {
  const value = first(data, ['arguments', 'args', 'input', 'params', 'preview']);
  if (value === undefined) return undefined;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function optionsOf(data: Rec): string[] | undefined {
  const value = first(data, ['options', 'choices']);
  if (!Array.isArray(value)) return undefined;
  return value.map((v) => (isRec(v) ? s(first(v, ['label', 'value', 'id'])) : s(v))).filter(Boolean);
}

function usageOf(data: Rec): HermesUsage | undefined {
  return isRec(data.usage) ? (data.usage as HermesUsage) : undefined;
}

/** Runs API + sessions stream share the same lifecycle vocabulary. */
export function normalizeLifecycleEvent(event: string, payload: unknown): HermesStreamEvent[] {
  const name = event.toLowerCase();
  const data: Rec = isRec(payload) ? payload : { value: payload };
  const out: HermesStreamEvent[] = [];
  const sessionId = s(first(data, ['session_id', 'sessionId']));

  switch (name) {
    case 'token.delta':
    case 'message.delta':
    case 'assistant.delta':
    case 'output_text.delta':
    case 'response.output_text.delta':
    case 'delta': {
      const text = textOf(data);
      if (text) out.push({ kind: 'delta', text });
      break;
    }
    case 'reasoning.delta':
    case 'reasoning.available':
    case 'thinking.delta': {
      const text = textOf(data);
      if (text) out.push({ kind: 'reasoning', text });
      break;
    }
    case 'tool.start':
    case 'tool.started':
    case 'tool_call.start':
      out.push({ kind: 'tool.start', id: idOf(data, `tool-${Date.now()}`), name: toolName(data), args: argsOf(data) });
      break;
    case 'tool.progress':
    case 'hermes.tool.progress':
      out.push({
        kind: 'tool.progress',
        id: idOf(data) || undefined,
        name: toolName(data),
        label: s(first(data, ['label', 'message', 'status'])) || undefined,
        detail: s(first(data, ['preview', 'detail', 'output'])) || undefined
      });
      break;
    case 'tool.complete':
    case 'tool.completed':
    case 'tool.end':
    case 'tool_call.complete': {
      const status = s(first(data, ['status', 'result_status'])).toLowerCase();
      const error = first(data, ['error']);
      out.push({
        kind: 'tool.end',
        id: idOf(data, ''),
        name: data.tool_name || data.tool || data.name ? toolName(data) : undefined,
        output: s(first(data, ['output', 'result', 'content'])) || undefined,
        ok: !error && status !== 'error' && status !== 'failed'
      });
      break;
    }
    case 'subagent.start':
      out.push({
        kind: 'subagent.start',
        id: s(first(data, ['delegation_id', 'id'])) || `sub-${Date.now()}`,
        childSessionId: s(data.child_session_id) || undefined,
        label: s(first(data, ['label', 'task', 'goal'])) || undefined
      });
      break;
    case 'subagent.complete':
    case 'subagent.end':
      out.push({
        kind: 'subagent.end',
        id: s(first(data, ['delegation_id', 'id'])) || 'sub',
        status: s(data.status) || 'completed',
        summary: s(data.summary) || undefined,
        durationMs: typeof data.duration_ms === 'number' ? data.duration_ms : undefined
      });
      break;
    case 'approval.request':
    case 'approval.requested':
      out.push({
        kind: 'approval.request',
        requestId: s(first(data, ['request_id', 'approval_id', 'id'])),
        tool: s(first(data, ['tool_name', 'tool', 'command'])) || undefined,
        description: s(first(data, ['description', 'message', 'prompt', 'reason', 'command', 'preview'])) || 'Hermes demande une autorisation.',
        args: argsOf(data),
        options: optionsOf(data)
      });
      break;
    case 'clarify.request':
    case 'clarification.request':
      out.push({
        kind: 'clarify.request',
        requestId: s(first(data, ['request_id', 'id'])),
        question: s(first(data, ['question', 'prompt', 'message'])) || 'Hermes a besoin d’une précision.',
        options: optionsOf(data)
      });
      break;
    case 'sudo.request':
    case 'secret.request':
      out.push({
        kind: 'input.request',
        requestId: s(first(data, ['request_id', 'id'])),
        prompt: s(first(data, ['prompt', 'message', 'description'])) || (name === 'sudo.request' ? 'Mot de passe sudo requis' : 'Secret requis'),
        secret: true,
        variant: name === 'sudo.request' ? 'sudo' : 'secret'
      });
      break;
    case 'approval.expire':
    case 'clarify.expire':
    case 'sudo.expire':
    case 'secret.expire':
    case 'request.expire':
      out.push({ kind: 'request.expire', requestId: s(first(data, ['request_id', 'id'])) });
      break;
    case 'run.started':
    case 'run.created':
      out.push({ kind: 'run.started', runId: s(first(data, ['run_id', 'id'])) });
      break;
    case 'message.complete':
    case 'message.completed':
    case 'assistant.complete': {
      // Final text; a run.completed usually follows, so only surface the text here.
      const text = textOf(data);
      if (text) out.push({ kind: 'completed', text, status: 'message', usage: usageOf(data) });
      break;
    }
    case 'run.completed':
    case 'run.complete':
    case 'run.finished':
    case 'done':
    case 'complete':
      out.push({
        kind: 'completed',
        text: s(first(data, ['output', 'text', 'content', 'final_output'])) || undefined,
        status: s(data.status) || 'completed',
        usage: usageOf(data)
      });
      break;
    case 'run.failed':
    case 'run.cancelled':
    case 'run.canceled':
    case 'error':
      out.push({ kind: 'error', message: s(first(data, ['error', 'message', 'detail', 'reason'])) || name });
      break;
    case 'gateway.ready':
    case 'ping':
    case 'heartbeat':
      break;
    default:
      out.push({ kind: 'raw', event, data: payload });
  }
  if (sessionId) out.push({ kind: 'session', sessionId });
  return out;
}

export interface CompletionToolCallAccumulator {
  id: string;
  name: string;
  arguments: string;
}

/** Chat-completions chunk (OpenAI format). Returns delta events plus any accumulated tool calls. */
export function normalizeCompletionChunk(
  chunk: unknown,
  toolCalls: Map<number, CompletionToolCallAccumulator>
): { events: HermesStreamEvent[]; finishReason: string | null } {
  const events: HermesStreamEvent[] = [];
  if (!isRec(chunk)) return { events, finishReason: null };
  if (isRec(chunk.usage)) events.push({ kind: 'completed', status: 'usage', usage: chunk.usage as HermesUsage });
  const choice = Array.isArray(chunk.choices) && isRec(chunk.choices[0]) ? (chunk.choices[0] as Rec) : null;
  if (!choice) return { events, finishReason: null };
  const delta = isRec(choice.delta) ? (choice.delta as Rec) : isRec(choice.message) ? (choice.message as Rec) : null;
  if (delta) {
    if (typeof delta.content === 'string' && delta.content) events.push({ kind: 'delta', text: delta.content });
    const reasoning = first(delta, ['reasoning_content', 'reasoning']);
    if (typeof reasoning === 'string' && reasoning) events.push({ kind: 'reasoning', text: reasoning });
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        if (!isRec(tc)) continue;
        const index = typeof tc.index === 'number' ? tc.index : toolCalls.size;
        const fn = isRec(tc.function) ? (tc.function as Rec) : {};
        const acc = toolCalls.get(index) ?? { id: s(tc.id), name: '', arguments: '' };
        if (tc.id) acc.id = s(tc.id);
        if (typeof fn.name === 'string') acc.name += fn.name;
        if (typeof fn.arguments === 'string') acc.arguments += fn.arguments;
        toolCalls.set(index, acc);
      }
    }
  }
  return { events, finishReason: typeof choice.finish_reason === 'string' ? choice.finish_reason : null };
}
