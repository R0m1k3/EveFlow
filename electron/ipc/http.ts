/**
 * HTTP proxy: the renderer never talks to the network directly (webSecurity stays ON).
 * Every request to Hermes / STT / TTS endpoints flows through here, which also removes
 * CORS and mixed-content restrictions for LAN services served over plain HTTP.
 */
import { ipcMain, type WebContents } from 'electron';
import {
  IPC,
  type HttpProxyRequest,
  type HttpProxyResponse,
  type HttpStreamStart,
  type HttpStreamEvent
} from '../../shared/ipc';
import { log } from '../logger';

const activeStreams = new Map<string, AbortController>();

function assertUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`URL invalide : ${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Protocole non autorise : ${parsed.protocol}`);
  }
  return parsed;
}

function buildInit(req: HttpProxyRequest, signal: AbortSignal): RequestInit {
  const headers: Record<string, string> = { ...(req.headers ?? {}) };
  let body: RequestInit['body'];
  if (req.multipart) {
    const form = new FormData();
    for (const [k, v] of Object.entries(req.multipart.fields)) form.append(k, v);
    const file = req.multipart.file;
    const bytes = new Uint8Array(file.data);
    form.append(req.multipart.fileField ?? 'file', new Blob([bytes], { type: file.type }), file.name);
    body = form;
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === 'content-type') delete headers[key];
    }
  } else if (req.body !== undefined) {
    body = req.body;
  }
  return { method: req.method ?? 'GET', headers, body, signal };
}

function headersToObject(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((v, k) => {
    out[k.toLowerCase()] = v;
  });
  return out;
}

export async function proxyFetch(req: HttpProxyRequest): Promise<HttpProxyResponse> {
  assertUrl(req.url);
  const controller = new AbortController();
  const timeoutMs = req.timeoutMs ?? 60_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(req.url, buildInit(req, controller.signal));
    const base = {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      headers: headersToObject(response.headers)
    };
    if (req.responseType === 'binary') {
      return { ...base, binary: new Uint8Array(await response.arrayBuffer()) };
    }
    return { ...base, text: await response.text() };
  } catch (err) {
    const e = err as Error;
    if (e.name === 'AbortError') throw new Error(`Delai depasse (${Math.round(timeoutMs / 1000)}s) : ${req.url}`);
    throw new Error(e.message || String(err));
  } finally {
    clearTimeout(timer);
  }
}

async function startStream(sender: WebContents, id: string, req: HttpProxyRequest): Promise<HttpStreamStart> {
  assertUrl(req.url);
  const controller = new AbortController();
  activeStreams.set(id, controller);
  const send = (event: HttpStreamEvent) => {
    if (!sender.isDestroyed()) sender.send(IPC.httpStreamEvent, event);
  };

  let response: Response;
  try {
    response = await fetch(req.url, buildInit(req, controller.signal));
  } catch (err) {
    activeStreams.delete(id);
    throw new Error((err as Error).message || String(err));
  }

  const start: HttpStreamStart = {
    id,
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    headers: headersToObject(response.headers)
  };

  const onDestroyed = () => controller.abort();
  sender.once('destroyed', onDestroyed);
  const pump = async () => {
    try {
      if (!response.body) {
        send({ id, type: 'end' });
        return;
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      // Hermes runs can be long, but a totally silent stream is abandoned after the idle timeout.
      const idleMs = req.timeoutMs ?? 10 * 60_000;
      for (;;) {
        let idleTimer: ReturnType<typeof setTimeout> | undefined;
        const idle = new Promise<never>((_, reject) => {
          idleTimer = setTimeout(() => reject(new Error('Flux silencieux (timeout)')), idleMs);
        });
        const { done, value } = await Promise.race([reader.read(), idle]);
        if (idleTimer) clearTimeout(idleTimer);
        if (done) break;
        send({ id, type: 'chunk', text: decoder.decode(value, { stream: true }) });
      }
      const tail = decoder.decode();
      if (tail) send({ id, type: 'chunk', text: tail });
      send({ id, type: 'end' });
    } catch (err) {
      const e = err as Error;
      if (e.name === 'AbortError') send({ id, type: 'end' });
      else send({ id, type: 'error', message: e.message || String(err) });
    } finally {
      // Releases the socket when we bailed out early (idle timeout, renderer gone).
      controller.abort();
      sender.removeListener('destroyed', onDestroyed);
      if (activeStreams.get(id) === controller) activeStreams.delete(id);
    }
  };
  void pump();
  return start;
}

export function abortAllStreams(): void {
  for (const controller of activeStreams.values()) controller.abort();
  activeStreams.clear();
}

export function registerHttpIpc(): void {
  ipcMain.handle(IPC.httpFetch, (_e, req: HttpProxyRequest) => proxyFetch(req));
  ipcMain.handle(IPC.httpStreamStart, (event, id: unknown, req: HttpProxyRequest) => {
    if (typeof id !== 'string' || !id || id.length > 64 || activeStreams.has(id)) throw new Error('Identifiant de flux invalide');
    if (!req || typeof req.url !== 'string') throw new Error('Requête invalide');
    return startStream(event.sender, id, req);
  });
  ipcMain.on(IPC.httpStreamAbort, (_e, id: string) => {
    const controller = activeStreams.get(id);
    if (controller) {
      controller.abort();
      activeStreams.delete(id);
      log('DEBUG', 'http', `stream ${id} aborted by renderer`);
    }
  });
}
