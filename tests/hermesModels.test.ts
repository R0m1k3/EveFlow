import { afterEach, describe, expect, it, vi } from 'vitest';
import { HermesClient } from '../src/services/hermes/client';
import { httpFetch } from '../src/lib/transport';
import { DEFAULT_SETTINGS, useSettings } from '../src/state/settings';
import { useHermes } from '../src/state/hermes';
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import { ModelSelect } from '../src/components/settings/ModelSelect';

vi.mock('../src/lib/transport', async (original) => ({ ...await original<typeof import('../src/lib/transport')>(), httpFetch: vi.fn() }));
const config = { ...DEFAULT_SETTINGS.hermes, url: 'https://example.test/v1/', apiKey: ' test-key ' };
function respond(payload: unknown, status = 200) {
  vi.mocked(httpFetch).mockResolvedValue({ ok: status === 200, status, statusText: '', headers: {}, text: JSON.stringify(payload) });
}
afterEach(() => { vi.restoreAllMocks(); useSettings.setState({ settings: DEFAULT_SETTINGS }); });

describe('Hermes models', () => {
  it('uses authenticated discovery and preserves provider labels, order and unique valid IDs', async () => {
    respond({ data: [{ id: 'b', provider: 'provider-b' }, { id: 'a' }, { id: 'b' }, {}, ' c '] });
    expect(await new HermesClient(config).models()).toEqual([{ id: 'b', provider: 'provider-b' }, { id: 'a' }, { id: 'c' }]);
    expect(httpFetch).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://example.test/v1/models', headers: expect.objectContaining({ Authorization: 'Bearer test-key' }) }));
  });
  it('accepts nested catalogs and empty lists, rejects malformed responses', async () => {
    respond({ data: { models: ['a'] } });
    expect(await new HermesClient(config).models()).toEqual([{ id: 'a' }]);
    respond({ data: [] });
    expect(await new HermesClient(config).models()).toEqual([]);
    respond({ data: { error: 'unavailable' } });
    await expect(new HermesClient(config).models()).rejects.toThrow('invalide');
  });
  it('surfaces authentication failures without clearing the selected model', async () => {
    useSettings.setState({ settings: { ...DEFAULT_SETTINGS, hermes: { ...config, model: 'chosen' } } });
    respond({}, 401);
    await useHermes.getState().refreshModels();
    expect(useHermes.getState().modelsError).toContain('401');
    expect(useHermes.getState().modelsLoading).toBe(false);
    expect(useSettings.getState().settings.hermes.model).toBe('chosen');
  });
  it('discards results from a previous server or an older refresh', async () => {
    useSettings.setState({ settings: { ...DEFAULT_SETTINGS, hermes: config } });
    let finish!: (value: { id: string }[]) => void;
    vi.spyOn(HermesClient.prototype, 'models').mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue([{ id: 'new' }]);
    const old = useHermes.getState().refreshModels();
    useSettings.setState({ settings: { ...DEFAULT_SETTINGS, hermes: { ...config, url: 'https://new.test' } } });
    await useHermes.getState().refreshModels();
    finish([{ id: 'old' }]);
    await old;
    expect(useHermes.getState().models).toEqual([{ id: 'new' }]);
  });
  it('sends the selected principal model and the mission override on new runs', async () => {
    useSettings.setState({ settings: { ...DEFAULT_SETTINGS, hermes: { ...config, model: 'principal', missionModel: 'mission' } } });
    const start = vi.spyOn(HermesClient.prototype, 'startRun').mockRejectedValue(new Error('stop before network'));
    for (const [override, expected] of [[undefined, 'principal'], ['mission', 'mission']] as const) {
      const send = useHermes.getState().client(override).send({ text: 'Bonjour', sessionId: 'test-session', history: [], onEvent: vi.fn() }, 'runs');
      await expect(send.result).rejects.toThrow('stop before network');
      expect(start).toHaveBeenLastCalledWith(expect.objectContaining({ model: expected }));
    }
  });
  it('offers a visible selection, preserves a custom value and supports the default', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const container = document.createElement('div');
    const root = createRoot(container);
    const onChange = vi.fn();
    try {
      await act(async () => root.render(createElement(ModelSelect, { label: 'Modèle IA', value: 'custom', models: [{ id: 'available' }], defaultLabel: 'Défaut', onChange })));
      const select = container.querySelector('select')!;
      expect(select.value).toBe('custom');
      await act(async () => { select.value = 'available'; select.dispatchEvent(new Event('change', { bubbles: true })); });
      expect(onChange).toHaveBeenLastCalledWith('available');
      await act(async () => { select.value = ''; select.dispatchEvent(new Event('change', { bubbles: true })); });
      expect(onChange).toHaveBeenLastCalledWith('');
    } finally { await act(async () => root.unmount()); }
  });
});
