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
  ipcMain.handle(VOICE_IPC.transcribe, (_e, req: TranscribeRequest) => transcribe(req));
  ipcMain.handle(VOICE_IPC.synthesize, (_e, req: SynthesizeRequest) => synthesize(req));
  ipcMain.handle(VOICE_IPC.unload, (_e, id?: string) => unload(id));
}
