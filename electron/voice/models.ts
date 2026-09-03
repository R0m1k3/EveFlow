/**
 * Model manager: downloads sherpa-onnx model archives (tar.bz2) into userData/models,
 * extracts them, verifies required files and reports progress to the renderer.
 */
import { app, type WebContents } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import * as tar from 'tar';
import unbzip2 from 'unbzip2-stream';
import { VOICE_IPC, type VoiceDownloadProgress, type VoiceModelSpec, type VoiceModelStatus } from '../../shared/voice';
import { VOICE_CATALOG, findModel } from './catalog';
import { stopEngine } from './engine';
import { log } from '../logger';

const active = new Map<string, AbortController>();
/** Windows keeps files locked briefly (AV scans, memory-mapped models): retry removals. */
const RM = { recursive: true, force: true, maxRetries: 10, retryDelay: 200 } as const;
const DOWNLOAD_IDLE_MS = 60_000;

export function modelsDir(): string {
  const dir = path.join(app.getPath('userData'), 'models');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function modelDir(spec: VoiceModelSpec): string {
  return path.join(modelsDir(), spec.dir);
}

export function isInstalled(spec: VoiceModelSpec): boolean {
  const dir = modelDir(spec);
  return spec.files.every((f) => fs.existsSync(path.join(dir, f)));
}

function dirSize(dir: string): number {
  let total = 0;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) total += dirSize(full);
      else total += fs.statSync(full).size;
    }
  } catch {
    /* missing */
  }
  return total;
}

export function listModels(): VoiceModelStatus[] {
  return VOICE_CATALOG.map((spec) => {
    const installed = isInstalled(spec);
    return {
      ...spec,
      installed,
      downloading: active.has(spec.id),
      installedBytes: installed ? dirSize(modelDir(spec)) : 0
    };
  });
}

export async function removeModel(id: string): Promise<void> {
  const spec = findModel(id);
  if (!spec) throw new Error(`Modèle inconnu : ${id}`);
  stopEngine(); // releases memory-mapped model files before deleting them
  await fs.promises.rm(modelDir(spec), RM);
  log('INFO', 'voice', `model removed: ${id}`);
}

export function cancelDownload(id: string): void {
  active.get(id)?.abort();
}

export async function downloadModel(id: string, sender: WebContents | null): Promise<VoiceModelStatus> {
  const spec = findModel(id);
  if (!spec) throw new Error(`Modèle inconnu : ${id}`);
  if (active.has(id)) throw new Error('Téléchargement déjà en cours');
  const controller = new AbortController();
  active.set(id, controller);
  const report = (progress: Omit<VoiceDownloadProgress, 'id'>) => {
    if (sender && !sender.isDestroyed()) sender.send(VOICE_IPC.modelsProgress, { id, ...progress });
  };

  const tmpDir = path.join(modelsDir(), `.tmp-${spec.id}`);
  await fs.promises.rm(tmpDir, RM);
  await fs.promises.mkdir(tmpDir, { recursive: true });
  // Abort the transfer when no byte arrives for a while (fetch itself has no inactivity timeout).
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const touch = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller.abort(new Error('Téléchargement interrompu (aucune donnée reçue)')), DOWNLOAD_IDLE_MS);
  };

  try {
    log('INFO', 'voice', `downloading ${spec.id} from ${spec.url}`);
    const response = await fetch(spec.url, { signal: controller.signal, redirect: 'follow' });
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status} lors du téléchargement`);
    const total = Number(response.headers.get('content-length')) || Math.round(spec.sizeMb * 1024 * 1024);
    let received = 0;
    let lastReport = 0;
    touch();
    const counter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        received += chunk.length;
        touch();
        const now = Date.now();
        if (now - lastReport > 250) {
          lastReport = now;
          report({ phase: 'download', received, total, percent: Math.min(99, Math.round((received / total) * 100)) });
        }
        cb(null, chunk);
      }
    });

    const source = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream<Uint8Array>);
    if (spec.url.endsWith('.tar.bz2')) {
      report({ phase: 'download', received: 0, total, percent: 0 });
      await pipeline(source, counter, unbzip2(), tar.x({ cwd: tmpDir }), { signal: controller.signal });
    } else {
      const target = path.join(tmpDir, spec.dir, path.basename(spec.url));
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      await pipeline(source, counter, fs.createWriteStream(target), { signal: controller.signal });
    }
    report({ phase: 'extract', received: total, total, percent: 99 });

    const extracted = path.join(tmpDir, spec.dir);
    const missing = spec.files.filter((f) => !fs.existsSync(path.join(extracted, f)));
    if (missing.length) throw new Error(`Archive incomplète, fichiers manquants : ${missing.join(', ')}`);

    const finalDir = modelDir(spec);
    if (isInstalled(spec)) stopEngine();
    await fs.promises.rm(finalDir, RM);
    for (let attempt = 0; ; attempt++) {
      try {
        await fs.promises.rename(extracted, finalDir);
        break;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code ?? '';
        if (attempt >= 10 || !['EPERM', 'EBUSY', 'ENOTEMPTY', 'EACCES'].includes(code)) throw err;
        await new Promise((r) => setTimeout(r, 300));
      }
    }
    await fs.promises.rm(tmpDir, RM);
    report({ phase: 'done', received: total, total, percent: 100 });
    log('INFO', 'voice', `model installed: ${spec.id}`);
  } catch (err) {
    await fs.promises.rm(tmpDir, RM).catch(() => undefined);
    const e = (controller.signal.reason instanceof Error ? controller.signal.reason : err) as Error;
    const cancelled = (e.name === 'AbortError' || controller.signal.aborted) && !(controller.signal.reason instanceof Error);
    report({ phase: cancelled ? 'cancelled' : 'error', received: 0, total: 0, percent: 0, message: cancelled ? 'annulé' : e.message });
    log(cancelled ? 'INFO' : 'ERROR', 'voice', `download ${spec.id} ${cancelled ? 'cancelled' : 'failed: ' + e.message}`);
    if (!cancelled) throw new Error(e.message);
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    active.delete(id);
  }
  return listModels().find((m) => m.id === id)!;
}
