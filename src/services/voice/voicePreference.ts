/**
 * Applies the preferred voice gender to the active TTS provider: switches the local model/speaker,
 * downloads a matching French voice when none is installed, and logs what it did.
 */
import { Log } from '../../lib/log';
import { findLocalVoice, inferGender, suggestedDownload } from '../../lib/voicePreference';
import { useSettings } from '../../state/settings';
import { useVoiceModels } from '../../state/voiceModels';

let downloading: string | null = null;

/** Make the local voice match `speech.voiceGender`. Returns a short status message. */
export async function ensurePreferredVoice(): Promise<string> {
  const { settings, update } = useSettings.getState();
  const { speech } = settings;
  const gender = speech.voiceGender ?? 'male';
  if (speech.provider !== 'local') return '';
  const models = useVoiceModels.getState().models;
  if (!models.length) return '';
  const lang = speech.language || 'fr-FR';
  const current = models.find((m) => m.id === speech.localModel);
  const currentSpeaker = current?.speakers?.find((s) => s.id === speech.localSpeaker);
  const currentGender = currentSpeaker ? (currentSpeaker as { gender?: string }).gender === 'm' ? 'male' : (currentSpeaker as { gender?: string }).gender === 'f' ? 'female' : inferGender(currentSpeaker.name) : undefined;
  if (current?.installed && currentGender === gender) return '';

  const choice = findLocalVoice(models, lang, gender);
  if (choice) {
    update({ speech: { localModel: choice.modelId, localSpeaker: choice.speaker } });
    const name = models.find((m) => m.id === choice.modelId)?.speakers?.find((s) => s.id === choice.speaker)?.name ?? choice.modelId;
    Log.info('tts', `voice preference ${gender}: ${name}`);
    return `Voix ${gender === 'male' ? 'masculine' : 'féminine'} : ${name}`;
  }
  const download = suggestedDownload(models, lang, gender);
  if (!download || downloading === download) return download ? 'Téléchargement de la voix en cours…' : '';
  downloading = download;
  Log.info('tts', `no ${gender} voice installed, downloading ${download}`);
  try {
    await useVoiceModels.getState().download(download);
    const after = findLocalVoice(useVoiceModels.getState().models, lang, gender);
    if (after) update({ speech: { localModel: after.modelId, localSpeaker: after.speaker } });
    return after ? `Voix ${gender === 'male' ? 'masculine' : 'féminine'} installée.` : 'Voix téléchargée.';
  } catch (err) {
    Log.warn('tts', `voice download failed: ${(err as Error).message}`);
    return `Téléchargement impossible : ${(err as Error).message}`;
  } finally {
    downloading = null;
  }
}
