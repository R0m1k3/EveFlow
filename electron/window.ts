import { app, BrowserWindow, screen, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { IPC, type WindowMode } from '../shared/ipc';
import { log } from './logger';

const HUD_SIZE = { width: 1320, height: 860, minWidth: 980, minHeight: 640 };
const COMPACT_SIZE = { width: 380, height: 620, minWidth: 320, minHeight: 420 };

let mainWindow: BrowserWindow | null = null;
let currentMode: WindowMode = 'hud';
let hudBounds: Electron.Rectangle | null = null;

export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

export function getWindowMode(): WindowMode {
  return currentMode;
}

function fallbackHtml(reason: string): string {
  return `<!doctype html><html><body style="margin:0;font-family:Segoe UI,Arial,sans-serif;background:#03070d;color:#9fe9ff;display:flex;align-items:center;justify-content:center;height:100vh">
  <div style="max-width:560px;padding:28px;border:1px solid #1d5c70;border-radius:14px;background:#061018">
  <h1 style="margin:0 0 12px;font-size:20px;letter-spacing:.08em">EVEFLOW - INTERFACE INDISPONIBLE</h1>
  <p style="line-height:1.5">${reason}</p><p>Lancez <code>npm run build</code> puis relancez l'application.</p></div></body></html>`;
}

async function loadRenderer(win: BrowserWindow): Promise<void> {
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl && !app.isPackaged) {
    try {
      await win.loadURL(devUrl);
      win.webContents.openDevTools({ mode: 'detach' });
      return;
    } catch (err) {
      log('WARN', 'window', `dev server unreachable (${(err as Error).message}), loading built bundle`);
    }
  }
  const builtIndex = path.join(__dirname, '..', '..', 'dist', 'index.html');
  if (fs.existsSync(builtIndex)) {
    await win.loadFile(builtIndex);
    return;
  }
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(fallbackHtml('Le bundle dist/index.html est introuvable.')));
}

export function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    ...HUD_SIZE,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: true,
    show: false,
    title: 'EveFlow',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      backgroundThrottling: false,
      spellcheck: false
    }
  });
  mainWindow = win;

  win.once('ready-to-show', () => {
    setTimeout(() => {
      if (!win.isDestroyed()) win.show();
    }, 60);
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://') && !url.startsWith(process.env.VITE_DEV_SERVER_URL ?? 'http://127.0.0.1:5173')) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });

  win.on('closed', () => {
    mainWindow = null;
  });

  loadRenderer(win).catch((err) => {
    log('ERROR', 'window', `renderer load failed: ${(err as Error).message}`);
    void win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(fallbackHtml("Une erreur inattendue a interrompu le chargement de l'interface.")));
  });

  return win;
}

export function setWindowMode(mode: WindowMode): void {
  const win = mainWindow;
  if (!win || win.isDestroyed()) return;
  if (mode === currentMode) {
    win.webContents.send(IPC.windowModeChanged, mode);
    return;
  }

  if (mode === 'compact') {
    hudBounds = win.getBounds();
    const display = screen.getDisplayMatching(win.getBounds());
    const area = display.workArea;
    win.setMinimumSize(COMPACT_SIZE.minWidth, COMPACT_SIZE.minHeight);
    win.setBounds({
      x: area.x + area.width - COMPACT_SIZE.width - 24,
      y: area.y + area.height - COMPACT_SIZE.height - 24,
      width: COMPACT_SIZE.width,
      height: COMPACT_SIZE.height
    }, true);
    win.setAlwaysOnTop(true, 'floating');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  } else {
    win.setAlwaysOnTop(false);
    win.setVisibleOnAllWorkspaces(false);
    win.setMinimumSize(HUD_SIZE.minWidth, HUD_SIZE.minHeight);
    if (hudBounds) win.setBounds(hudBounds, true);
    else {
      win.setSize(HUD_SIZE.width, HUD_SIZE.height, true);
      win.center();
    }
  }
  currentMode = mode;
  win.webContents.send(IPC.windowModeChanged, mode);
}

export function toggleWindowVisibility(): void {
  const win = mainWindow;
  if (!win || win.isDestroyed()) return;
  if (win.isVisible() && win.isFocused()) {
    win.hide();
  } else {
    win.show();
    win.focus();
  }
}
