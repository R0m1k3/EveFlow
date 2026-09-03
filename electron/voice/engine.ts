/**
 * Host side of the voice worker: spawns the utility process on demand, correlates
 * requests and responses, restarts the worker if it crashes.
 */
import { utilityProcess, type UtilityProcess } from 'electron';
import path from 'node:path';
import type { SynthesizeRequest, SynthesizeResult, TranscribeRequest, TranscribeResult, VoiceEngineStatus } from '../../shared/voice';
import { findModel } from './catalog';
import { isInstalled, modelDir, modelsDir } from './models';
import { log } from '../logger';

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

let child: UtilityProcess | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();

function rejectAll(message: string): void {
  for (const [id, p] of pending) {
    clearTimeout(p.timer);
    p.reject(new Error(message));
    pending.delete(id);
  }
}

function spawn(): UtilityProcess {
  if (child) return child;
  const script = path.join(__dirname, 'voice-worker.js');
  const proc = utilityProcess.fork(script, [], { serviceName: 'eveflow-voice', stdio: 'pipe' });
  child = proc;
  proc.stdout?.on('data', (d: Buffer) => log('DEBUG', 'voice-worker', d.toString().trim()));
  proc.stderr?.on('data', (d: Buffer) => log('WARN', 'voice-worker', d.toString().trim()));
  proc.on('message', (msg: { id: number; ok: boolean; result?: unknown; error?: string }) => {
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(msg.error ?? 'erreur moteur vocal'));
  });
  proc.on('exit', (code) => {
    log(code === 0 ? 'INFO' : 'ERROR', 'voice-worker', `exited with code ${code}`);
    // A newer worker may already have replaced this one; only clean up if we are still current.
    if (child !== proc) return;
    child = null;
    rejectAll('Le moteur vocal local s’est arrêté de façon inattendue.');
  });
  log('INFO', 'voice', 'voice worker started');
  return proc;
}

function request<T>(message: Record<string, unknown>, timeoutMs = 120_000): Promise<T> {
  const proc = spawn();
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('Délai dépassé pour le moteur vocal local.'));
      // The worker handles requests synchronously: a stuck request wedges everything behind it.
      if (child === proc) {
        log('WARN', 'voice', 'worker unresponsive, restarting');
        stopEngine();
      }
    }, timeoutMs);
    pending.set(id, { resolve: (v) => resolve(v as T), reject, timer });
    try {
      proc.postMessage({ id, ...message });
    } catch (err) {
      pending.delete(id);
      clearTimeout(timer);
      reject(err as Error);
    }
  });
}

function modelRef(modelId: string) {
  const spec = findModel(modelId);
  if (!spec) throw new Error(`Modèle inconnu : ${modelId}`);
  if (!isInstalled(spec)) throw new Error(`Modèle « ${spec.name} » non installé. Téléchargez-le dans Paramètres → Modèles.`);
  return { id: spec.id, engine: spec.engine, dir: modelDir(spec), files: spec.files };
}

export async function engineStatus(): Promise<VoiceEngineStatus> {
  try {
    const status = await request<Omit<VoiceEngineStatus, 'modelsDir'>>({ type: 'status' }, 20_000);
    return { ...status, modelsDir: modelsDir() };
  } catch (err) {
    return { available: false, error: (err as Error).message, loaded: [], modelsDir: modelsDir() };
  }
}

export function transcribe(req: TranscribeRequest): Promise<TranscribeResult> {
  // Binary payloads are base64-encoded for the worker: the utility process channel rejects external buffers.
  const wav = Buffer.from(req.wav.buffer, req.wav.byteOffset, req.wav.byteLength).toString('base64');
  return request<TranscribeResult>({ type: 'transcribe', model: modelRef(req.modelId), wav, language: req.language }, 180_000);
}

export async function synthesize(req: SynthesizeRequest): Promise<SynthesizeResult> {
  const result = await request<Omit<SynthesizeResult, 'wav'> & { wav: string }>(
    { type: 'synthesize', model: modelRef(req.modelId), text: req.text, speaker: req.speaker, speed: req.speed },
    180_000
  );
  const buffer = Buffer.from(result.wav, 'base64');
  return { ...result, wav: new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength) };
}

/** Native model memory is only released deterministically by restarting the worker. */
export function unload(_modelId?: string): Promise<unknown> {
  stopEngine();
  return Promise.resolve({ ok: true });
}

export function stopEngine(): void {
  const proc = child;
  child = null;
  if (proc) {
    rejectAll('Moteur vocal redémarré.');
    proc.kill();
  }
}
