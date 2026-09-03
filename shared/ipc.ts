/**
 * Shared IPC contract between the Electron main process and the renderer.
 * Imported by both tsconfig projects; must stay free of Node/DOM-specific types.
 */

export type WindowMode = 'hud' | 'compact';

export interface HttpProxyFile {
  name: string;
  type: string;
  data: Uint8Array;
}

export interface HttpProxyRequest {
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  headers?: Record<string, string>;
  /** JSON/text body. Ignored when `multipart` is provided. */
  body?: string;
  /** Multipart form upload (used for speech-to-text). */
  multipart?: { fields: Record<string, string>; file: HttpProxyFile; fileField?: string };
  responseType?: 'text' | 'binary';
  timeoutMs?: number;
}

export interface HttpProxyResponse {
  ok: boolean;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  /** Present when responseType is 'text' (default). */
  text?: string;
  /** Present when responseType is 'binary'. */
  binary?: Uint8Array;
}

export interface HttpStreamStart {
  id: string;
  ok: boolean;
  status: number;
  statusText: string;
  headers: Record<string, string>;
}

export type HttpStreamEvent =
  | { id: string; type: 'chunk'; text: string }
  | { id: string; type: 'end' }
  | { id: string; type: 'error'; message: string };

export interface SystemMetrics {
  hostname: string;
  platform: string;
  cpuModel: string;
  cpuCores: number;
  cpuLoad: number; // 0-100
  cpuFreqMhz: number;
  memUsedPct: number; // 0-100
  memTotalGb: number;
  uptimeSec: number;
}

export interface HermesPushEvent {
  type: 'message' | 'job' | 'raw';
  role: 'user' | 'assistant' | 'system';
  text: string;
  source: string;
  images?: string[];
  jobName?: string;
  status?: string;
  receivedAt: string;
  raw?: unknown;
}

export interface LogEntry {
  ts: string;
  level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
  tag: string;
  message: string;
  data?: unknown;
}

export interface WebhookStatus {
  listening: boolean;
  port: number;
  path: string;
  secretConfigured: boolean;
  error?: string;
}

export interface AppInfo {
  version: string;
  platform: string;
  isPackaged: boolean;
  userDataPath: string;
  sharedDir: string;
  logPath: string;
}

export const IPC = {
  windowControl: 'window:control',
  windowSetMode: 'window:set-mode',
  windowModeChanged: 'window:mode-changed',
  windowVisibility: 'window:visibility',
  log: 'log:write',
  storeGet: 'store:get',
  storeSet: 'store:set',
  storeDelete: 'store:delete',
  httpFetch: 'http:fetch',
  httpStreamStart: 'http:stream:start',
  httpStreamAbort: 'http:stream:abort',
  httpStreamEvent: 'http:stream:event',
  metrics: 'system:metrics',
  appInfo: 'app:info',
  screenCapture: 'system:screen-capture',
  systemAction: 'system:action',
  readLocalFile: 'files:read-local',
  writeSharedFile: 'files:write-shared',
  openPath: 'files:open-path',
  showInFolder: 'files:show-in-folder',
  hermesPush: 'hermes:push',
  webhookStatus: 'webhook:status',
  webhookRestart: 'webhook:restart',
  hotkey: 'hotkey:event'
} as const;

export type HotkeyEvent = 'ptt-toggle' | 'toggle-window' | 'stop-speaking';
