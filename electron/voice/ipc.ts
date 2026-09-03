import { ipcMain } from 'electron';
import { VOICE_IPC, type KwsStartRequest, type SynthesizeRequest, type TranscribeRequest } from '../../shared/voice';
import { engineStatus, kwsFeed, kwsStart, kwsStop, synthesize, transcribe, unload } from './engine';
import { cancelDownload, downloadModel, listModels, removeModel } from './models';

export function registerVoiceIpc(): void {
  ipcMain.handle(VOICE_IPC.status, () => engineStatus());
  ipcMain.handle(VOICE_IPC.modelsList, () => listModels());
  ipcMain.handle(VOICE_IPC.modelsDownload, (event, id: string) => downloadModel(id, event.sender));
  ipcMain.handle(VOICE_IPC.modelsCancel, (_e, id: string) => {
    cancelDownload(id);
    return true;
  });
  ipcMain.handle(VOICE_IPC.modelsRemove, async (_e, id: string) => {
    await unload(id).catch(() => undefined);
    await removeModel(id);
    return listModels();
  });
  ipcMain.handle(VOICE_IPC.transcribe, (_e, req: TranscribeRequest) => {
    if (!req || !(req.wav instanceof Uint8Array) || req.wav.byteLength < 44 || req.wav.byteLength > 64 * 1024 * 1024) throw new Error('Audio invalide');
    if (typeof req.modelId !== 'string') throw new Error('Modèle invalide');
    return transcribe({ ...req, language: typeof req.language === 'string' ? req.language.slice(0, 8) : 'auto' });
  });
  ipcMain.handle(VOICE_IPC.synthesize, (_e, req: SynthesizeRequest) => {
    if (!req || typeof req.text !== 'string' || !req.text.trim() || req.text.length > 5000) throw new Error('Texte invalide');
    if (typeof req.modelId !== 'string') throw new Error('Modèle invalide');
    return synthesize({ ...req, speaker: Number.isFinite(req.speaker) ? req.speaker : 0, speed: Number.isFinite(req.speed) ? req.speed : 1 });
  });
  ipcMain.handle(VOICE_IPC.unload, (_e, id?: string) => unload(id));
  ipcMain.handle(VOICE_IPC.kwsStart, (event, req: KwsStartRequest) => {
    if (!req || !Array.isArray(req.keywords) || typeof req.modelId !== 'string') throw new Error('Requête invalide');
    return kwsStart({ ...req, keywords: req.keywords.filter((k) => typeof k === 'string'), sensitivity: Number(req.sensitivity) || 3 }, event.sender);
  });
  ipcMain.handle(VOICE_IPC.kwsStop, () => kwsStop());
  ipcMain.on(VOICE_IPC.kwsAudio, (_e, pcm: unknown, sampleRate: unknown) => {
    if (!(pcm instanceof Uint8Array) || pcm.byteLength === 0 || pcm.byteLength > 1024 * 1024) return;
    kwsFeed(pcm, typeof sampleRate === 'number' && sampleRate > 0 ? sampleRate : 16000);
  });
}
