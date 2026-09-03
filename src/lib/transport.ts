import type { HttpProxyRequest, HttpProxyResponse, HttpStreamEvent, HttpStreamStart } from '../../shared/ipc';
import { bridge } from './bridge';
import { uid } from './id';

export class HttpError extends Error {
  constructor(public readonly status: number, message: string, public readonly body?: string) {
    super(message);
    this.name = 'HttpError';
  }
}

/** One-shot HTTP request routed through the Electron main process (or fetch in a browser). */
export async function httpFetch(req: HttpProxyRequest): Promise<HttpProxyResponse> {
  const api = bridge();
  if (api) return api.http.fetch(req);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), req.timeoutMs ?? 60_000);
  try {
    const headers: Record<string, string> = { ...(req.headers ?? {}) };
    let body: BodyInit | undefined;
    if (req.multipart) {
      const form = new FormData();
      for (const [k, v] of Object.entries(req.multipart.fields)) form.append(k, v);
      const f = req.multipart.file;
      const bytes = new Uint8Array(f.data);
      form.append(req.multipart.fileField ?? 'file', new Blob([bytes], { type: f.type }), f.name);
      body = form;
      delete headers['Content-Type'];
    } else {
      body = req.body;
    }
    const res = await fetch(req.url, { method: req.method ?? 'GET', headers, body, signal: controller.signal });
    const outHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => (outHeaders[k.toLowerCase()] = v));
    const base = { ok: res.ok, status: res.status, statusText: res.statusText, headers: outHeaders };
    if (req.responseType === 'binary') return { ...base, binary: new Uint8Array(await res.arrayBuffer()) };
    return { ...base, text: await res.text() };
  } finally {
    clearTimeout(timer);
  }
}

export interface StreamHandlers {
  onChunk: (text: string) => void;
}

export interface StreamHandle {
  start: HttpStreamStart;
  done: Promise<void>;
  abort: () => void;
}

// One global listener dispatches IPC stream events to per-request handlers.
const streamHandlers = new Map<string, { onChunk: (t: string) => void; onEnd: () => void; onError: (m: string) => void }>();
let listenerInstalled = false;

function installListener(): void {
  if (listenerInstalled) return;
  const api = bridge();
  if (!api) return;
  listenerInstalled = true;
  api.http.onStreamEvent((event: HttpStreamEvent) => {
    const h = streamHandlers.get(event.id);
    if (!h) return;
    if (event.type === 'chunk') h.onChunk(event.text);
    else if (event.type === 'end') {
      streamHandlers.delete(event.id);
      h.onEnd();
    } else {
      streamHandlers.delete(event.id);
      h.onError(event.message);
    }
  });
}

/**
 * Streaming HTTP request. Resolves once headers are received; `done` resolves when the body ends.
 * Text chunks are delivered incrementally (SSE parsing is up to the caller).
 */
export async function httpStream(req: HttpProxyRequest, handlers: StreamHandlers): Promise<StreamHandle> {
  const api = bridge();
  if (api) {
    installListener();
    const id = uid('stream');
    let resolveDone!: () => void;
    let rejectDone!: (err: Error) => void;
    const done = new Promise<void>((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });
    streamHandlers.set(id, {
      onChunk: handlers.onChunk,
      onEnd: () => resolveDone(),
      onError: (message) => rejectDone(new Error(message))
    });
    let start: HttpStreamStart;
    try {
      start = await api.http.streamStart(id, req);
    } catch (err) {
      streamHandlers.delete(id);
      throw err;
    }
    return { start, done, abort: () => api.http.streamAbort(id) };
  }

  // Browser fallback (Vite dev in a normal browser)
  const controller = new AbortController();
  const res = await fetch(req.url, {
    method: req.method ?? 'GET',
    headers: req.headers,
    body: req.body,
    signal: controller.signal
  });
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
  const start: HttpStreamStart = { id: uid('stream'), ok: res.ok, status: res.status, statusText: res.statusText, headers };
  const done = (async () => {
    if (!res.body) return;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done: finished, value } = await reader.read();
      if (finished) break;
      handlers.onChunk(decoder.decode(value, { stream: true }));
    }
    const tail = decoder.decode();
    if (tail) handlers.onChunk(tail);
  })();
  return { start, done, abort: () => controller.abort() };
}

