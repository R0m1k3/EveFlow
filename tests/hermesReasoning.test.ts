import { afterEach, describe, expect, it, vi } from 'vitest';
import { HermesClient } from '../src/services/hermes/client';
import { httpFetch, httpStream } from '../src/lib/transport';
import { DEFAULT_SETTINGS } from '../src/state/settings';
import { REASONING_EFFORTS, isReasoningEffort } from '../src/lib/hermesReasoning';

vi.mock('../src/lib/transport', async (original) => ({ ...await original<typeof import('../src/lib/transport')>(), httpFetch: vi.fn(), httpStream: vi.fn() }));
const config = { ...DEFAULT_SETTINGS.hermes, url: 'https://example.test', apiKey: 'k' };
afterEach(() => vi.restoreAllMocks());

describe('reasoning effort levels', () => {
  it('lists every level Hermes accepts, server default first', () => {
    expect(REASONING_EFFORTS.map((e) => e.value)).toEqual(['', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
    expect(isReasoningEffort('xhigh')).toBe(true);
    expect(isReasoningEffort('')).toBe(true);
    expect(isReasoningEffort('turbo')).toBe(false);
  });

  it.each(['runs', 'sessions', 'completions'] as const)('sends model_options.reasoning_effort over %s', async (transport) => {
    const requests: Record<string, unknown>[] = [];
    const capture = async (req: { body?: string }) => {
      requests.push(JSON.parse(req.body ?? '{}') as Record<string, unknown>);
      throw new Error('stop');
    };
    vi.mocked(httpFetch).mockImplementation(capture as never);
    vi.mocked(httpStream).mockImplementation(capture as never);
    const send = new HermesClient({ ...config, reasoningEffort: 'high' }).send({ text: 'Bonjour', sessionId: 'hs:test', history: [], onEvent: vi.fn() }, transport);
    await expect(send.result).rejects.toThrow('stop');
    expect(requests[0]).toMatchObject({ model_options: { reasoning_effort: 'high' } });
  });

  it('omits model_options when the effort is left to the server', async () => {
    const requests: Record<string, unknown>[] = [];
    vi.mocked(httpFetch).mockImplementation((async (req: { body?: string }) => {
      requests.push(JSON.parse(req.body ?? '{}') as Record<string, unknown>);
      throw new Error('stop');
    }) as never);
    const send = new HermesClient({ ...config, reasoningEffort: '' }).send({ text: 'Bonjour', sessionId: 'test', history: [], onEvent: vi.fn() }, 'runs');
    await expect(send.result).rejects.toThrow('stop');
    expect(requests[0]).not.toHaveProperty('model_options');
  });
});
