import { describe, expect, it } from 'vitest';
import { matchWakeWord } from '../src/services/voice/voiceController';

describe('matchWakeWord', () => {
  it('accepts the wake word with punctuation, accents and small slips', () => {
    expect(matchWakeWord('Jarvis, quelle heure est-il ?', 'jarvis')).toEqual({ matched: true, rest: 'quelle heure est-il ?' });
    expect(matchWakeWord('Javis allume la lumière', 'jarvis')).toEqual({ matched: true, rest: 'allume la lumière' });
    expect(matchWakeWord('JARVIS.', 'jarvis')).toEqual({ matched: true, rest: '' });
    expect(matchWakeWord('Hé Jarvis, bonjour', 'hé jarvis')).toEqual({ matched: true, rest: 'bonjour' });
  });
  it('rejects unrelated speech', () => {
    expect(matchWakeWord('Il fait beau aujourd’hui', 'jarvis').matched).toBe(false);
    expect(matchWakeWord('Service client', 'jarvis').matched).toBe(false);
    expect(matchWakeWord('', 'jarvis').matched).toBe(false);
  });
});
