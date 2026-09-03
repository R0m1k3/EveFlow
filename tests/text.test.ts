import { describe, expect, it } from 'vitest';
import { chunkForSpeech, cleanForSpeech, extractSentences, preprocessMedia } from '../src/lib/text';

describe('text', () => {
  it('cleans markdown for speech', () => {
    const out = cleanForSpeech('**Bonjour** ! Voir [le site](https://x.io) et `npm` 😀\n\n```js\nconsole.log(1)\n```\n- item un\n- item deux');
    expect(out).not.toMatch(/\*|https|```|😀/);
    expect(out).toContain('Bonjour');
    expect(out).toContain('item un');
  });

  it('extracts complete sentences from a stream buffer', () => {
    const { sentences, rest } = extractSentences('Première phrase complète. Deuxième phrase aussi ! Troisième en cours');
    expect(sentences).toEqual(['Première phrase complète.', 'Deuxième phrase aussi !']);
    expect(rest).toBe(' Troisième en cours');
  });

  it('does not split inside an open code fence', () => {
    expect(extractSentences('Voici. ```js\nfoo(). bar\n').sentences).toEqual([]);
  });

  it('chunks long text', () => {
    const chunks = chunkForSpeech('mot '.repeat(200), 100);
    expect(chunks.every((c) => c.length <= 100)).toBe(true);
    expect(preprocessMedia('MEDIA:/tmp/a.png')).toContain('![image](/tmp/a.png)');
  });
});
