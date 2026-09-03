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

export type Unsubscribe = () => void;

/** The API exposed on `window.eveflow` by the preload script. */
export interface EveFlowBridge {
  window: {
    control: (action: 'minimize' | 'maximize' | 'close' | 'hide') => void;
    setMode: (mode: WindowMode) => void;
    onModeChanged: (cb: (mode: WindowMode) => void) => Unsubscribe;
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
  system: {
    metrics: () => Promise<SystemMetrics>;
    appInfo: () => Promise<AppInfo>;
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
    webhookRestart: () => Promise<WebhookStatus>;
  };
  hotkeys: {
    on: (cb: (event: HotkeyEvent) => void) => Unsubscribe;
  };
}
