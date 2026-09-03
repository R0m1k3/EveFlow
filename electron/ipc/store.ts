import { app, ipcMain } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { IPC } from '../../shared/ipc';
import { log } from '../logger';

type StoreData = Record<string, unknown>;

let cache: StoreData | null = null;
let dirty = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let writing: Promise<void> = Promise.resolve();

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function storePath(): string {
  return path.join(app.getPath('userData'), 'userdata.json');
}

function load(): StoreData {
  if (cache) return cache;
  const target = storePath();
  try {
    cache = JSON.parse(fs.readFileSync(target, 'utf8')) as StoreData;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      // Keep a copy of an unreadable file instead of silently overwriting it.
      try {
        fs.copyFileSync(target, `${target}.corrupt-${Date.now()}`);
      } catch {
        /* ignore */
      }
      log('WARN', 'store', `userdata.json unreadable, starting fresh: ${(err as Error).message}`);
    }
    cache = {};
  }
  return cache;
}

/** Debounced, asynchronous, atomic write with retries (Windows AV scanners lock files briefly). */
function schedulePersist(): void {
  dirty = true;
  if (!timer) timer = setTimeout(() => void flushStore(), 250);
}

export function flushStore(): Promise<void> {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (!dirty) return writing;
  dirty = false;
  const text = JSON.stringify(cache ?? {}, null, 2);
  writing = writing
    .then(async () => {
      const target = storePath();
      const tmp = `${target}.tmp`;
      await fs.promises.writeFile(tmp, text, 'utf8');
      for (let attempt = 0; ; attempt++) {
        try {
          await fs.promises.rename(tmp, target);
          return;
        } catch (err) {
          if (attempt >= 5) throw err;
          await new Promise((r) => setTimeout(r, 100 * (attempt + 1)));
        }
      }
    })
    .catch((err) => log('ERROR', 'store', `cannot persist userdata.json: ${(err as Error).message}`));
  return writing;
}

export function storeGet<T = unknown>(key: string): T | null {
  const data = load();
  return (data[key] as T) ?? null;
}

export function storeSet(key: string, value: unknown): void {
  const data = load();
  data[key] = value;
  schedulePersist();
}

function validKey(key: unknown): key is string {
  return typeof key === 'string' && key.length > 0 && key.length <= 128 && !FORBIDDEN_KEYS.has(key);
}

export function registerStoreIpc(): void {
  ipcMain.handle(IPC.storeGet, (_e, key: unknown) => (validKey(key) ? storeGet(key) : null));
  ipcMain.handle(IPC.storeSet, (_e, key: unknown, value: unknown) => {
    if (!validKey(key)) throw new Error('Clé de stockage invalide');
    if (typeof value === 'function' || typeof value === 'symbol') throw new Error('Valeur non sérialisable');
    storeSet(key, value);
    return true;
  });
  ipcMain.handle(IPC.storeDelete, (_e, key: unknown) => {
    if (!validKey(key)) return false;
    const data = load();
    delete data[key];
    schedulePersist();
    return true;
  });
}
