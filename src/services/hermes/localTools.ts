/**
 * Client-side tools offered to Hermes in chat-completions mode (OpenAI tool calling).
 * With the runs/sessions transports Hermes uses its own server-side toolsets instead.
 */
import { bridge } from '../../lib/bridge';
import type { SystemAction } from '../../../shared/bridge';

export interface LocalToolContext {
  setEmotion: (emotion: string) => void;
  showMessage?: (text: string, title?: string) => void;
  speak: (text: string) => void;
  getStatus: () => Record<string, unknown>;
  getHistory: (n: number) => Array<{ role: string; content: string }>;
  notify: (title: string, body: string) => void;
}

const fn = (name: string, description: string, properties: Record<string, unknown> = {}, required: string[] = []) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required } }
});

/** Tools executed on the user's PC through the Electron main process (allow-listed). */
export const SYSTEM_TOOL_DEFINITIONS = [
  fn('lock_session', "Verrouille la session de l'utilisateur."),
  fn('open_app', "Lance une application du PC de l'utilisateur (bloc-notes, calculatrice, chrome, spotify, vscode, terminal, explorateur…).", { name: { type: 'string' } }, ['name']),
  fn('open_url', "Ouvre une URL http(s) dans le navigateur de l'utilisateur.", { url: { type: 'string' } }, ['url']),
  fn('media_key', 'Touche média : volume-up, volume-down, mute, play-pause, next, previous.', { key: { type: 'string', enum: ['volume-up', 'volume-down', 'mute', 'play-pause', 'next', 'previous'] } }, ['key']),
  fn('clipboard_get', 'Lit le texte du presse-papiers.'),
  fn('clipboard_set', 'Place un texte dans le presse-papiers.', { text: { type: 'string' } }, ['text']),
  fn('find_files', "Cherche des fichiers par nom dans Documents, Bureau, Téléchargements et Images (25 max).", { query: { type: 'string' } }, ['query'])
];

export const LOCAL_TOOL_DEFINITIONS = [
  ...SYSTEM_TOOL_DEFINITIONS,
  {
    type: 'function',
    function: {
      name: 'set_hud_state',
      description: "Change l'état visuel du HUD EveFlow (couleur/animation du noyau) pour accompagner la réponse.",
      parameters: {
        type: 'object',
        properties: {
          state: { type: 'string', enum: ['neutral', 'happy', 'thinking', 'alert', 'error', 'success'] }
        },
        required: ['state']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_app_status',
      description: "Retourne l'état courant d'EveFlow (transport, voix, nombre de messages, hôte).",
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_conversation_history',
      description: 'Retourne les N derniers messages affichés dans EveFlow.',
      parameters: { type: 'object', properties: { n: { type: 'number', minimum: 1, maximum: 30 } }, required: ['n'] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'speak_text',
      description: 'Fait prononcer immédiatement un texte court par la voix du HUD.',
      parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'notify_user',
      description: 'Affiche une notification système Windows à l’utilisateur.',
      parameters: { type: 'object', properties: { title: { type: 'string' }, body: { type: 'string' } }, required: ['title', 'body'] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_shared_file',
      description: "Écrit un fichier texte (rapport, script, JSON, HTML, SVG) dans le dossier partagé EveFlow_Shared de l'utilisateur et renvoie son URL.",
      parameters: {
        type: 'object',
        properties: { filename: { type: 'string' }, content: { type: 'string' } },
        required: ['filename', 'content']
      }
    }
  }
];

export async function executeLocalTool(name: string, rawArgs: string, ctx: LocalToolContext): Promise<string> {
  let args: Record<string, unknown> = {};
  try {
    args = rawArgs ? (JSON.parse(rawArgs) as Record<string, unknown>) : {};
  } catch {
    return JSON.stringify({ error: 'invalid JSON arguments' });
  }
  try {
    switch (name) {
      case 'set_hud_state':
        ctx.setEmotion(String(args.state ?? 'neutral'));
        return JSON.stringify({ ok: true });
      case 'get_app_status':
        return JSON.stringify(ctx.getStatus());
      case 'get_conversation_history':
        return JSON.stringify({ messages: ctx.getHistory(Math.min(30, Number(args.n) || 5)) });
      case 'speak_text':
        ctx.speak(String(args.text ?? '').slice(0, 600));
        return JSON.stringify({ ok: true });
      case 'notify_user':
        ctx.notify(String(args.title ?? 'EveFlow'), String(args.body ?? ''));
        return JSON.stringify({ ok: true });
      case 'show_message':
        ctx.showMessage?.(String(args.text ?? ''), typeof args.title === 'string' ? args.title : undefined);
        return JSON.stringify({ ok: true });
      case 'lock_session':
      case 'open_app':
      case 'open_url':
      case 'media_key':
      case 'clipboard_get':
      case 'clipboard_set':
      case 'find_files': {
        const api = bridge();
        if (!api) return JSON.stringify({ error: 'system actions unavailable outside Electron' });
        const action: SystemAction =
          name === 'lock_session' ? { type: 'lock' }
          : name === 'open_app' ? { type: 'open-app', name: String(args.name ?? '') }
          : name === 'open_url' ? { type: 'open-url', url: String(args.url ?? '') }
          : name === 'media_key' ? { type: 'media', key: String(args.key ?? '') as 'mute' }
          : name === 'clipboard_get' ? { type: 'clipboard-read' }
          : name === 'clipboard_set' ? { type: 'clipboard-write', text: String(args.text ?? '') }
          : { type: 'find-files', query: String(args.query ?? '') };
        const result = await api.system.action(action);
        return JSON.stringify(result.ok ? { ok: true, message: result.message, data: result.data } : { error: result.message ?? 'failed' });
      }
      case 'write_shared_file': {
        const api = bridge();
        if (!api) return JSON.stringify({ error: 'file system unavailable outside Electron' });
        const result = await api.files.writeShared(String(args.filename ?? 'fichier.txt'), String(args.content ?? ''), false);
        return JSON.stringify({ ok: true, ...result });
      }
      default:
        return JSON.stringify({ error: `unknown tool ${name}` });
    }
  } catch (err) {
    return JSON.stringify({ error: (err as Error).message });
  }
}
