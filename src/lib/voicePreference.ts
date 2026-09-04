/** Voice gender preference applied to every TTS provider (pure helpers, unit tested). */
import type { VoiceModelStatus } from '../../shared/voice';

export type VoiceGender = 'male' | 'female';

const MALE_HINTS = /\b(homme|male|masculin|paul|thomas|claude|henri|guillaume|mathieu|antoine|nicolas|denis|pierre|tom|adam|michael|eric|liam|george|lewis|daniel|fenrir|puck|onyx|echo|david|mark|richard|james|ryan|guy)\b/i;
const FEMALE_HINTS = /\b(femme|female|f[ée]minin|hortense|julie|denise|eloise|am[ée]lie|audrey|siwis|jessica|heart|bella|sarah|nicole|sky|alloy|nova|shimmer|zira|aria|jenny|emma|isabella|sophie|charlotte|vivienne|coral|sage)\b/i;

/** Best-effort gender from a voice or speaker label ("Piper Tom (homme, français)", "Microsoft Paul", "am_adam"). */
export function inferGender(name: string): VoiceGender | undefined {
  const n = name.replace(/_/g, ' ');
  if (/^(am|bm|em|hm|im|jm|pm|zm)\b/i.test(n) || MALE_HINTS.test(n)) return 'male';
  if (/^(af|bf|ef|ff|hf|if|jf|pf|zf)\b/i.test(n) || FEMALE_HINTS.test(n)) return 'female';
  return undefined;
}

/** OpenAI-compatible default voice for the preferred gender (used when the user left the field empty). */
export function defaultOpenAiVoice(gender: VoiceGender): string {
  return gender === 'male' ? 'onyx' : 'nova';
}

/** Rank system voices: language first, then gender, then quality hints. */
export function rankSystemVoice(v: { name: string; lang: string; localService?: boolean }, lang: string, gender: VoiceGender): number {
  const name = v.name.toLowerCase();
  let score = v.lang.toLowerCase().startsWith(lang) ? 100 : 0;
  const g = inferGender(v.name);
  if (g === gender) score += 50;
  else if (g && g !== gender) score -= 30;
  if (name.includes('natural') || name.includes('neural') || name.includes('online')) score += 20;
  if (name.includes('google')) score += 10;
  if (name.includes('microsoft')) score += 5;
  if (v.localService) score += 2;
  return score;
}

export interface LocalVoiceChoice {
  modelId: string;
  speaker: number;
}

/** Installed local voice matching language + gender, or null. */
export function findLocalVoice(models: VoiceModelStatus[], lang: string, gender: VoiceGender): LocalVoiceChoice | null {
  const l = lang.toLowerCase().split('-')[0];
  const installed = models.filter((m) => m.kind === 'tts' && m.installed);
  for (const model of installed) {
    for (const sp of model.speakers ?? []) {
      const spLang = (sp.lang || '').toLowerCase();
      if (spLang && spLang !== l && spLang !== 'multi') continue;
      const g = (sp as { gender?: string }).gender === 'm' ? 'male' : (sp as { gender?: string }).gender === 'f' ? 'female' : inferGender(sp.name);
      if (g === gender) return { modelId: model.id, speaker: sp.id };
    }
  }
  return null;
}

/** Catalog model to download when nothing installed offers the preferred gender (French). */
export function suggestedDownload(models: VoiceModelStatus[], lang: string, gender: VoiceGender): string | null {
  const l = lang.toLowerCase().split('-')[0];
  if (l !== 'fr') return null;
  const wanted = gender === 'male' ? ['piper-fr-tom', 'piper-fr-upmc'] : ['kokoro-v1', 'piper-fr-siwis'];
  for (const id of wanted) {
    const m = models.find((x) => x.id === id);
    if (m && !m.installed) return id;
  }
  return null;
}
