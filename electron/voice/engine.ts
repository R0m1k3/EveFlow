/**
 * Host side of the voice worker: spawns the utility process on demand, correlates
 * requests and responses, restarts the worker if it crashes.
 */
import { utilityProcess, type UtilityProcess, type WebContents } from 'electron';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { VOICE_IPC, type KwsDetection, type KwsStartRequest, type SynthesizeRequest, type SynthesizeResult, type TranscribeRequest, type TranscribeResult, type VadEvent, type VadStartRequest, type VoiceEngineStatus } from '../../shared/voice';
import { buildKeywordsFile, parseTokens } from '../../shared/keywords';
import { findModel } from './catalog';
import { isInstalled, modelDir, modelsDir } from './models';
import { log } from '../logger';

/** Renderer that receives keyword detections while spotting is active. */
let kwsSubscriber: WebContents | null = null;
let kwsActive = false;
let kwsRequest: KwsStartRequest | null = null;
let vadSubscriber: WebContents | null = null;
let vadActive = false;

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
  proc.on('message', (msg: { id?: number; type?: string; ok?: boolean; result?: unknown; error?: string; keyword?: string; at?: number; event?: { type: string; wav?: string; durationSec?: number } }) => {
    if (msg.type === 'vad.event' && msg.event) {
      if (vadSubscriber && !vadSubscriber.isDestroyed()) {
        const ev = msg.event;
        const payload: VadEvent =
          ev.type === 'segment' && ev.wav
            ? { type: 'segment', wav: new Uint8Array(Buffer.from(ev.wav, 'base64')), durationSec: ev.durationSec ?? 0 }
            : ev.type === 'speech-start'
              ? { type: 'speech-start' }
              : { type: 'error', message: 'événement VAD inconnu' };
        vadSubscriber.send(VOICE_IPC.vadEvent, payload);
      }
      return;
    }
    if (msg.type === 'kws.detected') {
      if (kwsSubscriber && !kwsSubscriber.isDestroyed()) {
        kwsSubscriber.send(VOICE_IPC.kwsDetected, { keyword: msg.keyword ?? '', at: msg.at ?? Date.now() } satisfies KwsDetection);
      }
      log('INFO', 'voice', `wake word detected: ${msg.keyword}`);
      return;
    }
    if (typeof msg.id !== 'number') return;
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
    // Keyword spotting survives a worker restart: re-arm on the next audio frame.
    if (kwsActive) kwsArmed = false;
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

let kwsArmed = false;
const SENSITIVITY_THRESHOLD: Record<number, number> = { 1: 0.45, 2: 0.35, 3: 0.25, 4: 0.18, 5: 0.12 };
const SENSITIVITY_SCORE: Record<number, number> = { 1: 1.0, 2: 1.0, 3: 1.2, 4: 1.5, 5: 2.0 };

/** Start keyword spotting; the keywords file is derived from the phrases and the model vocabulary. */
export async function kwsStart(req: KwsStartRequest, sender: WebContents): Promise<{ accepted: string[]; rejected: string[] }> {
  const spec = findModel(req.modelId);
  if (!spec || spec.kind !== 'kws') throw new Error('Modèle de détection introuvable');
  if (!isInstalled(spec)) throw new Error('Détecteur de mot-clé non installé (Paramètres → Modèles locaux).');
  const dir = modelDir(spec);
  const vocab = parseTokens(fs.readFileSync(path.join(dir, 'tokens.txt'), 'utf8'));
  const phrases = req.keywords.map((k) => String(k).slice(0, 40)).filter(Boolean).slice(0, 8);
  const file = buildKeywordsFile(phrases, vocab);
  if (file.accepted.length === 0) throw new Error(`Aucun mot d’activation encodable : ${file.rejected.join(', ')}`);
  const hash = createHash('sha1').update(file.content).digest('hex').slice(0, 10);
  const keywordsFile = path.join(modelsDir(), `keywords-${hash}.txt`);
  fs.writeFileSync(keywordsFile, file.content, 'utf8');
  const sensitivity = Math.min(5, Math.max(1, Math.round(req.sensitivity))) as 1 | 2 | 3 | 4 | 5;
  kwsSubscriber = sender;
  kwsRequest = req;
  await request({ type: 'kws.start', model: { id: spec.id, engine: spec.engine, dir, files: spec.files }, keywordsFile, threshold: SENSITIVITY_THRESHOLD[sensitivity], score: SENSITIVITY_SCORE[sensitivity] }, 60_000);
  kwsActive = true;
  kwsArmed = true;
  log('INFO', 'voice', `keyword spotting on: ${file.accepted.join(', ')} (threshold ${SENSITIVITY_THRESHOLD[sensitivity]})`);
  return { accepted: file.accepted, rejected: file.rejected };
}

export async function kwsStop(): Promise<void> {
  kwsActive = false;
  kwsArmed = false;
  kwsSubscriber = null;
  if (child) await request({ type: 'kws.stop' }, 10_000).catch(() => undefined);
}

/** Feed 16-bit PCM from the renderer (fire-and-forget). */
export function kwsFeed(pcm: Uint8Array, sampleRate: number): void {
  if (!kwsActive) return;
  const proc = spawn();
  if (!kwsArmed) {
    // Worker restarted: re-create the spotter before feeding audio.
    if (kwsRequest && kwsSubscriber) {
      kwsArmed = true;
      kwsStart(kwsRequest, kwsSubscriber).catch((err) => log('WARN', 'voice', `kws re-arm failed: ${(err as Error).message}`));
    }
    return;
  }
  const b64 = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64');
  try {
    proc.postMessage({ id: -1, type: 'kws.audio', pcm: b64, sampleRate });
  } catch (err) {
    log('WARN', 'voice', `kws feed failed: ${(err as Error).message}`);
  }
}

/** Neural end-of-speech detection (Silero) on frames streamed by the renderer. */
export async function vadStart(req: VadStartRequest, sender: WebContents): Promise<void> {
  const spec = findModel(req.modelId);
  if (!spec || spec.kind !== 'vad') throw new Error('Modèle VAD introuvable');
  if (!isInstalled(spec)) throw new Error('Silero VAD non installé (Paramètres → Modèles locaux).');
  vadSubscriber = sender;
  await request(
    { type: 'vad.start', model: { id: spec.id, engine: spec.engine, dir: modelDir(spec), files: spec.files }, silenceMs: req.silenceMs, threshold: req.threshold, maxUtteranceSec: req.maxUtteranceSec },
    30_000
  );
  vadActive = true;
}

export async function vadStop(): Promise<void> {
  vadActive = false;
  vadSubscriber = null;
  if (child) await request({ type: 'vad.stop' }, 10_000).catch(() => undefined);
}

export function vadFeed(pcm: Uint8Array, sampleRate: number): void {
  if (!vadActive || !child) return;
  const b64 = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64');
  try {
    child.postMessage({ id: -1, type: 'vad.audio', pcm: b64, sampleRate });
  } catch (err) {
    log('WARN', 'voice', `vad feed failed: ${(err as Error).message}`);
  }
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
