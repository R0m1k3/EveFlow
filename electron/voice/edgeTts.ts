/**
 * Microsoft Edge "Read aloud" neural voices (the service behind the Edge browser's read-aloud
 * feature): free, no key, very natural French voices with a real masculine/feminine choice
 * (Henri, Denise, Rémy, Vivienne…). Runs in the main process: one WebSocket per sentence,
 * MP3 back to the renderer.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { EdgeSynthesizeRequest, EdgeSynthesizeResult, EdgeVoice } from '../../shared/voice';
import {
  EDGE_CHROMIUM_VERSION,
  EDGE_VOICES_URL,
  EDGE_WSS_URL,
  edgeConfigMessage,
  edgeConnectionId,
  edgeHeaders,
  edgeSsml,
  edgeSsmlMessage,
  edgeTextFramePath,
  edgeTokenInput,
  parseEdgeBinaryFrame
} from '../../shared/edgeTts';
import { log } from '../logger';

/** Seconds to add to the local clock so the signed token matches the server's time window. */
let clockSkewSec = 0;
let voicesCache: { at: number; voices: EdgeVoice[] } | null = null;
const VOICES_TTL_MS = 6 * 60 * 60 * 1000;
const SYNTH_TIMEOUT_MS = 20_000;

function token(): string {
  return createHash('sha256').update(edgeTokenInput(Date.now(), clockSkewSec), 'ascii').digest('hex').toUpperCase();
}

function signedUrl(): string {
  return `${EDGE_WSS_URL}&ConnectionId=${edgeConnectionId(randomUUID())}&Sec-MS-GEC=${token()}&Sec-MS-GEC-Version=1-${EDGE_CHROMIUM_VERSION}`;
}

function headers(): Record<string, string> {
  return { ...edgeHeaders(), Cookie: `muid=${randomBytes(16).toString('hex')};` };
}

/** Learn the server clock from a plain HTTPS response (the WebSocket handshake hides its headers). */
async function syncClock(): Promise<void> {
  try {
    const res = await fetch(EDGE_VOICES_URL, { method: 'HEAD', headers: headers() });
    const date = res.headers.get('date');
    if (!date) return;
    const server = Date.parse(date);
    if (Number.isFinite(server)) {
      clockSkewSec = (server - Date.now()) / 1000;
      log('INFO', 'edge-tts', `clock skew ${clockSkewSec.toFixed(0)} s`);
    }
  } catch (err) {
    log('WARN', 'edge-tts', `clock sync failed: ${(err as Error).message}`);
  }
}

function synthesizeOnce(req: EdgeSynthesizeRequest): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let settled = false;
    let ws: WebSocket;
    try {
      // Node's global WebSocket accepts extra handshake headers (undici), which the service checks.
      ws = new (WebSocket as unknown as new (url: string, options: { headers: Record<string, string> }) => WebSocket)(signedUrl(), { headers: headers() });
    } catch (err) {
      reject(err as Error);
      return;
    }
    ws.binaryType = 'arraybuffer';
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* already closed */
      }
      if (err) reject(err);
      else {
        const total = chunks.reduce((n, c) => n + c.byteLength, 0);
        const out = new Uint8Array(total);
        let o = 0;
        for (const c of chunks) {
          out.set(c, o);
          o += c.byteLength;
        }
        resolve(out);
      }
    };
    const timer = setTimeout(() => finish(new Error('Edge TTS : délai dépassé')), SYNTH_TIMEOUT_MS);
    ws.onopen = () => {
      ws.send(edgeConfigMessage());
      ws.send(edgeSsmlMessage(edgeConnectionId(randomUUID()), edgeSsml(req.text, req.voice, req.speed)));
    };
    ws.onmessage = (event: MessageEvent) => {
      if (typeof event.data === 'string') {
        if (edgeTextFramePath(event.data) === 'turn.end') finish();
        return;
      }
      const frame = new Uint8Array(event.data as ArrayBuffer);
      const { path, payload } = parseEdgeBinaryFrame(frame);
      if (path === 'audio' && payload.byteLength) chunks.push(payload);
    };
    ws.onerror = (event: Event) => finish(new Error(`Edge TTS : connexion refusée (${(event as { message?: string }).message ?? 'erreur réseau'})`));
    ws.onclose = (event: CloseEvent) => {
      if (!settled) finish(chunks.length ? undefined : new Error(`Edge TTS : connexion fermée (${event.code}${event.reason ? ' ' + event.reason : ''})`));
    };
  });
}

export async function edgeSynthesize(req: EdgeSynthesizeRequest): Promise<EdgeSynthesizeResult> {
  const started = Date.now();
  let mp3: Uint8Array;
  try {
    mp3 = await synthesizeOnce(req);
  } catch (err) {
    // A refused handshake is almost always a stale signature: resync the clock and retry once.
    log('WARN', 'edge-tts', `first attempt failed (${(err as Error).message}), resyncing clock`);
    await syncClock();
    mp3 = await synthesizeOnce(req);
  }
  if (!mp3.byteLength) throw new Error('Edge TTS : aucun audio reçu');
  return { mp3, durationMs: Date.now() - started };
}

/** Voice list from the service (cached six hours); falls back to an empty list offline. */
export async function edgeVoices(): Promise<EdgeVoice[]> {
  if (voicesCache && Date.now() - voicesCache.at < VOICES_TTL_MS) return voicesCache.voices;
  const url = `${EDGE_VOICES_URL}&Sec-MS-GEC=${token()}&Sec-MS-GEC-Version=1-${EDGE_CHROMIUM_VERSION}`;
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) throw new Error(`Edge TTS : liste des voix HTTP ${res.status}`);
  const raw = (await res.json()) as Array<{ ShortName?: string; FriendlyName?: string; Locale?: string; Gender?: string }>;
  const voices: EdgeVoice[] = raw
    .filter((v) => typeof v.ShortName === 'string' && typeof v.Locale === 'string')
    .map((v) => ({
      shortName: v.ShortName!,
      name: v.ShortName!.split('-')[2]?.replace(/(Multilingual)?Neural$/, '') || v.FriendlyName || v.ShortName!,
      locale: v.Locale!,
      gender: v.Gender === 'Male' ? ('m' as const) : ('f' as const)
    }))
    .sort((a, b) => a.locale.localeCompare(b.locale) || a.name.localeCompare(b.name));
  voicesCache = { at: Date.now(), voices };
  return voices;
}
