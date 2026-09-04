import { describe, expect, it } from 'vitest';
import { defaultOpenAiVoice, findLocalVoice, inferGender, rankSystemVoice, suggestedDownload } from '../src/lib/voicePreference';
import type { VoiceModelStatus } from '../shared/voice';

const model = (id: string, installed: boolean, speakers: Array<{ id: number; name: string; lang: string }>): VoiceModelStatus =>
  ({ id, kind: 'tts', engine: 'piper', name: id, description: '', languages: ['fr'], sizeMb: 1, url: '', dir: id, files: [], speakers, installed, installedBytes: 0 }) as unknown as VoiceModelStatus;

describe('inferGender', () => {
  it('reads catalog labels, system voices and kokoro ids', () => {
    expect(inferGender('Piper Tom (homme, français)')).toBe('male');
    expect(inferGender('Siwis (femme, français)')).toBe('female');
    expect(inferGender('Microsoft Paul - French (France)')).toBe('male');
    expect(inferGender('Microsoft Hortense - French (France)')).toBe('female');
    expect(inferGender('am_adam')).toBe('male');
    expect(inferGender('Voix 3')).toBeUndefined();
  });
});

describe('local voice selection', () => {
  const models = [
    model('kokoro-v1', true, [{ id: 30, name: 'Siwis (femme, français)', lang: 'fr' }, { id: 4, name: 'Adam (homme, anglais US)', lang: 'en' }]),
    model('piper-fr-tom', false, [{ id: 0, name: 'Tom', lang: 'fr' }]),
    model('piper-fr-upmc', true, [{ id: 0, name: 'Jessica (femme)', lang: 'fr' }, { id: 1, name: 'Pierre (homme)', lang: 'fr' }])
  ];
  it('prefers an installed speaker of the wanted gender in the right language', () => {
    expect(findLocalVoice(models, 'fr-FR', 'male')).toEqual({ modelId: 'piper-fr-upmc', speaker: 1 });
    expect(findLocalVoice(models, 'fr-FR', 'female')).toEqual({ modelId: 'kokoro-v1', speaker: 30 });
    expect(findLocalVoice(models.slice(0, 2), 'fr', 'male')).toBeNull();
  });
  it('suggests a French download when nothing matches', () => {
    expect(suggestedDownload(models, 'fr', 'male')).toBe('piper-fr-tom');
    expect(suggestedDownload(models, 'en', 'male')).toBeNull();
  });
});

describe('provider defaults', () => {
  it('picks onyx for male and nova for female on OpenAI-compatible APIs', () => {
    expect(defaultOpenAiVoice('male')).toBe('onyx');
    expect(defaultOpenAiVoice('female')).toBe('nova');
  });
  it('ranks system voices by language then gender', () => {
    const paul = { name: 'Microsoft Paul - French (France)', lang: 'fr-FR', localService: true };
    const hortense = { name: 'Microsoft Hortense - French (France)', lang: 'fr-FR', localService: true };
    const david = { name: 'Microsoft David - English (US)', lang: 'en-US', localService: true };
    expect(rankSystemVoice(paul, 'fr', 'male')).toBeGreaterThan(rankSystemVoice(hortense, 'fr', 'male'));
    expect(rankSystemVoice(hortense, 'fr', 'female')).toBeGreaterThan(rankSystemVoice(paul, 'fr', 'female'));
    expect(rankSystemVoice(paul, 'fr', 'male')).toBeGreaterThan(rankSystemVoice(david, 'fr', 'male'));
  });
});
