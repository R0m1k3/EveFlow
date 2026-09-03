import { app, BrowserWindow, globalShortcut, ipcMain, Menu, nativeImage, session, systemPreferences, Tray } from 'electron';
import path from 'node:path';
import { IPC, type AppInfo, type HotkeyEvent, type LogEntry, type WindowMode } from '../shared/ipc';
import { getLogPath, log, writeLog } from './logger';
import { registerStoreIpc, storeGet } from './ipc/store';
import { abortAllStreams, registerHttpIpc } from './ipc/http';
import { registerTelemetryIpc } from './ipc/telemetry';
import { getSharedDirectory, registerFilesIpc } from './ipc/files';
import { createMainWindow, getMainWindow, getWindowMode, setWindowMode, toggleWindowVisibility } from './window';
import { getWebhookStatus, startWebhookServer, stopWebhookServer } from './webhook';

// Audio playback must never be blocked behind a user gesture (TTS starts on incoming events).
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let tray: Tray | null = null;

// -- Single instance --------------------------------------------------------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = getMainWindow();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });
}

interface WebhookSettings {
  enabled?: boolean;
  port?: number;
  secret?: string;
}

function readWebhookSettings(): WebhookSettings {
  const saved = storeGet<WebhookSettings>('webhook');
  return { enabled: true, port: 7842, secret: '', ...(saved ?? {}) };
}

async function bootWebhook(): Promise<void> {
  const settings = readWebhookSettings();
  if (settings.enabled === false) {
    await stopWebhookServer();
    return;
  }
  await startWebhookServer(getMainWindow, { port: Number(settings.port) || 7842, secret: settings.secret || undefined });
}

function sendHotkey(event: HotkeyEvent): void {
  const win = getMainWindow();
  if (win && !win.isDestroyed()) win.webContents.send(IPC.hotkey, event);
}

function registerShortcuts(): void {
  const bindings: Array<[string, () => void]> = [
    ['CommandOrControl+Shift+Space', () => {
      const win = getMainWindow();
      if (win && !win.isVisible()) win.show();
      sendHotkey('ptt-toggle');
    }],
    ['CommandOrControl+Shift+J', () => toggleWindowVisibility()],
    ['CommandOrControl+Shift+Escape', () => sendHotkey('stop-speaking')]
  ];
  for (const [accelerator, handler] of bindings) {
    try {
      if (!globalShortcut.register(accelerator, handler)) log('WARN', 'hotkey', `cannot register ${accelerator}`);
    } catch (err) {
      log('WARN', 'hotkey', `cannot register ${accelerator}: ${(err as Error).message}`);
    }
  }
}

function createTray(): void {
  try {
    const iconPath = app.isPackaged
      ? path.join(process.resourcesPath, 'icon.png')
      : path.join(__dirname, '..', '..', 'build', 'icon.png');
    let image = nativeImage.createFromPath(iconPath);
    if (image.isEmpty()) image = nativeImage.createEmpty();
    else image = image.resize({ width: 16, height: 16 });
    tray = new Tray(image);
    tray.setToolTip('EveFlow - JARVIS HUD');
    const rebuildMenu = () => {
      const mode = getWindowMode();
      tray?.setContextMenu(Menu.buildFromTemplate([
        { label: 'Afficher / masquer', click: () => toggleWindowVisibility() },
        { label: mode === 'compact' ? 'Mode HUD complet' : 'Mode compact flottant', click: () => setWindowMode(mode === 'compact' ? 'hud' : 'compact') },
        { label: 'Micro (Ctrl+Shift+Espace)', click: () => sendHotkey('ptt-toggle') },
        { type: 'separator' },
        { label: 'Quitter', click: () => app.quit() }
      ]));
    };
    rebuildMenu();
    tray.on('click', () => toggleWindowVisibility());
    ipcMain.on(IPC.windowSetMode, () => setTimeout(rebuildMenu, 0));
  } catch (err) {
    log('WARN', 'tray', `tray unavailable: ${(err as Error).message}`);
  }
}

function configureSession(): void {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media' || permission === 'notifications' || permission === 'clipboard-read');
  });
  ses.setPermissionCheckHandler((_wc, permission) => permission === 'media' || permission === 'notifications' || permission === 'clipboard-read');
  if (process.platform === 'darwin') {
    systemPreferences.askForMediaAccess('microphone').then((granted) => {
      log('INFO', 'audio', `microphone access ${granted ? 'granted' : 'denied'}`);
    }).catch(() => undefined);
  }
}

function registerCoreIpc(): void {
  ipcMain.on(IPC.windowControl, (_e, action: 'minimize' | 'maximize' | 'close' | 'hide') => {
    const win = getMainWindow();
    if (!win) return;
    switch (action) {
      case 'minimize': win.minimize(); break;
      case 'maximize': win.isMaximized() ? win.unmaximize() : win.maximize(); break;
      case 'hide': win.hide(); break;
      case 'close': win.close(); break;
    }
  });
  ipcMain.on(IPC.windowSetMode, (_e, mode: WindowMode) => setWindowMode(mode === 'compact' ? 'compact' : 'hud'));
  ipcMain.on(IPC.log, (_e, entry: LogEntry) => writeLog(entry));
  ipcMain.handle(IPC.appInfo, (): AppInfo => ({
    version: app.getVersion(),
    platform: process.platform,
    isPackaged: app.isPackaged,
    userDataPath: app.getPath('userData'),
    sharedDir: getSharedDirectory(),
    logPath: getLogPath()
  }));
  ipcMain.handle(IPC.webhookStatus, () => getWebhookStatus());
  ipcMain.handle(IPC.webhookRestart, async () => {
    await bootWebhook();
    return getWebhookStatus();
  });
}

app.whenReady().then(async () => {
  log('INFO', 'app', `EveFlow ${app.getVersion()} starting (electron ${process.versions.electron}, chrome ${process.versions.chrome})`);
  configureSession();
  registerStoreIpc();
  registerHttpIpc();
  registerTelemetryIpc();
  registerFilesIpc();
  registerCoreIpc();
  createMainWindow();
  createTray();
  registerShortcuts();
  await bootWebhook();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  abortAllStreams();
  void stopWebhookServer();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
