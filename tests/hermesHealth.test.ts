import { describe, expect, it } from 'vitest';
import { recoverCompletion } from '../src/services/hermes/client';
import { describeHealth, isHealthyStatus } from '../src/state/hermes';

describe('health status', () => {
  it('accepts the usual healthy words', () => {
    for (const s of ['ok', 'OK', 'healthy', 'ready', undefined]) expect(isHealthyStatus(s)).toBe(true);
    for (const s of ['degraded', 'unhealthy', 'error']) expect(isHealthyStatus(s)).toBe(false);
  });
  it('names the failing checks', () => {
    expect(describeHealth({ status: 'degraded', checks: { memory: { status: 'ok' }, sessions_db: { status: 'error' } } })).toBe('état degraded · checks.sessions_db');
    expect(describeHealth({ status: 'degraded' })).toBe('état degraded');
  });
});

describe('recoverCompletion', () => {
  it('reads a plain JSON completion when the server ignored streaming', () => {
    expect(recoverCompletion(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Bonjour.' } }] }))).toEqual({ text: 'Bonjour.' });
  });
  it('surfaces an error object returned with HTTP 200', () => {
    expect(recoverCompletion(JSON.stringify({ error: { message: 'model not found' } })).error).toContain('model not found');
  });
  it('handles SSE bodies and empty input', () => {
    expect(recoverCompletion('data: {"choices":[{"delta":{"content":"A"}}]}\n\ndata: {"choices":[{"delta":{"content":"B"}}]}\n\ndata: [DONE]\n\n')).toEqual({ text: 'AB' });
    expect(recoverCompletion('')).toEqual({});
  });
});
