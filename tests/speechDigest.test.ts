import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, useSettings } from '../src/state/settings';

const enqueue = vi.fn((text: string) => /[\p{L}\p{N}]/u.test(text.replace(/```[\s\S]*?```/g, '')));
const speak = vi.fn();
const stop = vi.fn();
vi.mock('../src/services/voice/tts', () => ({
  TtsEngine: class {
    enqueue = enqueue;
    speak = speak;
    stop = stop;
    onState() { return () => undefined; }
    updateConfig() { /* noop */ }
    get isActive() { return false; }
  }
}));

const { speech, DIGEST_NOTICE } = await import('../src/services/voice/speech');

function stream(text: string, size = 7): void {
  for (let i = 0; i < text.length; i += size) speech.pushStream(text.slice(i, i + size));
}
const spoken = () => enqueue.mock.calls.map((c) => c[0]);

describe('spoken digest of streamed replies', () => {
  beforeEach(() => {
    enqueue.mockClear();
    speak.mockClear();
    useSettings.setState({ settings: { ...DEFAULT_SETTINGS, speech: { ...DEFAULT_SETTINGS.speech, summarizeReplies: true, replySentences: 2 } } });
  });
  afterEach(() => speech.stop());

  it('stops after the configured sentences, then adds the closing question and a notice', () => {
    const text = 'Première phrase du rapport. Deuxième phrase utile. Troisième phrase de détail. Quatrième phrase encore. Tu veux la suite ?';
    stream(text);
    speech.endStream(text);
    expect(spoken()).toEqual(['Première phrase du rapport.', 'Deuxième phrase utile.', 'Tu veux la suite ?', DIGEST_NOTICE]);
  });

  it('speaks short replies in full without any notice', () => {
    const text = 'Une phrase courte. Une seconde phrase';
    stream(text);
    speech.endStream(text);
    expect(spoken()).toEqual(['Une phrase courte.', 'Une seconde phrase']);
  });

  it('speaks everything when the digest is disabled', () => {
    useSettings.setState({ settings: { ...DEFAULT_SETTINGS, speech: { ...DEFAULT_SETTINGS.speech, summarizeReplies: false } } });
    const text = 'Première phrase du rapport. Deuxième phrase utile. Troisième phrase de détail. Quatrième phrase encore.';
    stream(text);
    speech.endStream(text);
    expect(spoken()).toHaveLength(4);
  });

  it('digests a reply delivered in one piece', () => {
    speech.sayReply('Première phrase du rapport. Deuxième phrase utile. Troisième phrase de détail. On continue ?');
    expect(speak).toHaveBeenCalledWith(`Première phrase du rapport. Deuxième phrase utile. On continue ? ${DIGEST_NOTICE}`, expect.anything());
  });
});
