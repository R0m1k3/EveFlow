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

const FORBIDDEN_EXT = new Set([
  '.exe', '.bat', '.cmd', '.ps1', '.vbs', '.msi', '.scr', '.pif', '.reg', '.sh',
  '.com', '.hta', '.vbe', '.wsf', '.lnk', '.jar', '.dll', '.js', '.jse'
]);

export function getSharedDirectory(): string {
  const candidates = [
    path.join(os.homedir(), 'Documents', 'EveFlow_Shared'),
    path.join(app.getPath('userData'), 'shared')
  ];
  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    } catch {
      /* try next candidate */
    }
  }
  return app.getPath('temp');
}

function normalizeSafe(filePath: string): string {
  if (!filePath || typeof filePath !== 'string') throw new Error('Chemin invalide');
  const normalized = path.normalize(filePath);
  if (normalized.split(/[\\/]/).includes('..')) throw new Error('Traversee de repertoire refusee');
  return normalized;
}

function isInsideAllowedRoots(target: string): boolean {
  const roots = [getSharedDirectory(), os.homedir(), app.getPath('temp')];
  const resolved = path.resolve(target);
  return roots.some((root) => resolved.startsWith(path.resolve(root)));
}

function stripFileScheme(value: string): string {
  let out = value.replace(/^file:\/\//, '');
  // file:///C:/x -> /C:/x on Windows-style paths
  if (/^\/[a-zA-Z]:/.test(out)) out = out.slice(1);
  return decodeURIComponent(out);
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
    const safeName = path.basename(filename);
    if (safeName !== filename || safeName.startsWith('.') || /[<>:"|?*]/.test(safeName)) {
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
    const ext = path.extname(target).toLowerCase();
    if (FORBIDDEN_EXT.has(ext)) throw new Error(`Ouverture refusee pour ${ext}`);
    if (!fs.existsSync(target)) throw new Error('Fichier introuvable');
    const result = await shell.openPath(target);
    if (result) throw new Error(result);
    return true;
  });

  ipcMain.handle(IPC.showInFolder, async (_e, filePath: string) => {
    const target = normalizeSafe(stripFileScheme(filePath));
    shell.showItemInFolder(target);
    return true;
  });
}
