/** Voice gender preference applied to every TTS provider (pure helpers, unit tested). */
import type { VoiceModelStatus, VoiceSpeaker } from '../../shared/voice';
import { defaultEdgeVoice, edgeVoiceGender } from '../../shared/edgeTts';

export type VoiceGender = 'male' | 'female';

const MALE_HINTS =
  /\b(homme|male|masculin|paul|thomas|claude|henri|remy|rémy|gerard|guillaume|mathieu|antoine|nicolas|denis|pierre|tom|adam|michael|eric|liam|george|lewis|daniel|fenrir|puck|onyx|echo|david|mark|richard|james|ryan|guy|dylan|aiden|uncle fu|andrew|brian|fabrice|jean|thierry)\b/i;
const FEMALE_HINTS =
  /\b(femme|female|f[ée]minin|hortense|julie|denise|eloise|vivienne|charline|sylvie|ariane|am[ée]lie|audrey|siwis|jessica|heart|bella|sarah|nicole|sky|alloy|nova|shimmer|zira|aria|jenny|emma|ava|isabella|sophie|charlotte|coral|sage|vivian|serena|sohee|ono anna)\b/i;

/** Best-effort gender from a voice or speaker label ("Piper Tom (homme, français)", "Microsoft Paul", "am_adam", "fr-FR-HenriNeural"). */
export function inferGender(name: string): VoiceGender | undefined {
  const edge = edgeVoiceGender(name);
  if (edge) return edge;
  const n = name.replace(/_/g, ' ');
  if (/^(am|bm|em|hm|im|jm|pm|zm)\b/i.test(n) || MALE_HINTS.test(n)) return 'male';
  if (/^(af|bf|ef|ff|hf|if|jf|pf|zf)\b/i.test(n) || FEMALE_HINTS.test(n)) return 'female';
  return undefined;
}

/** OpenAI-compatible default voice for the preferred gender (used when the user left the field empty). */
export function defaultOpenAiVoice(gender: VoiceGender): string {
  return gender === 'male' ? 'onyx' : 'nova';
}

/** Edge voice to use: the explicit choice when it matches the gender, otherwise the language default. */
export function resolveEdgeVoice(explicit: string, language: string, gender: VoiceGender): string {
  const chosen = explicit.trim();
  if (chosen && (edgeVoiceGender(chosen) ?? gender) === gender) return chosen;
  return defaultEdgeVoice(language, gender);
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

/** Local models from best to worst French rendering; unknown models come last. */
const LOCAL_QUALITY: Record<string, number> = { 'supertonic-3': 0, 'kokoro-v1': 1, 'piper-fr-upmc': 2, 'piper-fr-tom': 3, 'piper-fr-siwis': 4 };

export function localQualityRank(modelId: string): number {
  return LOCAL_QUALITY[modelId] ?? 9;
}

function speakerGender(sp: VoiceSpeaker): VoiceGender | undefined {
  return sp.gender === 'm' ? 'male' : sp.gender === 'f' ? 'female' : inferGender(sp.name);
}

function speakerSpeaks(sp: VoiceSpeaker, lang: string): boolean {
  const spLang = (sp.lang || '').toLowerCase();
  return !spLang || spLang === lang || spLang === 'multi';
}

/** First speaker of a model matching language + gender; falls back to any speaker of the language, then the first one. */
export function pickSpeaker(model: Pick<VoiceModelStatus, 'speakers'>, lang: string, gender: VoiceGender): number {
  const l = lang.toLowerCase().split('-')[0];
  const speakers = model.speakers ?? [];
  const exact = speakers.find((sp) => speakerSpeaks(sp, l) && speakerGender(sp) === gender);
  const sameLang = speakers.find((sp) => speakerSpeaks(sp, l));
  return (exact ?? sameLang ?? speakers[0])?.id ?? 0;
}

/** Installed local voice matching language + gender (best model first), or null. */
export function findLocalVoice(models: VoiceModelStatus[], lang: string, gender: VoiceGender): LocalVoiceChoice | null {
  const l = lang.toLowerCase().split('-')[0];
  const installed = models.filter((m) => m.kind === 'tts' && m.installed).sort((a, b) => localQualityRank(a.id) - localQualityRank(b.id));
  for (const model of installed) {
    for (const sp of model.speakers ?? []) {
      if (!speakerSpeaks(sp, l)) continue;
      if (speakerGender(sp) === gender) return { modelId: model.id, speaker: sp.id };
    }
  }
  return null;
}

/** Catalog model to download when nothing installed offers the preferred gender (French). */
export function suggestedDownload(models: VoiceModelStatus[], lang: string, gender: VoiceGender): string | null {
  const l = lang.toLowerCase().split('-')[0];
  if (l !== 'fr') return null;
  const wanted = gender === 'male' ? ['supertonic-3', 'piper-fr-tom', 'piper-fr-upmc'] : ['supertonic-3', 'kokoro-v1', 'piper-fr-siwis'];
  for (const id of wanted) {
    const m = models.find((x) => x.id === id);
    if (m && !m.installed) return id;
  }
  return null;
}

/** Best local model in the catalog for the language that is not installed yet (null when the best is already there). */
export function bestLocalUpgrade(models: VoiceModelStatus[], lang: string): string | null {
  const l = lang.toLowerCase().split('-')[0];
  const best = models
    .filter((m) => m.kind === 'tts' && (m.languages.includes(l) || m.languages.includes('multi')))
    .sort((a, b) => localQualityRank(a.id) - localQualityRank(b.id))[0];
  return best && !best.installed ? best.id : null;
}
