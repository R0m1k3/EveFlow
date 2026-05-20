const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

let mainWindow;

// ── Logging Setup ───────────────────────────────────────────────────────────
function getLogPath() {
  const userDataDir = app.getPath('userData');
  return path.join(userDataDir, 'eveflow.log');
}

function writeLogEntry(entry) {
  try {
    const logPath = getLogPath();
    const line = `[${entry.ts}] [${entry.level}] [${entry.tag}] ${entry.message}` +
      (entry.data !== undefined ? ' | ' + JSON.stringify(entry.data) : '') + '\n';

    // Rotation simple : si le fichier dépasse 5 Mo, on le renomme et on repart
    try {
      const stat = fs.statSync(logPath);
      if (stat.size > 5 * 1024 * 1024) {
        fs.renameSync(logPath, logPath + '.old');
      }
    } catch { /* fichier inexistant — normal au premier démarrage */ }

    fs.appendFileSync(logPath, line, 'utf8');
  } catch (err) {
    console.error('[main] Impossible d\'écrire dans le log:', err.message);
  }
}



// ── Webhook Server (Hermes → EveFlow push events) ──────────────────────────
const http = require('http');
const WEBHOOK_PORT = 7842;
let webhookServer = null;

// Normalize any Hermes push payload into an array of { type, role, text, source } events.
// Handles multiple formats so EveFlow mirrors both sides of Telegram conversations.
function normalizeHermesEvents(raw) {
  const src = raw.platform || raw.source || 'webhook';

  // Format A — { type:'message', payload:{ text, role?, platform? } }
  if (raw.type === 'message' && raw.payload?.text) {
    return [{
      type: 'message',
      role: raw.payload.role || 'assistant',
      text: raw.payload.text,
      source: raw.payload.platform || src
    }];
  }

  // Format B — run completed: { event:'run.completed', input?, output, platform? }
  if ((raw.event === 'run.completed' || raw.type === 'run.completed') && raw.output) {
    const events = [];
    if (raw.input) events.push({ type: 'message', role: 'user', text: raw.input, source: src });
    events.push({ type: 'message', role: 'assistant', text: raw.output, source: src });
    return events;
  }

  // Format C — direct: { role, text, source? }
  if (raw.role && raw.text) {
    return [{ type: 'message', role: raw.role, text: raw.text, source: src }];
  }

  // Format D — legacy: { type:'user_message'|'assistant_message', text }
  if (raw.text && raw.type) {
    const role = raw.type.includes('user') ? 'user' : 'assistant';
    return [{ type: 'message', role, text: raw.text, source: src }];
  }

  // Passthrough — let renderer decide
  return [raw];
}

function startWebhookServer() {
  webhookServer = http.createServer((req, res) => {
    // Only accept POST /eveflow/hook
    if (req.method !== 'POST' || req.url !== '/eveflow/hook') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not Found' }));
      return;
    }

    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const raw = JSON.parse(body);
        const events = normalizeHermesEvents(raw);

        console.log(`[EveFlow Webhook] ${events.length} event(s) from ${events[0]?.source || '?'}`);
        writeLogEntry({
          ts: new Date().toISOString(),
          level: 'INFO',
          tag: 'Webhook',
          message: `${events.length} event(s) received`,
          data: events
        });

        // Forward each normalized event to the renderer
        if (mainWindow && !mainWindow.isDestroyed()) {
          for (const event of events) {
            mainWindow.webContents.send('hermes-push', event);
          }
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, events: events.length }));
      } catch (err) {
        console.error('[EveFlow Webhook] Parse error:', err.message);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
  });

  webhookServer.listen(WEBHOOK_PORT, '0.0.0.0', () => {
    console.log(`[EveFlow] Webhook server listening on http://0.0.0.0:${WEBHOOK_PORT}/eveflow/hook`);
  });

  webhookServer.on('error', (err) => {
    console.error(`[EveFlow] Webhook server error: ${err.message}`);
  });
}

function stopWebhookServer() {
  if (webhookServer) {
    webhookServer.close();
    webhookServer = null;
  }
}

function loadFallbackPage(reason) {
  const html = `
    <html>
      <body style="margin:0;font-family:Arial,sans-serif;background:#f4f8fc;color:#0f172a;display:flex;align-items:center;justify-content:center;height:100vh;">
        <div style="max-width:560px;padding:28px;border:2px solid #0f172a;background:white;border-radius:18px;">
          <h1 style="margin:0 0 12px;font-size:22px;">EveFlow n'a pas pu charger l'interface</h1>
          <p style="line-height:1.5;">${reason}</p>
          <p style="line-height:1.5;">Lance <code>npm run build</code>, puis relance l'application.</p>
        </div>
      </body>
    </html>
  `;

  return mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
}

function loadBuiltApp() {
  const builtIndex = path.join(__dirname, 'dist', 'index.html');
  if (fs.existsSync(builtIndex)) {
    return mainWindow.loadFile(builtIndex);
  }

  return loadFallbackPage("Le serveur Vite est indisponible et le dossier dist/index.html n'existe pas.");
}

async function loadApp() {
  const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;

  if (!isDev) {
    await loadBuiltApp();
    return;
  }

  const devServerUrl = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173';
  try {
    await mainWindow.loadURL(devServerUrl);
  } catch (error) {
    console.error(`Impossible de charger ${devServerUrl}; bascule sur le build local.`, error);
    await loadBuiltApp();
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    minWidth: 400,
    minHeight: 500,
    frame: false, // Supprime la barre de titre classique pour un style rétro-futuriste personnalisé
    transparent: true, // Permet la transparence (fond de fenêtre transparent)
    backgroundColor: '#00000000', // Fond transparent
    hasShadow: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,      // Sécurité Zero Trust active
      nodeIntegration: false,
      webSecurity: false,          // Permet les requêtes HTTP vers API locales/LAN
      allowRunningInsecureContent: true, // Autorise HTTP depuis le renderer (API locales)
    },
  });

  loadApp().catch((error) => {
    console.error("Echec du chargement de l'application.", error);
    loadFallbackPage("Une erreur inattendue a interrompu le chargement de l'interface.");
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  startWebhookServer();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  stopWebhookServer();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// IPC Handler pour le contrôle de la fenêtre (Header personnalisé)
ipcMain.on('window-control', (event, action) => {
  if (!mainWindow) return;
  switch (action) {
    case 'minimize':
      mainWindow.minimize();
      break;
    case 'maximize':
      if (mainWindow.isMaximized()) {
        mainWindow.unmaximize();
      } else {
        mainWindow.maximize();
      }
      break;
    case 'close':
      mainWindow.close();
      break;
  }
});

// IPC Handler pour basculer en mode flottant compact transparent (Eve Widget)
ipcMain.on('set-window-mode', (event, mode) => {
  if (!mainWindow) return;
  if (mode === 'floating') {
    // Mode flottant compact : 320x450
    mainWindow.setResizable(true);
    mainWindow.setMinimumSize(250, 350);
    mainWindow.setSize(300, 400);
    mainWindow.setAlwaysOnTop(true, 'screen-saver');
    
    // Positionner dans le coin inférieur droit de l'écran principal
    const { screen } = require('electron');
    const primaryDisplay = screen.getPrimaryDisplay();
    const { width, height } = primaryDisplay.workAreaSize;
    mainWindow.setPosition(width - 320, height - 420);
    
    event.reply('window-mode-changed', 'floating');
  } else {
    // Mode normal : chat complet
    mainWindow.setAlwaysOnTop(false);
    mainWindow.setMinimumSize(400, 500);
    mainWindow.setSize(1000, 700);
    mainWindow.center();
    
    event.reply('window-mode-changed', 'normal');
  }
});

// ── IPC Handler : écriture des logs du renderer vers disque ─────────────────
ipcMain.on('write-log', (event, entry) => {
  writeLogEntry(entry);
});

// ── IPC Handler : store persistant (indépendant de l'origine HTTP/file://) ──
// Lit/écrit C:\Users\...\AppData\Roaming\eveflow\userdata.json
function getStorePath() {
  return path.join(app.getPath('userData'), 'userdata.json');
}

function readStoreFile() {
  try {
    const raw = fs.readFileSync(getStorePath(), 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function writeStoreFile(data) {
  try {
    fs.writeFileSync(getStorePath(), JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error('[EveFlow] Impossible d\'écrire userdata.json:', err.message);
  }
}

ipcMain.handle('store-get', (_event, key) => {
  const store = readStoreFile();
  return store[key] ?? null;
});

ipcMain.handle('store-set', (_event, key, value) => {
  const store = readStoreFile();
  store[key] = value;
  writeStoreFile(store);
  return true;
});

// Handler de lecture de fichiers locaux sécurisé (Zéro Trust)
// Retourne une Data URL (base64) pour contourner les restrictions CORS de Chromium
ipcMain.handle('read-local-file', async (_event, filePath) => {
  try {
    if (!filePath || typeof filePath !== 'string') {
      throw new Error("Chemin invalide");
    }

    // Normalisation du chemin
    const normalizedPath = path.normalize(filePath);

    // Prévention des attaques par traversée de répertoires
    if (normalizedPath.includes('..')) {
      throw new Error("Accès interdit (tentative de traversée de répertoires)");
    }

    // Validation des extensions de fichiers (Zéro Trust)
    const ext = path.extname(normalizedPath).toLowerCase();
    const allowedExtensions = [
      '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp',
      '.txt', '.csv', '.json', '.md', '.log', '.xml'
    ];

    if (!allowedExtensions.includes(ext)) {
      throw new Error(`Type de fichier non autorisé : ${ext}`);
    }

    // Vérifier l'existence du fichier
    if (!fs.existsSync(normalizedPath)) {
      throw new Error("Fichier introuvable");
    }

    // Mappage des types MIME
    let mimeType = 'application/octet-stream';
    if (ext === '.png') mimeType = 'image/png';
    else if (ext === '.jpg' || ext === '.jpeg') mimeType = 'image/jpeg';
    else if (ext === '.gif') mimeType = 'image/gif';
    else if (ext === '.webp') mimeType = 'image/webp';
    else if (ext === '.svg') mimeType = 'image/svg+xml';
    else if (ext === '.txt' || ext === '.log') mimeType = 'text/plain';
    else if (ext === '.csv') mimeType = 'text/csv';
    else if (ext === '.json') mimeType = 'application/json';
    else if (ext === '.md') mimeType = 'text/markdown';

    // Lecture du fichier sur le disque
    const content = fs.readFileSync(normalizedPath);
    const base64 = content.toString('base64');
    
    return `data:${mimeType};base64,${base64}`;

  } catch (err) {
    console.error(`[main] Erreur de lecture de fichier local (${filePath}) :`, err.message);
    writeLogEntry({
      ts: new Date().toISOString(),
      level: 'ERROR',
      tag: 'IPC-File',
      message: `Échec de lecture du fichier: ${filePath} - ${err.message}`
    });
    throw err;
  }
});

// ── CPU Telemetry Helper ───────────────────────────────────────────────────
function getCpuLoad() {
  const cpus = os.cpus();
  if (!cpus || cpus.length === 0) return { idle: 0, total: 0 };
  
  let user = 0, nice = 0, sys = 0, idle = 0, irq = 0;
  for (const cpu of cpus) {
    user += cpu.times.user;
    nice += cpu.times.nice;
    sys += cpu.times.sys;
    idle += cpu.times.idle;
    irq += cpu.times.irq;
  }
  const total = user + nice + sys + idle + irq;
  return { idle, total };
}

let lastCpuStats = getCpuLoad();

function getRealCpuPercentage() {
  const current = getCpuLoad();
  const idleDiff = current.idle - lastCpuStats.idle;
  const totalDiff = current.total - lastCpuStats.total;
  lastCpuStats = current;
  if (totalDiff === 0) return 0;
  return Math.max(0, Math.min(100, 100 * (1 - idleDiff / totalDiff)));
}

ipcMain.handle('get-system-metrics', async () => {
  try {
    const hostname = os.hostname().toUpperCase();
    const cpus = os.cpus();
    const baseFreq = (cpus && cpus.length > 0) ? cpus[0].speed : 2400; // fallback to 2.4 GHz
    
    // Measure actual CPU percentage since last check
    const cpuLoad = getRealCpuPercentage();
    
    // 1. Dynamic frequency: baseline frequency with small jitter + load boost
    const jitter = (Math.random() - 0.5) * 12; // dynamic fluctuation
    const dynamicFreq = Math.round(baseFreq * (1.0 + (cpuLoad / 100) * 0.15) + jitter);
    
    // 2. Dynamic temperature matching load: baseline of 35.8°C + load increase + thermal noise
    const thermalNoise = (Math.random() - 0.5) * 0.6;
    const cpuTemp = parseFloat((35.8 + (cpuLoad * 0.38) + thermalNoise).toFixed(1));
    
    return {
      hostname,
      cpuFreq: dynamicFreq,
      cpuTemp
    };
  } catch (err) {
    console.error('[main] Erreur lors de la télémétrie:', err.message);
    return {
      hostname: 'UNKNOWN_HOST',
      cpuFreq: 2400,
      cpuTemp: 37.0
    };
  }
});

// ── Shared Directory Resolution ─────────────────────────────────────────────
function getSharedDirectory() {
  try {
    const docsDir = path.join(os.homedir(), 'Documents', 'EveFlow_Shared');
    if (!fs.existsSync(docsDir)) {
      fs.mkdirSync(docsDir, { recursive: true });
    }
    return docsDir;
  } catch (err) {
    console.warn('[main] Impossible de créer EveFlow_Shared dans Documents, bascule vers appData:', err.message);
    const fallbackDir = path.join(app.getPath('userData'), 'shared');
    if (!fs.existsSync(fallbackDir)) {
      fs.mkdirSync(fallbackDir, { recursive: true });
    }
    return fallbackDir;
  }
}

// ── IPC Handler : Écriture de fichier partagé sécurisé ──────────────────────
ipcMain.handle('write-shared-file', async (_event, filename, content, isBase64 = false) => {
  try {
    if (!filename || typeof filename !== 'string') {
      throw new Error("Nom de fichier invalide");
    }

    // Assainissement Zero Trust du nom de fichier
    const sanitizedFilename = path.basename(filename);
    if (sanitizedFilename.includes('..') || sanitizedFilename !== filename) {
      throw new Error("Nom de fichier non sécurisé (tentative de traversée de répertoire)");
    }

    // Validation stricte des extensions interdites (Zero Trust)
    const ext = path.extname(sanitizedFilename).toLowerCase();
    const forbiddenExtensions = [
      '.exe', '.bat', '.cmd', '.ps1', '.vbs', '.msi', '.scr', '.pif', '.reg', '.sh',
      '.com', '.hta', '.vbe', '.wsf', '.lnk'
    ];
    if (forbiddenExtensions.includes(ext)) {
      throw new Error(`Extension de fichier interdite pour des raisons de sécurité : ${ext}`);
    }

    const sharedDir = getSharedDirectory();
    const targetPath = path.join(sharedDir, sanitizedFilename);

    if (isBase64) {
      const base64Data = content.replace(/^data:image\/\w+;base64,/, "");
      fs.writeFileSync(targetPath, Buffer.from(base64Data, 'base64'));
    } else {
      fs.writeFileSync(targetPath, content, 'utf8');
    }

    writeLogEntry({
      ts: new Date().toISOString(),
      level: 'INFO',
      tag: 'IPC-FileWrite',
      message: `Fichier partagé écrit avec succès : ${targetPath}`
    });

    // Retourner au format d'URL de fichier local exploitable par Chromium
    return `file:///${targetPath.replace(/\\/g, '/')}`;
  } catch (err) {
    console.error('[main] Erreur write-shared-file:', err.message);
    writeLogEntry({
      ts: new Date().toISOString(),
      level: 'ERROR',
      tag: 'IPC-FileWrite',
      message: `Échec d'écriture de fichier partagé (${filename}) : ${err.message}`
    });
    throw err;
  }
});

// ── IPC Handler : Ouverture sécurisée de fichier local par l'OS ─────────────
ipcMain.handle('open-local-file', async (_event, filePath) => {
  try {
    if (!filePath || typeof filePath !== 'string') {
      throw new Error("Chemin de fichier invalide");
    }

    const normalizedPath = path.normalize(filePath);
    if (normalizedPath.includes('..')) {
      throw new Error("Accès interdit (tentative de traversée de répertoires)");
    }

    // Validation de sécurité stricte contre l'exécution de binaires/scripts arbitraires
    const ext = path.extname(normalizedPath).toLowerCase();
    const forbiddenExtensions = [
      '.exe', '.bat', '.cmd', '.ps1', '.vbs', '.msi', '.scr', '.pif', '.reg', '.sh',
      '.com', '.hta', '.vbe', '.wsf', '.lnk', '.js', '.jar'
    ];
    if (forbiddenExtensions.includes(ext)) {
      throw new Error(`Ouverture refusée pour des raisons de sécurité : l'exécution directe de scripts ou exécutables (${ext}) est désactivée.`);
    }

    if (!fs.existsSync(normalizedPath)) {
      throw new Error("Le fichier spécifié n'existe pas sur le disque.");
    }

    const { shell } = require('electron');
    await shell.openPath(normalizedPath);

    writeLogEntry({
      ts: new Date().toISOString(),
      level: 'INFO',
      tag: 'IPC-FileOpen',
      message: `Fichier ouvert avec succès via l'OS : ${normalizedPath}`
    });

    return { success: true };
  } catch (err) {
    console.error('[main] Erreur open-local-file:', err.message);
    writeLogEntry({
      ts: new Date().toISOString(),
      level: 'ERROR',
      tag: 'IPC-FileOpen',
      message: `Échec d'ouverture de fichier (${filePath}) : ${err.message}`
    });
    throw err;
  }
});

// Afficher le chemin du log au démarrage pour faciliter le débogage
app.whenReady().then(() => {
  console.log(`[EveFlow] Log file: ${getLogPath()}`);
});
