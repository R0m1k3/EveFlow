import { describe, expect, it } from 'vitest';
import { chunkForSpeech, cleanForSpeech, closingQuestion, extractSentences, isTranscriptNoise, preprocessMedia, spokenDigest } from '../src/lib/text';

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

describe('isTranscriptNoise', () => {
  it('drops Whisper hallucinations on silence', () => {
    expect(isTranscriptNoise('(cliquant)')).toBe(true);
    expect(isTranscriptNoise('*Claire*')).toBe(true);
    expect(isTranscriptNoise('[Musique]')).toBe(true);
    expect(isTranscriptNoise('...')).toBe(true);
    expect(isTranscriptNoise("Sous-titres réalisés par la communauté d'Amara.org")).toBe(true);
  });
  it('keeps real sentences', () => {
    expect(isTranscriptNoise('Jarvis, allume la lumière du salon.')).toBe(false);
    expect(isTranscriptNoise('(Jarvis) quelle heure est-il maintenant ?')).toBe(false);
    expect(isTranscriptNoise('Oui')).toBe(false);
  });
});

describe('spokenDigest', () => {
  const reply = 'Voici la réponse. Elle contient plusieurs phrases. Une troisième pour la forme. Et une quatrième.\n\n```js\nconsole.log(1)\n```\n\nTu veux que je continue ?';
  it('speaks the first sentences and keeps the closing question', () => {
    const digest = spokenDigest(reply, 2);
    expect(digest.truncated).toBe(true);
    expect(digest.text).toBe('Voici la réponse. Elle contient plusieurs phrases. Tu veux que je continue ?');
  });
  it('leaves short replies untouched', () => {
    const digest = spokenDigest('Bonjour Michael. Tout va bien.', 4);
    expect(digest).toEqual({ text: 'Bonjour Michael. Tout va bien.', truncated: false });
  });
  it('ignores code blocks when counting and only reports a real question', () => {
    expect(spokenDigest('Une phrase.\n\n```\ncode\n```\n', 1).truncated).toBe(false);
    expect(closingQuestion(reply)).toBe('Tu veux que je continue ?');
    expect(closingQuestion('Aucune question ici.')).toBeNull();
  });
});
