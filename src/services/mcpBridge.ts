/**
 * Answers tool calls that Hermes sends through the local MCP endpoint and that need the renderer
 * (voice, notifications, HUD, chat). System tools are executed in the main process directly.
 */
import type { McpToolRequest } from '../../shared/ipc';
import { bridge } from '../lib/bridge';
import { Log } from '../lib/log';
import { useChat } from '../state/chat';
import { executeLocalTool, type LocalToolContext } from './hermes/localTools';

let unsubscribe: (() => void) | null = null;

export function initMcpBridge(context: () => LocalToolContext): void {
  const api = bridge();
  if (!api || unsubscribe) return;
  unsubscribe = api.hermes.onToolRequest((req: McpToolRequest) => {
    void handle(req, context)
      .then((result) => api.hermes.toolResponse({ id: req.id, ok: true, result }))
      .catch((err: Error) => api.hermes.toolResponse({ id: req.id, ok: false, error: err.message }));
  });
}

async function handle(req: McpToolRequest, context: () => LocalToolContext): Promise<unknown> {
  Log.info('mcp', `tool ${req.name}`);
  const chat = useChat.getState();
  if (req.name === 'show_message') {
    const text = String(req.args.text ?? '');
    if (!text.trim()) throw new Error('texte vide');
    chat.addMessage({ role: 'assistant', content: text, source: 'mcp', jobName: typeof req.args.title === 'string' ? req.args.title : undefined, status: 'done' });
    chat.pushActivity({ kind: 'system', name: 'hermes → eveflow', status: 'done', detail: text.slice(0, 160) });
    return { ok: true };
  }
  const raw = await executeLocalTool(req.name, JSON.stringify(req.args ?? {}), context());
  try {
    const parsed = JSON.parse(raw) as { error?: string };
    if (parsed && typeof parsed === 'object' && parsed.error) throw new Error(parsed.error);
    return parsed;
  } catch (err) {
    if ((err as Error).message && !(err instanceof SyntaxError)) throw err;
    return raw;
  }
}
