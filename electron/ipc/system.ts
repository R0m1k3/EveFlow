/**
 * Local "JARVIS" actions: screenshot for vision, and an allow-list of system actions
 * (lock, open an application or URL, media keys, clipboard, file search).
 */
import { app, clipboard, desktopCapturer, ipcMain, screen, shell } from 'electron';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IPC } from '../../shared/ipc';
import type { SystemAction, SystemActionResult } from '../../shared/bridge';
import { log } from '../logger';

const MEDIA_KEYS: Record<string, number> = {
  'volume-up': 175,
  'volume-down': 174,
  mute: 173,
  'play-pause': 179,
  next: 176,
  previous: 177
};

/** Applications the assistant may launch by name (Windows aliases + common Linux/macOS names). */
const APP_ALIASES: Record<string, string[]> = {
  'bloc-notes': ['notepad.exe', 'gedit', 'TextEdit'],
  notepad: ['notepad.exe', 'gedit', 'TextEdit'],
  calculatrice: ['calc.exe', 'gnome-calculator', 'Calculator'],
  calc: ['calc.exe', 'gnome-calculator', 'Calculator'],
  explorateur: ['explorer.exe', 'nautilus', 'Finder'],
  explorer: ['explorer.exe', 'nautilus', 'Finder'],
  terminal: ['wt.exe', 'cmd.exe', 'gnome-terminal', 'Terminal'],
  cmd: ['cmd.exe'],
  powershell: ['powershell.exe'],
  paint: ['mspaint.exe'],
  chrome: ['chrome', 'google-chrome', 'Google Chrome'],
  edge: ['msedge', 'microsoft-edge', 'Microsoft Edge'],
  firefox: ['firefox', 'Firefox'],
  vscode: ['code', 'Visual Studio Code'],
  code: ['code', 'Visual Studio Code'],
  spotify: ['spotify', 'Spotify'],
  discord: ['discord', 'Discord'],
  steam: ['steam', 'Steam'],
  word: ['winword', 'Microsoft Word'],
  excel: ['excel', 'Microsoft Excel'],
  outlook: ['outlook', 'Microsoft Outlook'],
  teams: ['ms-teams', 'Microsoft Teams'],
  'task manager': ['taskmgr.exe'],
  'gestionnaire des tâches': ['taskmgr.exe'],
  paramètres: ['ms-settings:'],
  settings: ['ms-settings:']
};

function run(cmd: string, args: string[], timeoutMs = 8000): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ code: err ? 1 : 0, out: `${stdout}${stderr}`.trim() });
    });
  });
}

async function openApp(name: string): Promise<SystemActionResult> {
  const key = name.trim().toLowerCase();
  if (!key || key.length > 40) return { ok: false, message: 'Nom d’application invalide' };
  const candidates = APP_ALIASES[key] ?? [key.replace(/[^a-z0-9 ._-]/gi, '')];
  if (process.platform === 'win32') {
    for (const candidate of candidates) {
      if (candidate.endsWith(':')) {
        await shell.openExternal(candidate);
        return { ok: true, message: `${name} ouvert` };
      }
      // `start` resolves App Paths, PATH and Start Menu names.
      const result = await run('cmd.exe', ['/c', 'start', '', candidate]);
      if (result.code === 0) return { ok: true, message: `${name} lancé` };
    }
    return { ok: false, message: `Impossible de lancer ${name}` };
  }
  for (const candidate of candidates) {
    const result = process.platform === 'darwin' ? await run('open', ['-a', candidate]) : await run('sh', ['-c', `command -v ${JSON.stringify(candidate)} >/dev/null && (nohup ${JSON.stringify(candidate)} >/dev/null 2>&1 &)`]);
    if (result.code === 0) return { ok: true, message: `${name} lancé` };
  }
  return { ok: false, message: `Application introuvable : ${name}` };
}

async function lockSession(): Promise<SystemActionResult> {
  if (process.platform === 'win32') {
    const r = await run('rundll32.exe', ['user32.dll,LockWorkStation']);
    return { ok: r.code === 0, message: r.code === 0 ? 'Session verrouillée' : r.out };
  }
  if (process.platform === 'darwin') {
    const r = await run('osascript', ['-e', 'tell application "System Events" to keystroke "q" using {command down, control down}']);
    return { ok: r.code === 0, message: r.out };
  }
  const r = await run('sh', ['-c', 'loginctl lock-session || xdg-screensaver lock || gnome-screensaver-command -l']);
  return { ok: r.code === 0, message: r.code === 0 ? 'Session verrouillée' : r.out };
}

async function mediaKey(key: string): Promise<SystemActionResult> {
  const code = MEDIA_KEYS[key];
  if (!code) return { ok: false, message: 'Touche inconnue' };
  if (process.platform === 'win32') {
    const script = `$s=Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern void keybd_event(byte b,byte s,uint f,UIntPtr e);' -Name K -Namespace W -PassThru; $s::keybd_event(${code},0,0,[UIntPtr]::Zero); $s::keybd_event(${code},0,2,[UIntPtr]::Zero)`;
    const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
    return { ok: r.code === 0, message: r.code === 0 ? key : r.out };
  }
  const xdo: Record<string, string> = { 'volume-up': 'XF86AudioRaiseVolume', 'volume-down': 'XF86AudioLowerVolume', mute: 'XF86AudioMute', 'play-pause': 'XF86AudioPlay', next: 'XF86AudioNext', previous: 'XF86AudioPrev' };
  const r = await run('sh', ['-c', `xdotool key ${xdo[key]}`]);
  return { ok: r.code === 0, message: r.code === 0 ? key : 'xdotool indisponible' };
}

async function findFiles(query: string): Promise<SystemActionResult> {
  const needle = query.trim().toLowerCase();
  if (needle.length < 2) return { ok: false, message: 'Recherche trop courte' };
  const roots = ['Documents', 'Desktop', 'Downloads', 'Pictures'].map((d) => path.join(os.homedir(), d));
  const hits: string[] = [];
  const deadline = Date.now() + 4000;
  const walk = async (dir: string, depth: number) => {
    if (depth > 4 || hits.length >= 25 || Date.now() > deadline) return;
    let entries: fs.Dirent[] = [];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      if (entry.name.toLowerCase().includes(needle)) hits.push(full);
      if (entry.isDirectory()) await walk(full, depth + 1);
      if (hits.length >= 25) return;
    }
  };
  for (const root of roots) await walk(root, 0);
  return { ok: true, message: `${hits.length} résultat(s)`, data: hits };
}

export async function captureScreen(maxWidth = 1600): Promise<string> {
  const display = screen.getPrimaryDisplay();
  const scale = Math.min(1, maxWidth / display.size.width);
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: Math.round(display.size.width * scale), height: Math.round(display.size.height * scale) }
  });
  const primary = sources.find((s) => s.display_id === String(display.id)) ?? sources[0];
  if (!primary) throw new Error('Aucun écran capturable');
  return primary.thumbnail.toJPEG(82).toString('base64').replace(/^/, 'data:image/jpeg;base64,');
}

export async function runSystemAction(action: SystemAction): Promise<SystemActionResult> {
  switch (action.type) {
    case 'lock':
      return lockSession();
    case 'open-app':
      return openApp(String(action.name ?? ''));
    case 'open-url': {
      const url = String(action.url ?? '');
      if (!/^https?:\/\//i.test(url) || url.length > 2048) return { ok: false, message: 'URL refusée' };
      await shell.openExternal(url);
      return { ok: true, message: 'Ouvert dans le navigateur' };
    }
    case 'media':
      return mediaKey(String(action.key));
    case 'clipboard-read':
      return { ok: true, data: (await clipboard.readText()).slice(0, 20_000) };
    case 'clipboard-write':
      await clipboard.writeText(String(action.text ?? '').slice(0, 100_000));
      return { ok: true, message: 'Copié dans le presse-papiers' };
    case 'find-files':
      return findFiles(String(action.query ?? ''));
    default:
      return { ok: false, message: 'Action inconnue' };
  }
}

export function registerSystemIpc(): void {
  ipcMain.handle(IPC.screenCapture, (_e, maxWidth?: number) => captureScreen(Number(maxWidth) || 1600));
  ipcMain.handle(IPC.systemAction, async (_e, action: SystemAction) => {
    if (!action || typeof action.type !== 'string') throw new Error('Action invalide');
    log('INFO', 'system', `action ${action.type}`);
    const result = await runSystemAction(action);
    if (!result.ok) log('WARN', 'system', `action ${action.type} failed: ${result.message}`);
    return result;
  });
  void app;
}
