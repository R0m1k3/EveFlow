import { contextBridge, ipcRenderer } from 'electron';
import {
  IPC,
  type AppInfo,
  type HermesPushEvent,
  type HotkeyEvent,
  type HttpProxyRequest,
  type HttpProxyResponse,
  type HttpStreamEvent,
  type HttpStreamStart,
  type LogEntry,
  type SystemMetrics,
  type WebhookStatus,
  type WindowMode
} from '../shared/ipc';
import type { EveFlowBridge, Unsubscribe } from '../shared/bridge';
import { VOICE_IPC, type SynthesizeRequest, type SynthesizeResult, type TranscribeRequest, type TranscribeResult, type VoiceDownloadProgress, type VoiceEngineStatus, type VoiceModelStatus } from '../shared/voice';

function subscribe<T>(channel: string, callback: (payload: T) => void): Unsubscribe {
  const listener = (_event: Electron.IpcRendererEvent, payload: T) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api: EveFlowBridge = {
  window: {
    control: (action: 'minimize' | 'maximize' | 'close' | 'hide') => ipcRenderer.send(IPC.windowControl, action),
    setMode: (mode: WindowMode) => ipcRenderer.send(IPC.windowSetMode, mode),
    onModeChanged: (cb: (mode: WindowMode) => void) => subscribe<WindowMode>(IPC.windowModeChanged, cb),
    onVisibility: (cb: (visible: boolean) => void) => subscribe<boolean>(IPC.windowVisibility, cb)
  },
  log: (entry: LogEntry) => ipcRenderer.send(IPC.log, entry),
  store: {
    get: <T = unknown>(key: string) => ipcRenderer.invoke(IPC.storeGet, key) as Promise<T | null>,
    set: (key: string, value: unknown) => ipcRenderer.invoke(IPC.storeSet, key, value) as Promise<boolean>,
    delete: (key: string) => ipcRenderer.invoke(IPC.storeDelete, key) as Promise<boolean>
  },
  http: {
    fetch: (req: HttpProxyRequest) => ipcRenderer.invoke(IPC.httpFetch, req) as Promise<HttpProxyResponse>,
    streamStart: (id: string, req: HttpProxyRequest) => ipcRenderer.invoke(IPC.httpStreamStart, id, req) as Promise<HttpStreamStart>,
    streamAbort: (id: string) => ipcRenderer.send(IPC.httpStreamAbort, id),
    onStreamEvent: (cb: (event: HttpStreamEvent) => void) => subscribe<HttpStreamEvent>(IPC.httpStreamEvent, cb)
  },
  system: {
    metrics: () => ipcRenderer.invoke(IPC.metrics) as Promise<SystemMetrics>,
    appInfo: () => ipcRenderer.invoke(IPC.appInfo) as Promise<AppInfo>
  },
  files: {
    readLocal: (filePath: string) => ipcRenderer.invoke(IPC.readLocalFile, filePath) as Promise<string>,
    writeShared: (filename: string, content: string, isBase64 = false) =>
      ipcRenderer.invoke(IPC.writeSharedFile, filename, content, isBase64) as Promise<{ path: string; url: string }>,
    openPath: (filePath: string) => ipcRenderer.invoke(IPC.openPath, filePath) as Promise<boolean>,
    showInFolder: (filePath: string) => ipcRenderer.invoke(IPC.showInFolder, filePath) as Promise<boolean>
  },
  hermes: {
    onPush: (cb: (event: HermesPushEvent) => void) => subscribe<HermesPushEvent>(IPC.hermesPush, cb),
    webhookStatus: () => ipcRenderer.invoke(IPC.webhookStatus) as Promise<WebhookStatus>,
    webhookRestart: () => ipcRenderer.invoke(IPC.webhookRestart) as Promise<WebhookStatus>
  },
  hotkeys: {
    on: (cb: (event: HotkeyEvent) => void) => subscribe<HotkeyEvent>(IPC.hotkey, cb)
  },
  voice: {
    status: () => ipcRenderer.invoke(VOICE_IPC.status) as Promise<VoiceEngineStatus>,
    listModels: () => ipcRenderer.invoke(VOICE_IPC.modelsList) as Promise<VoiceModelStatus[]>,
    downloadModel: (id: string) => ipcRenderer.invoke(VOICE_IPC.modelsDownload, id) as Promise<VoiceModelStatus>,
    cancelDownload: (id: string) => ipcRenderer.invoke(VOICE_IPC.modelsCancel, id) as Promise<boolean>,
    removeModel: (id: string) => ipcRenderer.invoke(VOICE_IPC.modelsRemove, id) as Promise<VoiceModelStatus[]>,
    onProgress: (cb: (progress: VoiceDownloadProgress) => void) => subscribe<VoiceDownloadProgress>(VOICE_IPC.modelsProgress, cb),
    transcribe: (req: TranscribeRequest) => ipcRenderer.invoke(VOICE_IPC.transcribe, req) as Promise<TranscribeResult>,
    synthesize: (req: SynthesizeRequest) => ipcRenderer.invoke(VOICE_IPC.synthesize, req) as Promise<SynthesizeResult>,
    unload: (id?: string) => ipcRenderer.invoke(VOICE_IPC.unload, id) as Promise<unknown>
  }
};

contextBridge.exposeInMainWorld('eveflow', api);
