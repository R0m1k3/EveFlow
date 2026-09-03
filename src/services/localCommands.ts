/**
 * Instant local commands: short French/English intents handled on the machine without a
 * round trip to Hermes (lock, open app/url, volume, media, screenshot to Hermes).
 * Anything unmatched goes to Hermes as usual.
 */
import type { SystemAction } from '../../shared/bridge';
import { bridge } from '../lib/bridge';
import { Log } from '../lib/log';

export interface LocalIntent {
  kind: 'action' | 'screenshot';
  action?: SystemAction;
  /** Spoken confirmation. */
  reply: string;
  /** For screenshot: the question to send to Hermes with the image. */
  question?: string;
}

const norm = (t: string) =>
  t
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[’']/g, ' ')
    .replace(/[^a-z0-9 :/._-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const LOCK = /^(verrouille|verrouiller|bloque|lock)( (la |ma )?(session|le pc|l ordinateur|the (pc|computer|screen)))?$/;
const VOL_UP = /^(monte|augmente|hausse|plus fort|volume plus|turn up|raise)( (le|the)? ?(son|volume))?( de \d+)?$/;
const VOL_DOWN = /^(baisse|diminue|moins fort|volume moins|turn down|lower)( (le|the)? ?(son|volume))?( de \d+)?$/;
const MUTE = /^(coupe|couper|mute|silence|desactive)( (le|the)? ?(son|volume|audio))?$/;
const PLAY = /^(pause|play|lecture|reprends|reprendre|mets en pause|met en pause|stop la musique|arrete la musique)$/;
const NEXT = /^(suivant|suivante|piste suivante|musique suivante|next|skip)$/;
const PREV = /^(precedent|precedente|piste precedente|previous)$/;
const OPEN_APP = /^(ouvre|ouvrir|lance|lancer|demarre|open|launch|start) ((l application|l appli|le logiciel|le programme|the app|le|la|les|l|un|une|the|moi) )*(.+)$/;
const OPEN_URL = /^(ouvre|ouvrir|va sur|open|go to) (https?:\/\/\S+|(www\.)?[a-z0-9-]+\.[a-z]{2,}(\/\S*)?)$/;
const SCREEN = /(regarde|regardes|analyse|decris|decrit|lis|explique|qu est ce qu il y a sur|que vois tu sur|what is on|look at|read) (mon |l |the )?(ecran|screen)|capture (d )?ecran|screenshot/;

export function parseLocalIntent(text: string): LocalIntent | null {
  const t = norm(text).replace(/^(jarvis|hey jarvis|ok jarvis)[ ,]*/, '');
  if (!t) return null;
  if (LOCK.test(t)) return { kind: 'action', action: { type: 'lock' }, reply: 'Session verrouillée.' };
  if (MUTE.test(t)) return { kind: 'action', action: { type: 'media', key: 'mute' }, reply: 'Son coupé.' };
  if (VOL_UP.test(t)) return { kind: 'action', action: { type: 'media', key: 'volume-up' }, reply: 'Volume augmenté.' };
  if (VOL_DOWN.test(t)) return { kind: 'action', action: { type: 'media', key: 'volume-down' }, reply: 'Volume baissé.' };
  if (PLAY.test(t)) return { kind: 'action', action: { type: 'media', key: 'play-pause' }, reply: 'Lecture.' };
  if (NEXT.test(t)) return { kind: 'action', action: { type: 'media', key: 'next' }, reply: 'Piste suivante.' };
  if (PREV.test(t)) return { kind: 'action', action: { type: 'media', key: 'previous' }, reply: 'Piste précédente.' };
  if (SCREEN.test(t)) return { kind: 'screenshot', reply: 'Je regarde votre écran.', question: text.trim() };
  const url = OPEN_URL.exec(t);
  if (url) {
    const target = url[2].startsWith('http') ? url[2] : `https://${url[2]}`;
    return { kind: 'action', action: { type: 'open-url', url: target }, reply: `J’ouvre ${url[2]}.` };
  }
  const app = OPEN_APP.exec(t);
  if (app) {
    const name = app[app.length - 1].trim();
    if (name.length <= 40 && !/\s(et|puis|and)\s/.test(name)) return { kind: 'action', action: { type: 'open-app', name }, reply: `J’ouvre ${name}.` };
  }
  return null;
}

/** Execute an action intent through the bridge. Returns the spoken outcome. */
export async function runLocalIntent(intent: LocalIntent): Promise<{ ok: boolean; message: string }> {
  const api = bridge();
  if (!api || !intent.action) return { ok: false, message: 'Actions locales indisponibles hors Electron.' };
  try {
    const result = await api.system.action(intent.action);
    Log.info('local', `${intent.action.type}: ${result.ok ? 'ok' : result.message}`);
    return { ok: result.ok, message: result.ok ? intent.reply : result.message || 'Échec de la commande locale.' };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}
