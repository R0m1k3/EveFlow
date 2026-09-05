import { afterEach, describe, expect, it, vi } from 'vitest';
import { HermesClient } from '../src/services/hermes/client';
import { httpFetch, httpStream } from '../src/lib/transport';
import { DEFAULT_SETTINGS } from '../src/state/settings';
import type { HermesStreamEvent } from '../src/services/hermes/types';

vi.mock('../src/lib/transport', async (original) => ({ ...await original<typeof import('../src/lib/transport')>(), httpFetch: vi.fn(), httpStream: vi.fn() }));
const config = { ...DEFAULT_SETTINGS.hermes, url: 'https://example.test' };
afterEach(() => vi.restoreAllMocks());

/** Run started, streamed to completion over SSE (which never carries the session id), status read afterwards. */
function mockRun(sessionId: string) {
  const bodies: Array<{ url: string; body: unknown }> = [];
  vi.mocked(httpFetch).mockImplementation(async (req) => {
    bodies.push({ url: req.url, body: req.body ? JSON.parse(req.body as string) : undefined });
    if (req.url.endsWith('/v1/runs')) return { ok: true, status: 200, statusText: '', headers: {}, text: JSON.stringify({ run_id: 'run_1', status: 'started' }) };
    return { ok: true, status: 200, statusText: '', headers: {}, text: JSON.stringify({ run_id: 'run_1', status: 'completed', session_id: sessionId, output: 'Salut.' }) };
  });
  vi.mocked(httpStream).mockImplementation(async (_req, handlers) => {
    // Chunks arrive on a later tick, after the client has accepted the stream (as over IPC).
    const done = new Promise<void>((resolve) => setTimeout(() => {
      handlers.onChunk('event: message.delta\ndata: {"run_id":"run_1","delta":"Salut."}\n\n');
      handlers.onChunk('event: run.completed\ndata: {"run_id":"run_1","status":"completed","output":"Salut."}\n\n');
      resolve();
    }, 0));
    return { start: { id: 'stream-1', ok: true, status: 200, statusText: '', headers: {} }, done, abort: () => undefined };
  });
  return bodies;
}

describe('Hermes runs session continuity', () => {
  it('adopts the session Hermes attached to the run so the next message continues it', async () => {
    const bodies = mockRun('api_abc');
    const events: HermesStreamEvent[] = [];
    const client = new HermesClient(config);
    const reply = await client.send({ text: 'Bonjour', sessionId: 'eveflow-local', history: [], onEvent: (e) => events.push(e) }, 'runs').result;
    expect(reply).toBe('Salut.');
    expect(events.map((e) => e.kind)).toEqual(['run.started', 'delta', 'completed', 'session']);
    expect(events[3]).toEqual({ kind: 'session', sessionId: 'api_abc' });
    expect(bodies.map((b) => b.url)).toEqual(['https://example.test/v1/runs', 'https://example.test/v1/runs/run_1']);
    expect(bodies[0].body).toEqual(expect.objectContaining({ input: 'Bonjour', session_id: 'eveflow-local' }));
    const again = await client.send({ text: 'Et ensuite ?', sessionId: 'api_abc', history: [], onEvent: () => undefined }, 'runs').result;
    expect(again).toBe('Salut.');
    expect(bodies[2].body).toEqual(expect.objectContaining({ session_id: 'api_abc' }));
  });
  it('does not fail the reply when the run status is unavailable', async () => {
    mockRun('api_abc');
    vi.mocked(httpFetch).mockImplementation(async (req) =>
      req.url.endsWith('/v1/runs')
        ? { ok: true, status: 200, statusText: '', headers: {}, text: JSON.stringify({ run_id: 'run_1', status: 'started' }) }
        : { ok: false, status: 500, statusText: '', headers: {}, text: 'boom' });
    const events: HermesStreamEvent[] = [];
    const reply = await new HermesClient(config).send({ text: 'Bonjour', sessionId: 'x', history: [], onEvent: (e) => events.push(e) }, 'runs').result;
    expect(reply).toBe('Salut.');
    expect(events.some((e) => e.kind === 'session')).toBe(false);
  });
});
