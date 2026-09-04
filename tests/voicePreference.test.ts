import { describe, expect, it } from 'vitest';
import { bestLocalUpgrade, defaultOpenAiVoice, findLocalVoice, inferGender, pickSpeaker, rankSystemVoice, resolveEdgeVoice, suggestedDownload } from '../src/lib/voicePreference';
import type { VoiceModelStatus, VoiceSpeaker } from '../shared/voice';

const model = (id: string, installed: boolean, speakers: VoiceSpeaker[], languages = ['fr']): VoiceModelStatus =>
  ({ id, kind: 'tts', engine: 'piper', name: id, description: '', languages, sizeMb: 1, url: '', dir: id, files: [], speakers, installed, installedBytes: 0 }) as unknown as VoiceModelStatus;

describe('inferGender', () => {
  it('reads catalog labels, system voices, kokoro ids and Edge short names', () => {
    expect(inferGender('Piper Tom (homme, français)')).toBe('male');
    expect(inferGender('Siwis (femme, français)')).toBe('female');
    expect(inferGender('Microsoft Paul - French (France)')).toBe('male');
    expect(inferGender('Microsoft Hortense - French (France)')).toBe('female');
    expect(inferGender('am_adam')).toBe('male');
    expect(inferGender('fr-FR-HenriNeural')).toBe('male');
    expect(inferGender('fr-FR-DeniseNeural')).toBe('female');
    expect(inferGender('Voix 3')).toBeUndefined();
  });
});

describe('local voice selection', () => {
  const supertonic: VoiceSpeaker[] = [
    { id: 6, name: 'Homme 2 (grave, posé)', lang: 'multi', gender: 'm' },
    { id: 0, name: 'Femme 1', lang: 'multi', gender: 'f' }
  ];
  const models = [
    model('kokoro-v1', true, [{ id: 30, name: 'Siwis (femme, français)', lang: 'fr' }, { id: 4, name: 'Adam (homme, anglais US)', lang: 'en' }], ['en', 'fr', 'multi']),
    model('piper-fr-tom', false, [{ id: 0, name: 'Tom', lang: 'fr' }]),
    model('piper-fr-upmc', true, [{ id: 0, name: 'Jessica (femme)', lang: 'fr' }, { id: 1, name: 'Pierre (homme)', lang: 'fr' }]),
    model('supertonic-3', false, supertonic, ['fr', 'en', 'multi'])
  ];
  it('prefers an installed speaker of the wanted gender in the right language', () => {
    expect(findLocalVoice(models, 'fr-FR', 'male')).toEqual({ modelId: 'piper-fr-upmc', speaker: 1 });
    expect(findLocalVoice(models, 'fr-FR', 'female')).toEqual({ modelId: 'kokoro-v1', speaker: 30 });
    expect(findLocalVoice(models.slice(0, 2), 'fr', 'male')).toBeNull();
  });
  it('ranks Supertonic above Kokoro and Piper once installed', () => {
    const installed = models.map((m) => (m.id === 'supertonic-3' ? { ...m, installed: true } : m));
    expect(findLocalVoice(installed, 'fr-FR', 'male')).toEqual({ modelId: 'supertonic-3', speaker: 6 });
    expect(findLocalVoice(installed, 'fr-FR', 'female')).toEqual({ modelId: 'supertonic-3', speaker: 0 });
  });
  it('suggests Supertonic first, then the Piper voices, for a French download', () => {
    expect(suggestedDownload(models, 'fr', 'male')).toBe('supertonic-3');
    expect(suggestedDownload(models.filter((m) => m.id !== 'supertonic-3'), 'fr', 'male')).toBe('piper-fr-tom');
    expect(suggestedDownload(models, 'en', 'male')).toBeNull();
  });
  it('reports the best local model still to download', () => {
    expect(bestLocalUpgrade(models, 'fr-FR')).toBe('supertonic-3');
    expect(bestLocalUpgrade(models.map((m) => ({ ...m, installed: true })), 'fr-FR')).toBeNull();
  });
  it('keeps the gender when switching models and falls back to the language', () => {
    expect(pickSpeaker(models[3], 'fr-FR', 'male')).toBe(6);
    expect(pickSpeaker(models[3], 'fr-FR', 'female')).toBe(0);
    expect(pickSpeaker(models[2], 'fr', 'male')).toBe(1);
    // Kokoro: no masculine French voice → the French voice, not an English one.
    expect(pickSpeaker(models[0], 'fr', 'male')).toBe(30);
    expect(pickSpeaker({ speakers: [] }, 'fr', 'male')).toBe(0);
  });
});

describe('provider defaults', () => {
  it('picks onyx for male and nova for female on OpenAI-compatible APIs', () => {
    expect(defaultOpenAiVoice('male')).toBe('onyx');
    expect(defaultOpenAiVoice('female')).toBe('nova');
  });
  it('keeps an explicit Edge voice only when it matches the gender', () => {
    expect(resolveEdgeVoice('', 'fr-FR', 'male')).toBe('fr-FR-HenriNeural');
    expect(resolveEdgeVoice('fr-FR-RemyMultilingualNeural', 'fr-FR', 'male')).toBe('fr-FR-RemyMultilingualNeural');
    expect(resolveEdgeVoice('fr-FR-DeniseNeural', 'fr-FR', 'male')).toBe('fr-FR-HenriNeural');
    expect(resolveEdgeVoice('fr-CH-ArianeNeural', 'fr-FR', 'female')).toBe('fr-CH-ArianeNeural');
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
