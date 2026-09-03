/**
 * Voice worker: runs sherpa-onnx (speech recognition and synthesis) in an Electron utility
 * process so heavy inference never blocks the main process. Also runnable with
 * `child_process.fork` (advanced serialization) for local tests.
 */
import os from 'node:os';
import path from 'node:path';
import type { VoiceEngineKind } from '../../shared/voice';

interface ModelRef {
  id: string;
  engine: VoiceEngineKind;
  dir: string;
  files: string[];
}

type Request =
  | { id: number; type: 'status' }
  | { id: number; type: 'transcribe'; model: ModelRef; wav: Uint8Array | string; language: string }
  | { id: number; type: 'synthesize'; model: ModelRef; text: string; speaker: number; speed: number }
  | { id: number; type: 'unload'; modelId?: string }
  | { id: number; type: 'kws.start'; model: ModelRef; keywordsFile: string; threshold: number; score: number }
  | { id: number; type: 'kws.audio'; pcm: string; sampleRate: number }
  | { id: number; type: 'kws.stop' };

type Response = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string };

// ── sherpa-onnx loading (lazy, so a missing native package is reported, not fatal) ──
type Sherpa = {
  OfflineRecognizer: new (config: unknown) => {
    createStream: () => { acceptWaveform: (w: { sampleRate: number; samples: Float32Array }) => void };
    decode: (s: unknown) => void;
    getResult: (s: unknown) => { text: string; lang?: string };
  };
  KeywordSpotter: new (config: unknown) => {
    createStream: () => KwsStream;
    isReady: (s: KwsStream) => boolean;
    decode: (s: KwsStream) => void;
    reset: (s: KwsStream) => void;
    getResult: (s: KwsStream) => { keyword?: string };
  };
  OfflineTts: new (config: unknown) => {
    numSpeakers: number;
    sampleRate: number;
    generate: (req: { text: string; sid: number; speed: number; enableExternalBuffer?: boolean }) => { samples: Float32Array; sampleRate: number };
  };
  version: string;
};

type KwsStream = { acceptWaveform: (w: { sampleRate: number; samples: Float32Array }) => void };
let sherpa: Sherpa | null = null;
let kws: { spotter: InstanceType<Sherpa['KeywordSpotter']>; stream: KwsStream } | null = null;
let notify: ((message: unknown) => void) | null = null;
let loadError: string | null = null;

function loadSherpa(): Sherpa {
  if (sherpa) return sherpa;
  if (loadError) throw new Error(loadError);
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    sherpa = require('sherpa-onnx-node') as Sherpa;
    return sherpa;
  } catch (err) {
    loadError = `Module natif sherpa-onnx indisponible : ${(err as Error).message}`;
    throw new Error(loadError);
  }
}

const threads = Math.max(2, Math.min(6, Math.floor(os.cpus().length / 2)));

// ── caches ────────────────────────────────────────────────────────────────
const recognizers = new Map<string, InstanceType<Sherpa['OfflineRecognizer']>>();
const synthesizers = new Map<string, InstanceType<Sherpa['OfflineTts']>>();

function whisperPrefix(model: ModelRef): string {
  const encoder = model.files.find((f) => f.includes('-encoder'));
  return encoder ? encoder.slice(0, encoder.indexOf('-encoder')) : 'base';
}

function getRecognizer(model: ModelRef, language: string) {
  const lang = language === 'auto' ? '' : language.split('-')[0].toLowerCase();
  const key = `${model.id}:${lang}`;
  const cached = recognizers.get(key);
  if (cached) return cached;
  const s = loadSherpa();
  const p = (f: string) => path.join(model.dir, f);
  let modelConfig: Record<string, unknown>;
  switch (model.engine) {
    case 'whisper': {
      const prefix = whisperPrefix(model);
      modelConfig = {
        whisper: { encoder: p(`${prefix}-encoder.int8.onnx`), decoder: p(`${prefix}-decoder.int8.onnx`), language: lang, task: 'transcribe', tailPaddings: -1 },
        tokens: p(`${prefix}-tokens.txt`)
      };
      break;
    }
    case 'sense-voice':
      modelConfig = { senseVoice: { model: p('model.int8.onnx'), language: lang || 'auto', useInverseTextNormalization: 1 }, tokens: p('tokens.txt') };
      break;
    case 'nemo-transducer':
      modelConfig = {
        transducer: { encoder: p('encoder.int8.onnx'), decoder: p('decoder.int8.onnx'), joiner: p('joiner.int8.onnx') },
        tokens: p('tokens.txt'),
        modelType: 'nemo_transducer'
      };
      break;
    default:
      throw new Error(`Moteur STT non supporté : ${model.engine}`);
  }
  for (const [k, v] of Object.entries({ numThreads: threads, provider: 'cpu', debug: 0 })) modelConfig[k] = v;
  // Whisper keeps one recognizer per language; other engines ignore the language key.
  for (const [k, r] of recognizers) if (k.startsWith(`${model.id}:`)) recognizers.delete(k) && void r;
  const recognizer = new s.OfflineRecognizer({ featConfig: { sampleRate: 16000, featureDim: 80 }, modelConfig, decodingMethod: 'greedy_search' });
  recognizers.set(key, recognizer);
  return recognizer;
}

function getSynthesizer(model: ModelRef) {
  const cached = synthesizers.get(model.id);
  if (cached) return cached;
  const s = loadSherpa();
  const p = (f: string) => path.join(model.dir, f);
  let ttsModel: Record<string, unknown>;
  switch (model.engine) {
    case 'kokoro':
      ttsModel = {
        kokoro: {
          model: p('model.onnx'),
          voices: p('voices.bin'),
          tokens: p('tokens.txt'),
          dataDir: p('espeak-ng-data'),
          lexicon: [p('lexicon-us-en.txt'), p('lexicon-zh.txt')].join(',')
        }
      };
      break;
    case 'piper': {
      const onnx = model.files.find((f) => f.endsWith('.onnx')) ?? 'model.onnx';
      ttsModel = { vits: { model: p(onnx), tokens: p('tokens.txt'), dataDir: p('espeak-ng-data') } };
      break;
    }
    default:
      throw new Error(`Moteur TTS non supporté : ${model.engine}`);
  }
  const tts = new s.OfflineTts({ model: { ...ttsModel, numThreads: threads, provider: 'cpu', debug: 0 }, maxNumSentences: 1 });
  synthesizers.set(model.id, tts);
  return tts;
}

// ── audio helpers ──────────────────────────────────────────────────────────
function decodeWav(bytes: Uint8Array): { samples: Float32Array; sampleRate: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) !== 'RIFF' || String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]) !== 'WAVE') {
    throw new Error('WAV invalide');
  }
  let offset = 12;
  let sampleRate = 16000;
  let channels = 1;
  let bits = 16;
  let format = 1; // 1 = PCM, 3 = IEEE float
  let data: { start: number; length: number } | null = null;
  while (offset + 8 <= bytes.byteLength) {
    const id = String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
    const size = view.getUint32(offset + 4, true);
    if (id === 'fmt ') {
      format = view.getUint16(offset + 8, true);
      channels = view.getUint16(offset + 10, true);
      sampleRate = view.getUint32(offset + 12, true);
      bits = view.getUint16(offset + 22, true);
    } else if (id === 'data') {
      data = { start: offset + 8, length: Math.min(size, bytes.byteLength - offset - 8) };
      break;
    }
    offset += 8 + size + (size % 2);
  }
  if (!data) throw new Error('WAV sans données');
  const bytesPerSample = bits / 8;
  const frames = Math.floor(data.length / bytesPerSample / channels);
  const samples = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) {
      const pos = data.start + (i * channels + c) * bytesPerSample;
      sum +=
        format === 3 && bits === 32
          ? view.getFloat32(pos, true)
          : bits === 16
            ? view.getInt16(pos, true) / 32768
            : bits === 24
              ? (((bytes[pos] | (bytes[pos + 1] << 8) | (bytes[pos + 2] << 16)) << 8) >> 8) / 8388608
              : bits === 32
                ? view.getInt32(pos, true) / 2147483648
                : (bytes[pos] - 128) / 128;
    }
    samples[i] = sum / channels;
  }
  return { samples, sampleRate };
}

function resampleTo16k(samples: Float32Array, rate: number): Float32Array {
  if (rate === 16000) return samples;
  const ratio = rate / 16000;
  const out = new Float32Array(Math.round(samples.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const a = samples[Math.min(idx, samples.length - 1)];
    const b = samples[Math.min(idx + 1, samples.length - 1)];
    out[i] = a + (b - a) * frac;
  }
  return out;
}

function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const str = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i));
  };
  str(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  str(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  let o = 44;
  for (let i = 0; i < samples.length; i++, o += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Uint8Array(buffer);
}

function startKws(model: ModelRef, keywordsFile: string, threshold: number, score: number): void {
  const s = loadSherpa();
  kws = null;
  const p = (f: string) => path.join(model.dir, f);
  const enc = model.files.find((f) => f.startsWith('encoder')) ?? 'encoder.int8.onnx';
  const dec = model.files.find((f) => f.startsWith('decoder')) ?? 'decoder.int8.onnx';
  const join = model.files.find((f) => f.startsWith('joiner')) ?? 'joiner.int8.onnx';
  const spotter = new s.KeywordSpotter({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: { transducer: { encoder: p(enc), decoder: p(dec), joiner: p(join) }, tokens: p('tokens.txt'), numThreads: 1, provider: 'cpu', debug: 0 },
    maxActivePaths: 4,
    numTrailingBlanks: 1,
    keywordsScore: score,
    keywordsThreshold: threshold,
    keywordsFile
  });
  kws = { spotter, stream: spotter.createStream() };
}

function feedKws(pcmBase64: string, sampleRate: number): void {
  if (!kws) return;
  const bytes = Buffer.from(pcmBase64, 'base64');
  const int16 = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
  let samples: Float32Array = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) samples[i] = int16[i] / 32768;
  if (sampleRate !== 16000) samples = resampleTo16k(samples, sampleRate);
  kws.stream.acceptWaveform({ sampleRate: 16000, samples });
  while (kws.spotter.isReady(kws.stream)) {
    kws.spotter.decode(kws.stream);
    const result = kws.spotter.getResult(kws.stream);
    if (result.keyword) {
      kws.spotter.reset(kws.stream);
      notify?.({ type: 'kws.detected', keyword: result.keyword, at: Date.now() });
    }
  }
}

// ── request handling ───────────────────────────────────────────────────────
function handle(req: Request): unknown {
  switch (req.type) {
    case 'kws.start':
      startKws(req.model, req.keywordsFile, req.threshold, req.score);
      return { ok: true };
    case 'kws.audio':
      feedKws(req.pcm, req.sampleRate);
      return { ok: true };
    case 'kws.stop':
      kws = null;
      return { ok: true };
    case 'status': {
      try {
        const s = loadSherpa();
        return { available: true, version: s.version, loaded: [...recognizers.keys(), ...synthesizers.keys(), ...(kws ? ['kws'] : [])] };
      } catch (err) {
        return { available: false, error: (err as Error).message, loaded: [] };
      }
    }
    case 'transcribe': {
      const started = Date.now();
      // Audio crosses the process boundary as base64: V8 refuses to serialize external buffers.
      const bytes = typeof req.wav === 'string' ? new Uint8Array(Buffer.from(req.wav, 'base64')) : req.wav;
      const { samples, sampleRate } = decodeWav(bytes);
      const pcm = resampleTo16k(samples, sampleRate);
      if (pcm.length < 1600) throw new Error('Audio trop court');
      const recognizer = getRecognizer(req.model, req.language);
      const stream = recognizer.createStream();
      stream.acceptWaveform({ sampleRate: 16000, samples: pcm });
      recognizer.decode(stream);
      const result = recognizer.getResult(stream);
      return { text: (result.text ?? '').trim(), language: result.lang, durationMs: Date.now() - started, audioSec: pcm.length / 16000 };
    }
    case 'synthesize': {
      const started = Date.now();
      const tts = getSynthesizer(req.model);
      const sid = Math.max(0, Math.min(tts.numSpeakers - 1, Math.floor(req.speaker)));
      // Electron forbids N-API external buffers: ask sherpa-onnx to copy the samples into a V8 buffer.
      const audio = tts.generate({ text: req.text, sid, speed: Math.max(0.5, Math.min(2, req.speed || 1)), enableExternalBuffer: false });
      const wav = encodeWav(audio.samples, audio.sampleRate);
      return {
        wav: Buffer.from(wav.buffer, wav.byteOffset, wav.byteLength).toString('base64'),
        sampleRate: audio.sampleRate,
        durationMs: Date.now() - started,
        audioSec: audio.samples.length / audio.sampleRate
      };
    }
    case 'unload': {
      if (req.modelId) {
        for (const k of [...recognizers.keys()]) if (k.startsWith(`${req.modelId}:`)) recognizers.delete(k);
        synthesizers.delete(req.modelId);
      } else {
        recognizers.clear();
        synthesizers.clear();
        kws = null;
      }
      return { ok: true };
    }
    default:
      throw new Error('requête inconnue');
  }
}

function respond(req: Request): Response {
  try {
    return { id: req.id, ok: true, result: handle(req) };
  } catch (err) {
    return { id: req.id, ok: false, error: (err as Error).message || String(err) };
  }
}

// Electron utility process transport, with a child_process fallback for tests.
const parentPort = (process as unknown as { parentPort?: { on: (ev: 'message', cb: (e: { data: Request }) => void) => void; postMessage: (m: unknown) => void } }).parentPort;
if (parentPort) {
  notify = (m) => parentPort.postMessage(m);
  parentPort.on('message', (event) => parentPort.postMessage(respond(event.data)));
} else if (process.send) {
  notify = (m) => process.send!(m);
  process.on('message', (msg: Request) => process.send!(respond(msg)));
}
