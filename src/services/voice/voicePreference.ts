/**
 * Applies the preferred voice gender to the active TTS provider: switches the local model/speaker,
 * downloads a matching French voice when none is installed, resets an Edge voice of the other
 * gender, and explains providers that cannot honour the choice (Google Translate).
 */
import { Log } from '../../lib/log';
import { bestLocalUpgrade, findLocalVoice, resolveEdgeVoice, suggestedDownload } from '../../lib/voicePreference';
import { useSettings } from '../../state/settings';
import { useVoiceModels } from '../../state/voiceModels';

let downloading: string | null = null;

const genderLabel = (g: 'male' | 'female') => (g === 'male' ? 'masculine' : 'féminine');

/**
 * Make the active provider match `speech.voiceGender`. Returns a short status message.
 * With `upgrade`, the best local model for the language is downloaded even if a lesser voice exists.
 */
export async function ensurePreferredVoice(options: { upgrade?: boolean } = {}): Promise<string> {
  const { settings, update } = useSettings.getState();
  const { speech } = settings;
  const gender = speech.voiceGender ?? 'male';
  const lang = speech.language || 'fr-FR';

  if (speech.provider === 'edge') {
    const voice = resolveEdgeVoice(speech.edgeVoice ?? '', lang, gender);
    if (voice !== (speech.edgeVoice ?? '').trim() && speech.edgeVoice) update({ speech: { edgeVoice: '' } });
    return `Voix ${genderLabel(gender)} : ${voice.split('-')[2]?.replace(/(Multilingual)?Neural$/, '') ?? voice} (Edge)`;
  }
  if (speech.provider === 'google-free') {
    return gender === 'male'
      ? 'Google Translate n’a qu’une voix féminine par langue : choisissez « Microsoft Edge » ou une voix locale pour une voix masculine.'
      : '';
  }
  if (speech.provider !== 'local') return '';

  const models = useVoiceModels.getState().models;
  if (!models.length) return '';
  const current = models.find((m) => m.id === speech.localModel);
  const currentSpeaker = current?.speakers?.find((s) => s.id === speech.localSpeaker);
  const currentGender = currentSpeaker ? (currentSpeaker.gender === 'm' ? 'male' : currentSpeaker.gender === 'f' ? 'female' : undefined) : undefined;
  const upgrade = options.upgrade ? bestLocalUpgrade(models, lang) : null;
  if (current?.installed && currentGender === gender && !upgrade) return '';

  const choice = upgrade ? null : findLocalVoice(models, lang, gender);
  if (choice) {
    update({ speech: { localModel: choice.modelId, localSpeaker: choice.speaker } });
    const name = models.find((m) => m.id === choice.modelId)?.speakers?.find((s) => s.id === choice.speaker)?.name ?? choice.modelId;
    Log.info('tts', `voice preference ${gender}: ${name}`);
    return `Voix ${genderLabel(gender)} : ${name}`;
  }
  const download = upgrade ?? suggestedDownload(models, lang, gender);
  if (!download || downloading === download) return download ? 'Téléchargement de la voix en cours…' : '';
  downloading = download;
  Log.info('tts', `${upgrade ? 'upgrading local voice' : `no ${gender} voice installed`}, downloading ${download}`);
  try {
    await useVoiceModels.getState().download(download);
    const after = findLocalVoice(useVoiceModels.getState().models, lang, gender);
    if (after) update({ speech: { localModel: after.modelId, localSpeaker: after.speaker } });
    const name = after ? useVoiceModels.getState().models.find((m) => m.id === after.modelId)?.name : undefined;
    return after ? `Voix ${genderLabel(gender)} installée : ${name ?? after.modelId}.` : 'Voix téléchargée.';
  } catch (err) {
    Log.warn('tts', `voice download failed: ${(err as Error).message}`);
    return `Téléchargement impossible : ${(err as Error).message}`;
  } finally {
    downloading = null;
  }
}
