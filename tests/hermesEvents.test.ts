import { describe, expect, it } from 'vitest';
import { normalizeCompletionChunk, normalizeLifecycleEvent } from '../src/services/hermes/events';
import { hermesBaseUrl, resolveTransport } from '../src/services/hermes/client';
import type { HermesConfig } from '../src/services/hermes/types';

describe('normalizeLifecycleEvent', () => {
  it('maps runs API events', () => {
    expect(normalizeLifecycleEvent('message.delta', { delta: 'Hi' })).toEqual([{ kind: 'delta', text: 'Hi' }]);
    const [start] = normalizeLifecycleEvent('tool.started', { tool: 'terminal', preview: 'ls', run_id: 'r1' });
    expect(start).toMatchObject({ kind: 'tool.start', name: 'terminal', args: 'ls' });
    const [end] = normalizeLifecycleEvent('tool.completed', { tool: 'terminal', error: 'boom' });
    expect(end).toMatchObject({ kind: 'tool.end', ok: false });
    const [approval] = normalizeLifecycleEvent('approval.request', { command: 'rm -rf x', choices: ['once', 'deny'] });
    expect(approval).toMatchObject({ kind: 'approval.request', description: 'rm -rf x', options: ['once', 'deny'] });
    const done = normalizeLifecycleEvent('run.completed', { output: 'ok', usage: { total_tokens: 3 }, session_id: 's1' });
    expect(done[0]).toMatchObject({ kind: 'completed', text: 'ok', usage: { total_tokens: 3 } });
    expect(done[1]).toEqual({ kind: 'session', sessionId: 's1' });
    expect(normalizeLifecycleEvent('run.failed', { error: 'bad' })[0]).toEqual({ kind: 'error', message: 'bad' });
  });

  it('maps sessions stream and chat-completions tool progress', () => {
    expect(normalizeLifecycleEvent('assistant.delta', { delta: 'a' })[0]).toEqual({ kind: 'delta', text: 'a' });
    const [progress] = normalizeLifecycleEvent('hermes.tool.progress', { tool_name: 'web_search', status: 'started' });
    expect(progress).toMatchObject({ kind: 'tool.progress', name: 'web_search' });
    expect(normalizeLifecycleEvent('gateway.ready', {})).toEqual([]);
    expect(normalizeLifecycleEvent('weird.event', { x: 1 })[0]).toMatchObject({ kind: 'raw' });
  });
});

describe('normalizeCompletionChunk', () => {
  it('accumulates streamed tool calls', () => {
    const calls = new Map();
    normalizeCompletionChunk({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'set_', arguments: '{"a' } }] } }] }, calls);
    const { events, finishReason } = normalizeCompletionChunk(
      { choices: [{ delta: { content: 'x', tool_calls: [{ index: 0, function: { name: 'hud', arguments: '":1}' } }] }, finish_reason: 'tool_calls' }] },
      calls
    );
    expect(events).toEqual([{ kind: 'delta', text: 'x' }]);
    expect(finishReason).toBe('tool_calls');
    expect(calls.get(0)).toEqual({ id: 'c1', name: 'set_hud', arguments: '{"a":1}' });
  });
});

describe('client helpers', () => {
  const cfg = { transport: 'auto' } as HermesConfig;
  it('normalises base urls', () => {
    expect(hermesBaseUrl('http://h:8642/v1/')).toBe('http://h:8642');
    expect(hermesBaseUrl('http://h:8642/v1/chat/completions')).toBe('http://h:8642');
    expect(hermesBaseUrl('http://h:8642')).toBe('http://h:8642');
  });
  it('resolves transports from capabilities', () => {
    expect(resolveTransport(cfg, null)).toBe('completions');
    expect(resolveTransport(cfg, { features: { run_submission: true, run_events_sse: true } })).toBe('runs');
    expect(resolveTransport(cfg, { endpoints: { session_chat: true } })).toBe('sessions');
    expect(resolveTransport({ transport: 'completions' } as HermesConfig, { features: { run_submission: true, run_events_sse: true } })).toBe('completions');
  });
});
