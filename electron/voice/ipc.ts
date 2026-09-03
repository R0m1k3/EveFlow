import { ipcMain } from 'electron';
import { VOICE_IPC, type SynthesizeRequest, type TranscribeRequest } from '../../shared/voice';
import { engineStatus, synthesize, transcribe, unload } from './engine';
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
}
