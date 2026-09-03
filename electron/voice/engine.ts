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

function spawn(): UtilityProcess {
  if (child) return child;
  const script = path.join(__dirname, 'voice-worker.js');
  child = utilityProcess.fork(script, [], { serviceName: 'eveflow-voice', stdio: 'pipe' });
  child.stdout?.on('data', (d: Buffer) => log('DEBUG', 'voice-worker', d.toString().trim()));
  child.stderr?.on('data', (d: Buffer) => log('WARN', 'voice-worker', d.toString().trim()));
  child.on('message', (msg: { id: number; ok: boolean; result?: unknown; error?: string }) => {
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(msg.error ?? 'erreur moteur vocal'));
  });
  child.on('exit', (code) => {
    log(code === 0 ? 'INFO' : 'ERROR', 'voice-worker', `exited with code ${code}`);
    child = null;
    for (const [id, p] of pending) {
      clearTimeout(p.timer);
      p.reject(new Error('Le moteur vocal local s’est arrêté de façon inattendue.'));
      pending.delete(id);
    }
  });
  log('INFO', 'voice', 'voice worker started');
  return child;
}

function request<T>(message: Record<string, unknown>, timeoutMs = 120_000): Promise<T> {
  const proc = spawn();
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('Délai dépassé pour le moteur vocal local.'));
    }, timeoutMs);
    pending.set(id, { resolve: (v) => resolve(v as T), reject, timer });
    proc.postMessage({ id, ...message });
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
  return request<TranscribeResult>({ type: 'transcribe', model: modelRef(req.modelId), wav: req.wav, language: req.language }, 180_000);
}

export function synthesize(req: SynthesizeRequest): Promise<SynthesizeResult> {
  return request<SynthesizeResult>({ type: 'synthesize', model: modelRef(req.modelId), text: req.text, speaker: req.speaker, speed: req.speed }, 180_000);
}

export function unload(modelId?: string): Promise<unknown> {
  if (!child) return Promise.resolve({ ok: true });
  return request({ type: 'unload', modelId }, 20_000);
}

export function stopEngine(): void {
  if (child) {
    child.kill();
    child = null;
  }
}
