import type {
  AppInfo,
  HermesPushEvent,
  HotkeyEvent,
  HttpProxyRequest,
  HttpProxyResponse,
  HttpStreamEvent,
  HttpStreamStart,
  LogEntry,
  SystemMetrics,
  WebhookStatus,
  WindowMode
} from './ipc';
import type { McpToolRequest, McpToolResponse } from './ipc';
import type {
  EdgeSynthesizeRequest,
  EdgeSynthesizeResult,
  EdgeVoice,
  KwsDetection,
  KwsStartRequest,
  VadEvent,
  VadStartRequest,
  SynthesizeRequest,
  SynthesizeResult,
  TranscribeRequest,
  TranscribeResult,
  VoiceDownloadProgress,
  VoiceEngineStatus,
  VoiceModelStatus
} from './voice';

export type Unsubscribe = () => void;

/** The API exposed on `window.eveflow` by the preload script. */
export interface EveFlowBridge {
  window: {
    control: (action: 'minimize' | 'maximize' | 'close' | 'hide') => void;
    setMode: (mode: WindowMode) => void;
    onModeChanged: (cb: (mode: WindowMode) => void) => Unsubscribe;
    /** Fires when the window is shown/hidden/minimised (the Page Visibility API is disabled by backgroundThrottling:false). */
    onVisibility: (cb: (visible: boolean) => void) => Unsubscribe;
  };
  log: (entry: LogEntry) => void;
  store: {
    get: <T = unknown>(key: string) => Promise<T | null>;
    set: (key: string, value: unknown) => Promise<boolean>;
    delete: (key: string) => Promise<boolean>;
  };
  http: {
    fetch: (req: HttpProxyRequest) => Promise<HttpProxyResponse>;
    streamStart: (id: string, req: HttpProxyRequest) => Promise<HttpStreamStart>;
    streamAbort: (id: string) => void;
    onStreamEvent: (cb: (event: HttpStreamEvent) => void) => Unsubscribe;
  };
  files: {
    readLocal: (filePath: string) => Promise<string>;
    writeShared: (filename: string, content: string, isBase64?: boolean) => Promise<{ path: string; url: string }>;
    openPath: (filePath: string) => Promise<boolean>;
    showInFolder: (filePath: string) => Promise<boolean>;
  };
  hermes: {
    onPush: (cb: (event: HermesPushEvent) => void) => Unsubscribe;
    webhookStatus: () => Promise<WebhookStatus>;
    /** Tool calls from Hermes via the local MCP endpoint that need the renderer. */
    onToolRequest: (cb: (req: McpToolRequest) => void) => Unsubscribe;
    toolResponse: (res: McpToolResponse) => void;
    webhookRestart: () => Promise<WebhookStatus>;
  };
  hotkeys: {
    on: (cb: (event: HotkeyEvent) => void) => Unsubscribe;
  };
  voice: {
    status: () => Promise<VoiceEngineStatus>;
    listModels: () => Promise<VoiceModelStatus[]>;
    downloadModel: (id: string) => Promise<VoiceModelStatus>;
    cancelDownload: (id: string) => Promise<boolean>;
    removeModel: (id: string) => Promise<VoiceModelStatus[]>;
    onProgress: (cb: (progress: VoiceDownloadProgress) => void) => Unsubscribe;
    transcribe: (req: TranscribeRequest) => Promise<TranscribeResult>;
    synthesize: (req: SynthesizeRequest) => Promise<SynthesizeResult>;
    /** Microsoft Edge neural voices (online, free): MP3 for one sentence. */
    edgeSynthesize: (req: EdgeSynthesizeRequest) => Promise<EdgeSynthesizeResult>;
    edgeVoices: () => Promise<EdgeVoice[]>;
    unload: (id?: string) => Promise<unknown>;
    kwsStart: (req: KwsStartRequest) => Promise<{ accepted: string[]; rejected: string[] }>;
    kwsStop: () => Promise<void>;
    /** Fire-and-forget 16-bit PCM frames for the keyword spotter. */
    kwsAudio: (pcm: Uint8Array, sampleRate: number) => void;
    onKwsDetected: (cb: (detection: KwsDetection) => void) => Unsubscribe;
    vadStart: (req: VadStartRequest) => Promise<void>;
    vadStop: () => Promise<void>;
    vadAudio: (pcm: Uint8Array, sampleRate: number) => void;
    onVadEvent: (cb: (event: VadEvent) => void) => Unsubscribe;
  };
  system: {
    metrics: () => Promise<SystemMetrics>;
    appInfo: () => Promise<AppInfo>;
    /** Screenshot of the primary display as a JPEG data URL. */
    captureScreen: (maxWidth?: number) => Promise<string>;
    /** Allow-listed local actions (lock session, open app/url, media keys, clipboard). */
    action: (action: SystemAction) => Promise<SystemActionResult>;
  };
}

export type SystemAction =
  | { type: 'lock' }
  | { type: 'open-app'; name: string }
  | { type: 'open-url'; url: string }
  | { type: 'media'; key: 'volume-up' | 'volume-down' | 'mute' | 'play-pause' | 'next' | 'previous' }
  | { type: 'clipboard-read' }
  | { type: 'clipboard-write'; text: string }
  | { type: 'find-files'; query: string };

export interface SystemActionResult {
  ok: boolean;
  message?: string;
  data?: unknown;
}
