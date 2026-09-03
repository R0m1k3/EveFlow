/**
 * Minimal MCP server (Streamable HTTP, JSON-RPC 2.0) mounted on the webhook HTTP server at /mcp.
 * Hermes Agent connects to it as a remote MCP server and gains the PC-side tools: screen capture,
 * system actions, voice, notifications and HUD state. No SDK: initialize / tools/list / tools/call
 * are the only methods a client needs, and every reply is a plain JSON body.
 */
import { ipcMain, type BrowserWindow } from 'electron';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { IPC, type McpToolRequest, type McpToolResponse } from '../shared/ipc';
import type { SystemAction } from '../shared/bridge';
import { log } from './logger';
import { captureScreen, runSystemAction } from './ipc/system';

export const MCP_PATH = '/mcp';
const PROTOCOL = '2025-03-26';
const RENDERER_TIMEOUT_MS = 20_000;

interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** 'main' = executed here; 'renderer' = forwarded to the UI process. */
  where: 'main' | 'renderer';
}

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });

export const MCP_TOOLS: ToolSpec[] = [
  { name: 'capture_screen', description: "Capture l'écran principal de l'utilisateur et renvoie l'image (JPEG). À utiliser quand l'utilisateur parle de ce qu'il voit ou demande de l'aide sur son écran.", inputSchema: obj({ max_width: { type: 'integer', description: 'Largeur maximale en pixels (défaut 1600)' } }), where: 'main' },
  { name: 'lock_session', description: "Verrouille la session Windows/Linux/macOS de l'utilisateur.", inputSchema: obj({}), where: 'main' },
  { name: 'open_app', description: "Lance une application sur le PC de l'utilisateur (bloc-notes, calculatrice, chrome, spotify, vscode, terminal, explorateur…).", inputSchema: obj({ name: { type: 'string' } }, ['name']), where: 'main' },
  { name: 'open_url', description: "Ouvre une URL http(s) dans le navigateur par défaut de l'utilisateur.", inputSchema: obj({ url: { type: 'string' } }, ['url']), where: 'main' },
  { name: 'media_key', description: 'Envoie une touche média : volume-up, volume-down, mute, play-pause, next, previous.', inputSchema: obj({ key: { type: 'string', enum: ['volume-up', 'volume-down', 'mute', 'play-pause', 'next', 'previous'] } }, ['key']), where: 'main' },
  { name: 'clipboard_get', description: 'Lit le texte du presse-papiers.', inputSchema: obj({}), where: 'main' },
  { name: 'clipboard_set', description: 'Place un texte dans le presse-papiers.', inputSchema: obj({ text: { type: 'string' } }, ['text']), where: 'main' },
  { name: 'find_files', description: "Cherche des fichiers par nom dans Documents, Bureau, Téléchargements et Images de l'utilisateur (25 résultats max).", inputSchema: obj({ query: { type: 'string' } }, ['query']), where: 'main' },
  { name: 'speak_text', description: "Fait prononcer un texte par la voix d'EveFlow, immédiatement.", inputSchema: obj({ text: { type: 'string' } }, ['text']), where: 'renderer' },
  { name: 'notify_user', description: 'Affiche une notification système (titre + corps).', inputSchema: obj({ title: { type: 'string' }, body: { type: 'string' } }, ['body']), where: 'renderer' },
  { name: 'set_hud_state', description: 'Change momentanément l’état visuel du HUD : neutral, happy, thinking, alert, error.', inputSchema: obj({ state: { type: 'string', enum: ['neutral', 'happy', 'thinking', 'alert', 'error'] } }, ['state']), where: 'renderer' },
  { name: 'get_app_status', description: "État d'EveFlow : transport, liaison, nom de l'assistant, mains libres, voix en cours, heures calmes.", inputSchema: obj({}), where: 'renderer' },
  { name: 'get_conversation_history', description: 'Derniers messages de la conversation EveFlow (n ≤ 30).', inputSchema: obj({ n: { type: 'integer' } }), where: 'renderer' },
  { name: 'show_message', description: "Affiche un message dans le fil EveFlow (sans le prononcer) — pour les rapports longs ou les résultats de crons.", inputSchema: obj({ text: { type: 'string' }, title: { type: 'string' } }, ['text']), where: 'renderer' }
];

type Rec = Record<string, unknown>;
interface RpcRequest {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Rec;
}

const pending = new Map<string, { resolve: (r: McpToolResponse) => void; timer: ReturnType<typeof setTimeout> }>();
let seq = 0;
let ipcRegistered = false;

function ensureIpc(): void {
  if (ipcRegistered) return;
  ipcRegistered = true;
  ipcMain.on(IPC.mcpResponse, (_e, res: McpToolResponse) => {
    if (!res || typeof res.id !== 'string') return;
    const entry = pending.get(res.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(res.id);
    entry.resolve(res);
  });
}

function askRenderer(win: BrowserWindow | null, name: string, args: Rec): Promise<McpToolResponse> {
  ensureIpc();
  if (!win || win.isDestroyed()) return Promise.resolve({ id: '', ok: false, error: 'EveFlow window unavailable' });
  const id = `mcp-${++seq}-${Date.now()}`;
  const req: McpToolRequest = { id, name, args };
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ id, ok: false, error: 'renderer timeout' });
    }, RENDERER_TIMEOUT_MS);
    pending.set(id, { resolve, timer });
    win.webContents.send(IPC.mcpRequest, req);
  });
}

function text(value: unknown): { content: Array<Rec>; isError?: boolean } {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] };
}

function failure(message: string): { content: Array<Rec>; isError: boolean } {
  return { content: [{ type: 'text', text: message }], isError: true };
}

async function callTool(win: BrowserWindow | null, name: string, args: Rec): Promise<{ content: Array<Rec>; isError?: boolean }> {
  const spec = MCP_TOOLS.find((t) => t.name === name);
  if (!spec) return failure(`Outil inconnu : ${name}`);
  if (spec.where === 'renderer') {
    const res = await askRenderer(win, name, args);
    return res.ok ? text(res.result ?? { ok: true }) : failure(res.error ?? 'échec');
  }
  const sys = async (action: SystemAction) => {
    const r = await runSystemAction(action);
    return r.ok ? text(r.data !== undefined ? { ok: true, message: r.message, data: r.data } : { ok: true, message: r.message }) : failure(r.message ?? 'échec');
  };
  switch (name) {
    case 'capture_screen': {
      const dataUrl = await captureScreen(Number(args.max_width) || 1600);
      const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
      return { content: [{ type: 'image', data: base64, mimeType: 'image/jpeg' }, { type: 'text', text: `Capture de l'écran principal (${Math.round(base64.length * 0.75 / 1024)} ko).` }] };
    }
    case 'lock_session':
      return sys({ type: 'lock' });
    case 'open_app':
      return sys({ type: 'open-app', name: String(args.name ?? '') });
    case 'open_url':
      return sys({ type: 'open-url', url: String(args.url ?? '') });
    case 'media_key':
      return sys({ type: 'media', key: String(args.key ?? '') as 'mute' });
    case 'clipboard_get':
      return sys({ type: 'clipboard-read' });
    case 'clipboard_set':
      return sys({ type: 'clipboard-write', text: String(args.text ?? '') });
    case 'find_files':
      return sys({ type: 'find-files', query: String(args.query ?? '') });
    default:
      return failure(`Outil non implémenté : ${name}`);
  }
}

/** Handle one JSON-RPC message; returns the response object (or null for notifications). */
export async function handleMcpMessage(win: BrowserWindow | null, msg: RpcRequest): Promise<Rec | null> {
  const id = msg.id ?? null;
  const reply = (result: unknown) => ({ jsonrpc: '2.0', id, result });
  const error = (code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } });
  if (!msg.method) return error(-32600, 'Invalid Request');
  if (msg.method.startsWith('notifications/')) return null;
  switch (msg.method) {
    case 'initialize':
      return reply({ protocolVersion: PROTOCOL, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'eveflow', version: process.env.npm_package_version ?? '2.4.0' }, instructions: "Outils du PC de l'utilisateur via EveFlow : écran, applications, volume, presse-papiers, voix et notifications." });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: MCP_TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case 'tools/call': {
      const params = (msg.params ?? {}) as Rec;
      const name = String(params.name ?? '');
      const args = (params.arguments && typeof params.arguments === 'object' ? params.arguments : {}) as Rec;
      log('INFO', 'mcp', `tools/call ${name}`);
      try {
        return reply(await callTool(win, name, args));
      } catch (err) {
        return reply(failure((err as Error).message));
      }
    }
    case 'resources/list':
      return reply({ resources: [] });
    case 'prompts/list':
      return reply({ prompts: [] });
    default:
      return error(-32601, `Method not found: ${msg.method}`);
  }
}

/** HTTP entry point: POST /mcp with one JSON-RPC message or a batch. */
export async function handleMcpHttp(win: BrowserWindow | null, req: IncomingMessage, res: ServerResponse, body: string): Promise<void> {
  const send = (code: number, payload: unknown) => {
    if (payload === undefined) {
      res.writeHead(code, { 'Cache-Control': 'no-store' });
      res.end();
      return;
    }
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(payload));
  };
  if (req.method === 'GET') return send(405, { error: 'SSE stream not supported; use POST' });
  if (req.method === 'DELETE') return send(204, undefined);
  if (req.method !== 'POST') return send(405, { error: 'Method Not Allowed' });
  let parsed: unknown;
  try {
    parsed = body.trim() ? JSON.parse(body) : {};
  } catch {
    return send(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  }
  const messages = Array.isArray(parsed) ? (parsed as RpcRequest[]) : [parsed as RpcRequest];
  const replies: Rec[] = [];
  for (const msg of messages) {
    const out = await handleMcpMessage(win, msg && typeof msg === 'object' ? msg : {});
    if (out) replies.push(out);
  }
  if (replies.length === 0) return send(202, undefined);
  return send(200, Array.isArray(parsed) ? replies : replies[0]);
}
