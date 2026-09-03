/**
 * Local webhook server: Hermes (cron deliveries, gateway mirrors, scripts) pushes JSON here
 * and EveFlow displays / speaks the result. POST /eveflow/hook, GET /health.
 */
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { BrowserWindow } from 'electron';
import { IPC, type WebhookStatus } from '../shared/ipc';
import { normalizeHermesPush } from '../shared/hermesPush';
import { log } from './logger';
import { handleMcpHttp, MCP_PATH } from './mcp';

export const WEBHOOK_PATH = '/eveflow/hook';
const MAX_BODY_BYTES = 2 * 1024 * 1024;

export interface WebhookOptions {
  port: number;
  secret?: string;
  host?: string;
}

let server: http.Server | null = null;
let status: WebhookStatus = { listening: false, port: 7842, path: WEBHOOK_PATH, secretConfigured: false };

function secretMatches(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function getWebhookStatus(): WebhookStatus {
  return status;
}

export function stopWebhookServer(): Promise<void> {
  return new Promise((resolve) => {
    if (!server) return resolve();
    const current = server;
    server = null;
    status = { ...status, listening: false };
    current.closeAllConnections();
    current.close(() => resolve());
  });
}

export async function startWebhookServer(getWindow: () => BrowserWindow | null, options: WebhookOptions): Promise<WebhookStatus> {
  await stopWebhookServer();
  const { port, secret } = options;
  // Without a shared secret the hook only listens on loopback: anyone on the LAN could otherwise inject messages.
  const host = options.host ?? (secret ? '0.0.0.0' : '127.0.0.1');
  if (host !== '127.0.0.1' && !secret) log('WARN', 'webhook', `listening on ${host} without a secret`);

  server = http.createServer((req, res) => {
    const json = (code: number, payload: unknown) => {
      res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(payload));
    };

    if (req.method === 'GET' && (req.url === '/health' || req.url === '/')) {
      return json(200, { ok: true, app: 'eveflow', path: WEBHOOK_PATH, mcp: MCP_PATH });
    }
    const isMcp = !!req.url && (req.url === MCP_PATH || req.url.startsWith(`${MCP_PATH}?`));
    if (!isMcp && (req.method !== 'POST' || !req.url?.startsWith(WEBHOOK_PATH))) {
      return json(404, { error: 'Not Found' });
    }

    if (secret) {
      const auth = req.headers.authorization?.replace(/^Bearer\s+/i, '');
      const custom = req.headers['x-eveflow-secret'];
      const provided = typeof custom === 'string' ? custom : auth;
      if (!secretMatches(provided, secret)) {
        log('WARN', 'webhook', `rejected push from ${req.socket.remoteAddress}: bad secret`);
        return json(401, { error: 'Unauthorized' });
      }
    }

    const chunks: Buffer[] = [];
    let bytes = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      if (tooLarge) return;
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        tooLarge = true;
        res.writeHead(413, { 'Content-Type': 'application/json', Connection: 'close' });
        res.end(JSON.stringify({ error: 'Payload too large' }), () => req.socket.destroy());
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) return;
      // Concatenate before decoding so multibyte UTF-8 (accents, emoji) split across chunks stays intact.
      const body = Buffer.concat(chunks).toString('utf8');
      if (isMcp) {
        handleMcpHttp(getWindow(), req, res, body).catch((err: Error) => {
          log('ERROR', 'mcp', err.message);
          if (!res.headersSent) json(500, { error: err.message });
        });
        return;
      }
      try {
        const raw: unknown = body.trim() ? JSON.parse(body) : {};
        const events = normalizeHermesPush(raw);
        log('INFO', 'webhook', `${events.length} event(s) from ${events[0]?.source ?? '?'} (${req.socket.remoteAddress})`);
        const win = getWindow();
        if (win && !win.isDestroyed()) {
          for (const event of events) win.webContents.send(IPC.hermesPush, event);
        }
        json(200, { ok: true, events: events.length });
      } catch (err) {
        log('WARN', 'webhook', `invalid JSON payload: ${(err as Error).message}`);
        json(400, { error: 'Invalid JSON' });
      }
    });
  });

  return new Promise((resolve) => {
    const instance = server!;
    instance.on('error', (err: NodeJS.ErrnoException) => {
      log('ERROR', 'webhook', `server error: ${err.message}`);
      status = { listening: false, port, path: WEBHOOK_PATH, secretConfigured: !!secret, error: err.message };
      if (server === instance) server = null;
      resolve(status);
    });
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      instance.emit('error', new Error(`port invalide : ${port}`));
      return;
    }
    instance.listen(port, host, () => {
      log('INFO', 'webhook', `listening on http://${host}:${port}${WEBHOOK_PATH}`);
      status = { listening: true, port, path: WEBHOOK_PATH, secretConfigured: !!secret };
      resolve(status);
    });
  });
}
