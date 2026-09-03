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
    server.close(() => resolve());
    server = null;
    status = { ...status, listening: false };
  });
}

export async function startWebhookServer(getWindow: () => BrowserWindow | null, options: WebhookOptions): Promise<WebhookStatus> {
  await stopWebhookServer();
  const { port, secret } = options;
  const host = options.host ?? '0.0.0.0';

  server = http.createServer((req, res) => {
    const json = (code: number, payload: unknown) => {
      res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(payload));
    };

    if (req.method === 'GET' && (req.url === '/health' || req.url === '/')) {
      return json(200, { ok: true, app: 'eveflow', path: WEBHOOK_PATH });
    }
    if (req.method !== 'POST' || !req.url?.startsWith(WEBHOOK_PATH)) {
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

    let body = '';
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      if (tooLarge) return;
      body += chunk.toString('utf8');
      if (body.length > MAX_BODY_BYTES) {
        tooLarge = true;
        json(413, { error: 'Payload too large' });
        req.destroy();
      }
    });
    req.on('end', () => {
      if (tooLarge) return;
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
    server!.once('error', (err: NodeJS.ErrnoException) => {
      log('ERROR', 'webhook', `server error: ${err.message}`);
      status = { listening: false, port, path: WEBHOOK_PATH, secretConfigured: !!secret, error: err.message };
      server = null;
      resolve(status);
    });
    server!.listen(port, host, () => {
      log('INFO', 'webhook', `listening on http://${host}:${port}${WEBHOOK_PATH}`);
      status = { listening: true, port, path: WEBHOOK_PATH, secretConfigured: !!secret };
      resolve(status);
    });
  });
}
