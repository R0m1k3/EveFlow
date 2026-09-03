import { app, ipcMain, shell } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IPC } from '../../shared/ipc';
import { log } from '../logger';

const READABLE_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.txt': 'text/plain',
  '.log': 'text/plain',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.xml': 'application/xml',
  '.html': 'text/html'
};

/** Documents and media the assistant may open with the default application. */
const OPENABLE_EXT = new Set([
  ...Object.keys(READABLE_EXT),
  '.pdf', '.docx', '.doc', '.xlsx', '.xls', '.pptx', '.ppt', '.odt', '.ods', '.odp', '.rtf',
  '.mp3', '.wav', '.ogg', '.flac', '.mp4', '.mkv', '.webm', '.zip', '.7z', '.py', '.ts', '.tsx', '.yaml', '.yml', '.toml', '.ini'
]);

const FORBIDDEN_EXT = new Set([
  '.exe', '.bat', '.cmd', '.ps1', '.vbs', '.msi', '.scr', '.pif', '.reg', '.sh', '.com', '.hta', '.vbe', '.wsf', '.lnk',
  '.jar', '.dll', '.js', '.jse', '.pyw', '.msc', '.cpl', '.inf', '.url', '.scf', '.website', '.appref-ms', '.application',
  '.gadget', '.psm1', '.psd1', '.ps1xml', '.wsh', '.wsc', '.sct', '.desktop', '.app', '.command', '.appimage', '.run'
]);

const WIN_RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i;

let sharedDir: string | null = null;

export function getSharedDirectory(): string {
  if (sharedDir && fs.existsSync(sharedDir)) return sharedDir;
  const candidates = [
    path.join(os.homedir(), 'Documents', 'EveFlow_Shared'),
    path.join(app.getPath('userData'), 'shared')
  ];
  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      sharedDir = dir;
      return dir;
    } catch {
      /* try next candidate */
    }
  }
  sharedDir = app.getPath('temp');
  return sharedDir;
}

function normalizeSafe(filePath: string): string {
  if (!filePath || typeof filePath !== 'string' || filePath.length > 4096) throw new Error('Chemin invalide');
  const normalized = path.normalize(filePath);
  if (normalized.split(/[\\/]/).includes('..')) throw new Error('Traversee de repertoire refusee');
  return normalized;
}

function allowedRoots(): string[] {
  return [
    getSharedDirectory(),
    path.join(os.homedir(), 'Documents'),
    path.join(os.homedir(), 'Pictures'),
    path.join(os.homedir(), 'Downloads'),
    path.join(os.homedir(), 'Desktop'),
    app.getPath('temp')
  ].map((r) => path.resolve(r));
}

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Resolves symlinks and checks the real path against the allowed roots (prefix tricks like "bob-backup" are rejected). */
function isInsideAllowedRoots(target: string): boolean {
  let resolved: string;
  try {
    resolved = fs.realpathSync.native(target);
  } catch {
    return false;
  }
  return allowedRoots().some((root) => isInside(root, resolved));
}

function stripFileScheme(value: string): string {
  if (!/^file:\/\//i.test(value)) return value;
  let out = value.replace(/^file:\/\//i, '');
  // file:///C:/x -> /C:/x on Windows-style paths
  if (/^\/[a-zA-Z]:/.test(out)) out = out.slice(1);
  try {
    return decodeURIComponent(out);
  } catch {
    return out;
  }
}

export function registerFilesIpc(): void {
  ipcMain.handle(IPC.readLocalFile, async (_e, filePath: string) => {
    const target = normalizeSafe(stripFileScheme(filePath));
    const ext = path.extname(target).toLowerCase();
    const mime = READABLE_EXT[ext];
    if (!mime) throw new Error(`Type de fichier non autorise : ${ext || '(aucune extension)'}`);
    if (!isInsideAllowedRoots(target)) throw new Error('Chemin hors des dossiers autorises');
    const stat = await fs.promises.stat(target);
    if (stat.size > 25 * 1024 * 1024) throw new Error('Fichier trop volumineux (25 Mo max)');
    const content = await fs.promises.readFile(target);
    return `data:${mime};base64,${content.toString('base64')}`;
  });

  ipcMain.handle(IPC.writeSharedFile, async (_e, filename: string, content: string, isBase64 = false) => {
    if (!filename || typeof filename !== 'string') throw new Error('Nom de fichier invalide');
    if (typeof content !== 'string' || content.length > 50 * 1024 * 1024) throw new Error('Contenu invalide');
    const safeName = path.basename(filename);
    if (
      safeName !== filename ||
      safeName.startsWith('.') ||
      /[<>:"|?*\u0000-\u001f]/.test(safeName) ||
      WIN_RESERVED.test(safeName) ||
      /[. ]$/.test(safeName) ||
      safeName.length > 200
    ) {
      throw new Error('Nom de fichier non securise');
    }
    const ext = path.extname(safeName).toLowerCase();
    if (FORBIDDEN_EXT.has(ext)) throw new Error(`Extension interdite : ${ext}`);
    const target = path.join(getSharedDirectory(), safeName);
    if (isBase64) {
      const payload = content.replace(/^data:[^;]+;base64,/, '');
      await fs.promises.writeFile(target, Buffer.from(payload, 'base64'));
    } else {
      await fs.promises.writeFile(target, content, 'utf8');
    }
    log('INFO', 'files', `shared file written: ${target}`);
    return { path: target, url: `file:///${target.replace(/\\/g, '/')}` };
  });

  ipcMain.handle(IPC.openPath, async (_e, filePath: string) => {
    const target = normalizeSafe(stripFileScheme(filePath));
    if (!fs.existsSync(target)) throw new Error('Fichier introuvable');
    const real = await fs.promises.realpath(target);
    const stat = await fs.promises.stat(real);
    const ext = path.extname(real).toLowerCase();
    if (!stat.isDirectory() && (FORBIDDEN_EXT.has(ext) || !OPENABLE_EXT.has(ext))) throw new Error(`Ouverture refusee pour ${ext || 'ce fichier'}`);
    // Outside the user's document folders we only reveal the file, never execute its handler.
    if (!isInsideAllowedRoots(real)) {
      shell.showItemInFolder(real);
      return true;
    }
    const result = await shell.openPath(real);
    if (result) throw new Error(result);
    return true;
  });

  ipcMain.handle(IPC.showInFolder, async (_e, filePath: string) => {
    const target = normalizeSafe(stripFileScheme(filePath));
    shell.showItemInFolder(target);
    return true;
  });
}
