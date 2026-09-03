import { app, ipcMain } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { IPC } from '../../shared/ipc';

type StoreData = Record<string, unknown>;

let cache: StoreData | null = null;

function storePath(): string {
  return path.join(app.getPath('userData'), 'userdata.json');
}

function load(): StoreData {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(storePath(), 'utf8')) as StoreData;
  } catch {
    cache = {};
  }
  return cache;
}

function persist(): void {
  const target = storePath();
  const tmp = target + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cache ?? {}, null, 2), 'utf8');
  fs.renameSync(tmp, target);
}

export function storeGet<T = unknown>(key: string): T | null {
  const data = load();
  return (data[key] as T) ?? null;
}

export function storeSet(key: string, value: unknown): void {
  const data = load();
  data[key] = value;
  persist();
}

export function registerStoreIpc(): void {
  ipcMain.handle(IPC.storeGet, (_e, key: string) => storeGet(key));
  ipcMain.handle(IPC.storeSet, (_e, key: string, value: unknown) => {
    storeSet(key, value);
    return true;
  });
  ipcMain.handle(IPC.storeDelete, (_e, key: string) => {
    const data = load();
    delete data[key];
    persist();
    return true;
  });
}
