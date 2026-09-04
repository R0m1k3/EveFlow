/**
 * Full Hermes Agent API client: discovery, runs (SSE lifecycle + approvals + steering),
 * sessions (server-side memory), OpenAI-compatible chat completions (with EveFlow tools)
 * and the cron jobs REST API.
 */
import { Log } from '../../lib/log';
import { SseParser, tryParseJson } from '../../lib/sse';
import { httpFetch, httpStream, HttpError, type StreamHandle } from '../../lib/transport';
import { normalizeCompletionChunk, normalizeLifecycleEvent, type CompletionToolCallAccumulator } from './events';
import type {
  HermesCapabilities,
  HermesChatMessage,
  HermesConfig,
  HermesHealth,
  HermesJob,
  HermesJobDraft,
  HermesModel,
  HermesRunInfo,
  HermesSession,
  HermesSessionMessage,
  HermesSkill,
  HermesStreamEvent,
  HermesToolset,
  HermesTransport,
  SendHandle,
  SendOptions
} from './types';

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => !!v && typeof v === 'object' && !Array.isArray(v);

export type ResolvedTransport = Exclude<HermesTransport, 'auto'>;

/**
 * A web page (login portal, dashboard, reverse-proxy error) instead of JSON means the URL does not
 * point at the Hermes API. Returns a human explanation, or null when the body is not HTML.
 */
export function describeHtml(body: string): string | null {
  const head = body.slice(0, 600).trimStart().toLowerCase();
  if (!head.startsWith('<!doctype html') && !head.startsWith('<html') && !/^<\?xml[^>]*>\s*<html/.test(head)) return null;
  const title = /<title[^>]*>([^<]{1,120})<\/title>/i.exec(body)?.[1]?.trim();
  const login = /connecter|login|sign in|authentif|mot de passe|password/i.test(body.slice(0, 20_000));
  return `Le serveur renvoie une page web${title ? ` « ${title} »` : ''} au lieu de l'API Hermes${login ? ' (page de connexion : l’URL passe par un portail web)' : ''}. Utilisez l'URL directe du serveur API Hermes (port 8642 par défaut, ou le chemin /v1 exposé par votre proxy).`;
}

/** Candidate API URLs derived from what the user typed (same host, other port or path). */
export function hermesUrlCandidates(url: string): string[] {
  const base = hermesBaseUrl(url);
  if (!base) return [];
  const out = new Set<string>();
  const add = (u: string) => out.add(u.replace(/\/+$/, ''));
  try {
    const u = new URL(base.includes('://') ? base : `http://${base}`);
    const host = u.hostname;
    const scheme = u.protocol.replace(':', '');
    const path = u.pathname.replace(/\/+$/, '');
    if (path) add(`${scheme}://${u.host}`);
    for (const suffix of ['/api', '/hermes', '/hermes/api', '/v1', '/api/v1']) add(`${scheme}://${u.host}${path}${suffix}`);
    if (!u.port) {
      add(`${scheme}://${host}:8642`);
      add(`http://${host}:8642`);
      add(`https://${host}:8642`);
    }
    for (const sub of ['api', 'hermes-api']) {
      if (!host.startsWith(`${sub}.`) && host.includes('.')) add(`${scheme}://${sub}.${host}`);
    }
    if (host.startsWith('jarvis.')) add(`${scheme}://hermes.${host.slice('jarvis.'.length)}`);
  } catch {
    return [];
  }
  out.delete(base);
  return [...out];
}

/** Probe candidate URLs until one answers Hermes JSON on /health or /v1/capabilities. */
export async function discoverHermesUrl(config: HermesConfig, onProgress?: (url: string) => void): Promise<string | null> {
  for (const candidate of hermesUrlCandidates(config.url)) {
    onProgress?.(candidate);
    const client = new HermesClient({ ...config, url: candidate });
    try {
      await client.request<unknown>('/health', { timeoutMs: 4000 });
      return candidate;
    } catch (err) {
      if (err instanceof HttpError && (err.status === 401 || err.status === 403)) return candidate; // API found, key missing
      continue;
    }
  }
  return null;
}

export function hermesBaseUrl(url: string): string {
  let base = url.trim().replace(/\/+$/, '');
  base = base.replace(/\/chat\/completions$/, '');
  base = base.replace(/\/v1$/, '');
  return base;
}

function extractArray<T>(payload: unknown, keys: string[]): T[] {
  if (Array.isArray(payload)) return payload as T[];
  if (isRec(payload)) {
    for (const key of keys) {
      const value = payload[key];
      if (Array.isArray(value)) return value as T[];
    }
    if (isRec(payload.data)) return extractArray<T>(payload.data, keys);
  }
  return [];
}

function errorMessage(status: number, body: string): string {
  const parsed = tryParseJson<Rec>(body);
  if (parsed) {
    const err = parsed.error;
    if (isRec(err) && typeof err.message === 'string') return err.message;
    if (typeof err === 'string') return err;
    for (const key of ['message', 'detail', 'error_description']) {
      if (typeof parsed[key] === 'string') return parsed[key] as string;
    }
  }
  const text = body.trim().slice(0, 240);
  if (status === 401 || status === 403) return `Authentification refusée (HTTP ${status}). Vérifiez la clé API_SERVER_KEY.`;
  if (status === 404) return `Endpoint introuvable (HTTP 404)${text ? ` : ${text}` : ''}`;
  if (status === 429) return 'Hermes est saturé (HTTP 429, max_concurrent_runs atteint).';
  return `HTTP ${status}${text ? ` : ${text}` : ''}`;
}

export function resolveTransport(config: HermesConfig, caps: HermesCapabilities | null): ResolvedTransport {
  if (config.transport !== 'auto') return config.transport;
  if (!caps) return 'completions';
  const features = caps.features ?? {};
  const endpoints = caps.endpoints ?? {};
  if (features.run_submission && features.run_events_sse) return 'runs';
  if (endpoints.session_chat) return 'sessions';
  return 'completions';
}

export class HermesClient {
  constructor(private readonly config: HermesConfig) {}

  get base(): string {
    return hermesBaseUrl(this.config.url);
  }

  private headers(extra: Record<string, string> = {}, json = true): Record<string, string> {
    const h: Record<string, string> = { ...extra };
    if (json) h['Content-Type'] = 'application/json';
    h.Accept = h.Accept ?? 'application/json';
    if (this.config.apiKey.trim()) h.Authorization = `Bearer ${this.config.apiKey.trim()}`;
    if (this.config.sessionKey.trim()) h['X-Hermes-Session-Key'] = this.config.sessionKey.trim().slice(0, 256);
    return h;
  }

  async request<T>(path: string, init: { method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'; body?: unknown; timeoutMs?: number } = {}): Promise<T> {
    if (!this.config.url.trim()) throw new Error("URL Hermes non configurée.");
    const url = `${this.base}${path}`;
    const res = await httpFetch({
      url,
      method: init.method ?? 'GET',
      headers: this.headers(),
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      timeoutMs: init.timeoutMs ?? 20_000
    });
    const text = res.text ?? '';
    const html = describeHtml(text);
    if (html) throw new HttpError(res.status, html, text);
    if (!res.ok) throw new HttpError(res.status, errorMessage(res.status, res.text ?? ''), res.text);
    if (!text.trim()) return null as T;
    const parsed = tryParseJson<T>(text);
    if (parsed === null) throw new Error(`Réponse Hermes illisible depuis ${path} : ${text.slice(0, 120).replace(/\s+/g, ' ')}`);
    return parsed;
  }

  // ── Discovery ─────────────────────────────────────────────────────────────

  capabilities(): Promise<HermesCapabilities> {
    return this.request<HermesCapabilities>('/v1/capabilities');
  }

  async health(): Promise<HermesHealth> {
    try {
      return await this.request<HermesHealth>('/health/detailed', { timeoutMs: 8000 });
    } catch (err) {
      if (err instanceof HttpError && (err.status === 401 || err.status === 403)) throw err;
      const basic = await this.request<HermesHealth | Rec>('/health', { timeoutMs: 8000 });
      return { status: 'ok', ...(isRec(basic) ? basic : {}) } as HermesHealth;
    }
  }

  async models(): Promise<HermesModel[]> {
    const payload = await this.request<unknown>('/v1/models');
    return extractArray<HermesModel>(payload, ['data', 'models']);
  }

  async skills(): Promise<HermesSkill[]> {
    const payload = await this.request<unknown>('/v1/skills');
    return extractArray<HermesSkill>(payload, ['skills', 'data', 'items']);
  }

  async toolsets(): Promise<HermesToolset[]> {
    const payload = await this.request<unknown>('/v1/toolsets');
    return extractArray<HermesToolset>(payload, ['toolsets', 'data', 'items']);
  }

  // ── Sessions ──────────────────────────────────────────────────────────────

  async listSessions(limit = 40): Promise<HermesSession[]> {
    const payload = await this.request<unknown>(`/api/sessions?limit=${limit}`);
    return extractArray<HermesSession>(payload, ['sessions', 'items', 'data', 'results']);
  }

  async createSession(title?: string): Promise<HermesSession> {
    const payload = await this.request<unknown>('/api/sessions', { method: 'POST', body: title ? { title } : {} });
    if (isRec(payload) && isRec(payload.session)) return payload.session as HermesSession;
    return payload as HermesSession;
  }

  getSession(id: string): Promise<HermesSession> {
    return this.request<HermesSession>(`/api/sessions/${encodeURIComponent(id)}`);
  }

  async sessionMessages(id: string): Promise<HermesSessionMessage[]> {
    const payload = await this.request<unknown>(`/api/sessions/${encodeURIComponent(id)}/messages`);
    return extractArray<HermesSessionMessage>(payload, ['messages', 'items', 'data']);
  }

  updateSession(id: string, patch: { title?: string; end_reason?: string }): Promise<HermesSession> {
    return this.request<HermesSession>(`/api/sessions/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch });
  }

  deleteSession(id: string): Promise<void> {
    return this.request<void>(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  async forkSession(id: string): Promise<HermesSession> {
    const payload = await this.request<unknown>(`/api/sessions/${encodeURIComponent(id)}/fork`, { method: 'POST', body: {} });
    if (isRec(payload) && isRec(payload.session)) return payload.session as HermesSession;
    return payload as HermesSession;
  }

  // ── Jobs (cron) ───────────────────────────────────────────────────────────

  async listJobs(): Promise<HermesJob[]> {
    const payload = await this.request<unknown>('/api/jobs');
    return extractArray<HermesJob>(payload, ['jobs', 'items', 'data']).map(normalizeJob);
  }

  private unwrapJob(payload: unknown): HermesJob {
    if (isRec(payload) && isRec(payload.job)) return normalizeJob(payload.job as HermesJob);
    return normalizeJob(payload as HermesJob);
  }

  async createJob(draft: HermesJobDraft): Promise<HermesJob> {
    const body: Rec = { name: draft.name, schedule: draft.schedule, prompt: draft.prompt };
    if (draft.deliver) body.deliver = draft.deliver;
    if (draft.skills?.length) body.skills = draft.skills;
    return this.unwrapJob(await this.request<unknown>('/api/jobs', { method: 'POST', body }));
  }

  async updateJob(id: string, patch: Partial<HermesJobDraft>): Promise<HermesJob> {
    return this.unwrapJob(await this.request<unknown>(`/api/jobs/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch }));
  }

  deleteJob(id: string): Promise<void> {
    return this.request<void>(`/api/jobs/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  async pauseJob(id: string): Promise<HermesJob> {
    return this.unwrapJob(await this.request<unknown>(`/api/jobs/${encodeURIComponent(id)}/pause`, { method: 'POST', body: {} }));
  }

  async resumeJob(id: string): Promise<HermesJob> {
    return this.unwrapJob(await this.request<unknown>(`/api/jobs/${encodeURIComponent(id)}/resume`, { method: 'POST', body: {} }));
  }

  async runJob(id: string): Promise<HermesJob> {
    return this.unwrapJob(await this.request<unknown>(`/api/jobs/${encodeURIComponent(id)}/run`, { method: 'POST', body: {}, timeoutMs: 30_000 }));
  }

  // ── Runs ──────────────────────────────────────────────────────────────────

  async startRun(body: { input: string; session_id?: string; instructions?: string; model?: string }): Promise<{ run_id: string; status: string }> {
    const payload: Rec = { input: body.input };
    if (body.session_id) payload.session_id = body.session_id;
    if (body.instructions) payload.instructions = body.instructions;
    if (body.model) payload.model = body.model;
    return this.request<{ run_id: string; status: string }>('/v1/runs', { method: 'POST', body: payload, timeoutMs: 30_000 });
  }

  getRun(runId: string): Promise<HermesRunInfo> {
    return this.request<HermesRunInfo>(`/v1/runs/${encodeURIComponent(runId)}`);
  }

  stopRun(runId: string): Promise<unknown> {
    return this.request<unknown>(`/v1/runs/${encodeURIComponent(runId)}/stop`, { method: 'POST', body: {} });
  }

  steerRun(runId: string, text: string): Promise<unknown> {
    return this.request<unknown>(`/v1/runs/${encodeURIComponent(runId)}/steer`, { method: 'POST', body: { input: text } });
  }

  approveRun(runId: string, choice: 'once' | 'session' | 'always' | 'deny', requestId?: string): Promise<unknown> {
    const body: Rec = { choice };
    if (requestId) body.request_id = requestId;
    return this.request<unknown>(`/v1/runs/${encodeURIComponent(runId)}/approval`, { method: 'POST', body });
  }

  /** Subscribe to the lifecycle stream of a run. */
  async streamRunEvents(runId: string, onEvent: (event: HermesStreamEvent) => void): Promise<StreamHandle> {
    return this.openSse(`/v1/runs/${encodeURIComponent(runId)}/events`, { method: 'GET' }, onEvent);
  }

  private async openSse(
    path: string,
    init: { method: 'GET' | 'POST'; body?: unknown },
    onEvent: (event: HermesStreamEvent) => void
  ): Promise<StreamHandle> {
    const parser = new SseParser((message) => {
      const data = tryParseJson<unknown>(message.data) ?? message.data;
      const eventName = message.event !== 'message' ? message.event : isRec(data) && typeof data.event === 'string' ? data.event : 'message';
      for (const event of normalizeLifecycleEvent(eventName, data)) onEvent(event);
    });
    const errorChunks: string[] = [];
    let handleReady = false;
    const handle = await httpStream(
      {
        url: `${this.base}${path}`,
        method: init.method,
        headers: this.headers({ Accept: 'text/event-stream' }, init.body !== undefined),
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        timeoutMs: 15 * 60_000
      },
      { onChunk: (text) => (handleReady ? parser.feed(text) : errorChunks.push(text)) }
    );
    if (!handle.start.ok) {
      await handle.done.catch(() => undefined);
      throw new HttpError(handle.start.status, errorMessage(handle.start.status, errorChunks.join('')));
    }
    handleReady = true;
    const done = handle.done.then(() => parser.end());
    return { ...handle, done };
  }

  // ── Unified send ──────────────────────────────────────────────────────────

  send(options: SendOptions, transport: ResolvedTransport): SendHandle {
    const effective: ResolvedTransport = options.images?.length && transport === 'runs' ? 'completions' : transport;
    let aborted = false;
    let abortImpl: () => void = () => undefined;
    const setAbort = (fn: () => void) => {
      abortImpl = fn;
      if (aborted) fn();
    };
    const isAborted = () => aborted;
    const result =
      effective === 'runs'
        ? this.sendViaRuns(options, setAbort, isAborted)
        : effective === 'sessions'
          ? this.sendViaSessions(options, setAbort, isAborted)
          : this.sendViaCompletions(options, setAbort, isAborted);
    return {
      result,
      transport: effective,
      get aborted() {
        return aborted;
      },
      abort: () => {
        aborted = true;
        abortImpl();
      }
    };
  }

  private async sendViaRuns(options: SendOptions, setAbort: (fn: () => void) => void, isAborted: () => boolean): Promise<string> {
    const { onEvent } = options;
    const run = await this.startRun({
      input: options.text,
      session_id: plainSession(options.sessionId) || undefined,
      instructions: this.config.instructions || undefined,
      model: this.config.model || undefined
    });
    const runId = run.run_id;
    if (isAborted()) {
      this.stopRun(runId).catch(() => undefined);
      return '';
    }
    onEvent({ kind: 'run.started', runId });
    Log.info('hermes', `run ${runId} started`);

    let stopped = false;
    let finalText = '';
    let streamedText = '';
    let completed = false;
    let failure: string | null = null;

    const handle = await this.streamRunEvents(runId, (event) => {
      if (event.kind === 'delta') streamedText += event.text;
      if (event.kind === 'completed' && event.status !== 'message') {
        completed = true;
        finalText = event.text ?? '';
      }
      if (event.kind === 'error') failure = event.message;
      onEvent(event);
    });
    setAbort(() => {
      stopped = true;
      handle.abort();
      this.stopRun(runId).catch(() => undefined);
    });

    await handle.done;
    if (stopped || isAborted()) return streamedText;
    if (failure) throw new Error(failure);

    if (!completed) {
      // The event buffer may have been consumed by a reconnect; fall back to polling the run status.
      for (let i = 0; i < 120 && !stopped; i++) {
        const info = await this.getRun(runId);
        if (['completed', 'failed', 'cancelled', 'canceled', 'stopped'].includes(info.status)) {
          if (info.status !== 'completed') throw new Error(String(info.error ?? `run ${info.status}`));
          finalText = info.output ?? '';
          onEvent({ kind: 'completed', text: finalText, status: info.status, usage: info.usage });
          if (info.session_id) onEvent({ kind: 'session', sessionId: info.session_id });
          break;
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    return finalText || streamedText;
  }

  private async sendViaSessions(options: SendOptions, setAbort: (fn: () => void) => void, isAborted: () => boolean): Promise<string> {
    const { onEvent } = options;
    let sessionId = options.sessionId;
    if (!sessionId || !sessionId.startsWith('hs:')) {
      const session = await this.createSession('EveFlow');
      sessionId = `hs:${session.id}`;
      onEvent({ kind: 'session', sessionId });
    }
    if (isAborted()) return '';
    const realId = sessionId.slice(3);
    const body: Rec = { input: options.text };
    if (this.config.instructions) body.instructions = this.config.instructions;
    if (this.config.model) body.model = this.config.model;

    let streamed = '';
    let finalText = '';
    let failure: string | null = null;
    const handle = await this.openSse(`/api/sessions/${encodeURIComponent(realId)}/chat/stream`, { method: 'POST', body }, (event) => {
      if (event.kind === 'delta') streamed += event.text;
      if (event.kind === 'completed' && event.text) finalText = event.text;
      if (event.kind === 'error') failure = event.message;
      if (event.kind === 'session') return; // keep our prefixed id
      onEvent(event);
    });
    setAbort(() => handle.abort());
    await handle.done;
    if (isAborted()) return streamed;
    if (failure) throw new Error(failure);
    return finalText || streamed;
  }

  private async sendViaCompletions(options: SendOptions, setAbort: (fn: () => void) => void, isAborted: () => boolean): Promise<string> {
    const { onEvent } = options;
    const useTools = this.config.localTools && !!options.localToolExecutor && !!options.localToolDefinitions?.length;
    const messages: HermesChatMessage[] = [];
    if (this.config.instructions) messages.push({ role: 'system', content: this.config.instructions });
    for (const h of options.history) messages.push({ role: h.role, content: h.content });
    const userContent: HermesChatMessage['content'] = options.images?.length
      ? [{ type: 'text', text: options.text }, ...options.images.map((url) => ({ type: 'image_url', image_url: { url } }))]
      : options.text;
    messages.push({ role: 'user', content: userContent });

    let currentHandle: StreamHandle | null = null;
    setAbort(() => currentHandle?.abort());
    const aborted = () => isAborted();

    let fullText = '';
    let toolsAllowed = useTools;
    for (let iteration = 0; iteration < 6 && !aborted(); iteration++) {
      const payload: Rec = { model: this.config.model || 'hermes-agent', messages, stream: true };
      if (toolsAllowed) {
        payload.tools = options.localToolDefinitions;
        payload.tool_choice = 'auto';
      }
      if (this.config.reasoningEffort) payload.model_options = { reasoning_effort: this.config.reasoningEffort };

      const toolCalls = new Map<number, CompletionToolCallAccumulator>();
      let finishReason: string | null = null;
      let iterationText = '';
      const errorChunks: string[] = [];
      let ready = false;
      let rawBody = '';
      const parser = new SseParser((message) => {
        if (message.data === '[DONE]') return;
        const data = tryParseJson<unknown>(message.data);
        if (data === null) return;
        if (message.event !== 'message' && !(isRec(data) && Array.isArray(data.choices))) {
          for (const event of normalizeLifecycleEvent(message.event, data)) onEvent(event);
          return;
        }
        const { events, finishReason: reason } = normalizeCompletionChunk(data, toolCalls);
        for (const event of events) {
          if (event.kind === 'delta') iterationText += event.text;
          onEvent(event);
        }
        if (reason) finishReason = reason;
      });

      const headers = this.headers({ Accept: 'text/event-stream' });
      const sessionId = plainSession(options.sessionId);
      if (sessionId) headers['X-Hermes-Session-Id'] = sessionId;
      const handle = await httpStream(
        { url: `${this.base}/v1/chat/completions`, method: 'POST', headers, body: JSON.stringify(payload), timeoutMs: 10 * 60_000 },
        {
          onChunk: (text) => {
            if (rawBody.length < 512_000) rawBody += text;
            if (ready) parser.feed(text);
            else errorChunks.push(text);
          }
        }
      );
      currentHandle = handle;
      if (!handle.start.ok) {
        await handle.done.catch(() => undefined);
        const detail = errorMessage(handle.start.status, errorChunks.join(''));
        // Some Hermes builds reject client-side tool definitions: retry once without them.
        if (toolsAllowed && handle.start.status === 400 && iteration === 0) {
          Log.warn('hermes', `chat completions rejected the tools payload (${detail}); retrying without local tools`);
          toolsAllowed = false;
          iteration--;
          continue;
        }
        throw new HttpError(handle.start.status, detail);
      }
      ready = true;
      // Chunks that raced ahead of the start event were buffered as potential error bodies: replay them.
      for (const chunk of errorChunks.splice(0)) parser.feed(chunk);
      const rotated = handle.start.headers['x-hermes-session-id'];
      if (rotated && rotated !== options.sessionId) onEvent({ kind: 'session', sessionId: rotated });

      await handle.done;
      parser.end();
      if (!iterationText && toolCalls.size === 0 && !aborted()) {
        // Nothing streamed: the server may have answered with a plain JSON completion (stream ignored)
        // or with a 200 carrying an error object. Surface it instead of an empty bubble.
        const recovered = recoverCompletion(rawBody);
        if (recovered.text) {
          iterationText = recovered.text;
          onEvent({ kind: 'delta', text: recovered.text });
        } else {
          throw new Error(recovered.error ?? `Réponse vide de Hermes (${rawBody.length} octets reçus${rawBody ? ` : ${rawBody.slice(0, 160).replace(/\s+/g, ' ')}` : ''})`);
        }
      }
      fullText += iterationText;

      if (finishReason === 'tool_calls' && toolsAllowed && toolCalls.size > 0 && !aborted()) {
        const calls = [...toolCalls.values()];
        messages.push({
          role: 'assistant',
          content: iterationText || null,
          tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } }))
        });
        for (const call of calls) {
          onEvent({ kind: 'tool.start', id: call.id, name: call.name, args: call.arguments });
          const output = await options.localToolExecutor!(call.name, call.arguments);
          onEvent({ kind: 'tool.end', id: call.id, name: call.name, output, ok: !output.includes('"error"') });
          messages.push({ role: 'tool', content: output, tool_call_id: call.id });
        }
        continue;
      }
      break;
    }
    onEvent({ kind: 'completed', status: aborted() ? 'cancelled' : 'completed', text: fullText });
    return fullText;
  }
}

/** Extract text or an error message from a non-streamed chat completion body. */
export function recoverCompletion(raw: string): { text?: string; error?: string } {
  const body = raw.trim();
  if (!body) return {};
  const html = describeHtml(body);
  if (html) return { error: html };
  const candidates = body.startsWith('data:') || body.startsWith('event:')
    ? body.split(/\n+/).filter((l) => l.startsWith('data:')).map((l) => l.replace(/^data:\s*/, '')).filter((l) => l && l !== '[DONE]')
    : [body];
  let text = '';
  for (const c of candidates) {
    const data = tryParseJson<Rec>(c);
    if (!data || !isRec(data)) continue;
    if (data.error) {
      const e = data.error as Rec | string;
      return { error: `Hermes : ${typeof e === 'string' ? e : String((e as Rec).message ?? JSON.stringify(e))}` };
    }
    const choice = Array.isArray(data.choices) && isRec(data.choices[0]) ? (data.choices[0] as Rec) : null;
    const msg = choice && isRec(choice.message) ? (choice.message as Rec) : choice && isRec(choice.delta) ? (choice.delta as Rec) : null;
    if (msg && typeof msg.content === 'string') text += msg.content;
    else if (typeof data.output === 'string') text += data.output;
    else if (typeof data.text === 'string') text += data.text;
  }
  return text ? { text } : {};
}

/** Session ids created by the sessions transport carry an `hs:` prefix; other endpoints get the bare id. */
export function plainSession(id: string): string {
  return id.startsWith('hs:') ? id.slice(3) : id;
}

export function normalizeJob(job: HermesJob): HermesJob {
  const raw = job as Rec;
  const id = String(raw.id ?? raw.job_id ?? raw.name ?? '');
  return { ...job, id };
}

export function jobStatus(job: HermesJob): string {
  if (job.state) return String(job.state);
  if (job.status) return String(job.status);
  if (job.enabled === false) return 'paused';
  return 'active';
}

export function jobSchedule(job: HermesJob): string {
  const s = job.schedule;
  if (!s) return '—';
  if (typeof s === 'string') return s;
  return s.display || s.expr || s.kind || 'schedule';
}

export function jobOutput(job: HermesJob): string {
  return String(job.last_output ?? job.last_error ?? job.output ?? job.result ?? '');
}
