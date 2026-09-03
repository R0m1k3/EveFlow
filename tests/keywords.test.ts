import { describe, expect, it } from 'vitest';
import { buildKeywordsFile, encodeKeyword, normalizeKeyword, parseTokens } from '../shared/keywords';

const vocab = parseTokens(['<blk> 0', '▁ 3', '▁JA 4', 'R 5', 'VI 6', 'S 7', '▁HE 8', 'Y 9', '▁NO 10', 'V 11', 'A 12', '▁MA 13', 'X 14', '▁T 15', 'ON 16', 'Y 17'].join('\n'));

describe('keywords', () => {
  it('normalises accents, case and punctuation', () => {
    expect(normalizeKeyword('  Hé, Jarvis ! ')).toBe('HE JARVIS');
  });
  it('uses the known SentencePiece encodings', () => {
    expect(encodeKeyword('jarvis', vocab)).toBe('▁JA R VI S');
    expect(encodeKeyword('Hey Jarvis', vocab)).toBe('▁HE Y ▁JA R VI S');
  });
  it('falls back to greedy longest match', () => {
    expect(encodeKeyword('max', vocab)).toBe('▁MA X');
    expect(encodeKeyword('tony', vocab)).toBe('▁T ON Y');
    expect(encodeKeyword('zzz', vocab)).toBeNull();
  });
  it('builds a keywords file with labels', () => {
    const file = buildKeywordsFile(['jarvis', 'hey jarvis', 'zzz'], vocab);
    expect(file.content).toBe('▁JA R VI S @jarvis\n▁HE Y ▁JA R VI S @hey_jarvis\n');
    expect(file.accepted).toEqual(['jarvis', 'hey_jarvis']);
    expect(file.rejected).toEqual(['zzz']);
  });
});
