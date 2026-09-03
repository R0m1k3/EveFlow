/**
 * Conversation orchestrator: sends user input to Hermes through the resolved transport,
 * streams the answer into the chat store (coalesced per animation frame), drives the HUD
 * state, speaks the reply and surfaces approvals / clarifications as pending requests.
 */
import type { HermesPushEvent } from '../../shared/ipc';
import { Log } from '../lib/log';
import { previewText } from '../lib/text';
import { useChat, type PendingRequest } from '../state/chat';
import { useHermes } from '../state/hermes';
import { useSettings } from '../state/settings';
import { executeLocalTool, LOCAL_TOOL_DEFINITIONS } from './hermes/localTools';
import type { HermesStreamEvent, SendHandle } from './hermes/types';
import { speech } from './voice/speech';
import { bridge } from '../lib/bridge';
import { parseLocalIntent, runLocalIntent } from './localCommands';

let active: SendHandle | null = null;
let activeMessageId: string | null = null;

const toolLabel = (name: string) => name.replace(/_/g, ' ');

// ── delta coalescing: one store update per animation frame ─────────────────
const pendingDelta = { id: '', content: '', reasoning: '', raf: 0 };

function flushDelta(): void {
  if (pendingDelta.raf) cancelAnimationFrame(pendingDelta.raf);
  const { id, content, reasoning } = pendingDelta;
  pendingDelta.id = '';
  pendingDelta.content = '';
  pendingDelta.reasoning = '';
  pendingDelta.raf = 0;
  if (!id) return;
  const chat = useChat.getState();
  if (content) chat.appendToMessage(id, content);
  if (reasoning) chat.appendToMessage(id, reasoning, 'reasoning');
}

function queueDelta(id: string, text: string, field: 'content' | 'reasoning'): void {
  if (pendingDelta.id && pendingDelta.id !== id) flushDelta();
  pendingDelta.id = id;
  pendingDelta[field] += text;
  if (!pendingDelta.raf) pendingDelta.raf = requestAnimationFrame(flushDelta);
}

/** Bumps a counter the core reads to flash briefly (send, tool start, speech start). */
export function pingCore(): void {
  useChat.getState().ping();
}

function localToolContext() {
  const chat = useChat.getState();
  const settings = useSettings.getState().settings;
  return {
    setEmotion: (state: string) => {
      const map: Record<string, Parameters<typeof chat.setHudOverride>[0]> = {
        happy: 'success', success: 'success', thinking: 'thinking', alert: 'alert', error: 'error', neutral: null
      };
      chat.setHudOverride(map[state] ?? null);
      setTimeout(() => useChat.getState().setHudOverride(null), 6000);
    },
    speak: (text: string) => speech.say(text),
    getStatus: () => ({
      transport: useHermes.getState().transport,
      link: useHermes.getState().link,
      assistant: settings.assistantName,
      messages: chat.messages.length,
      speaking: speech.isSpeaking(),
      handsFree: settings.voice.handsFree
    }),
    getHistory: (n: number) => chat.messages.slice(-n).map((m) => ({ role: m.role, content: m.content })),
    notify: (title: string, body: string) => {
      try {
        if (Notification.permission === 'granted') new Notification(title, { body });
      } catch {
        /* notifications unavailable */
      }
    }
  };
}

function handleEvent(event: HermesStreamEvent, messageId: string, runIdRef: { id: string | null }, timing: { firstToken: number | null; startedAt: number }): void {
  const chat = useChat.getState();
  switch (event.kind) {
    case 'run.started':
      runIdRef.id = event.runId;
      chat.setSending(true, event.runId);
      break;
    case 'delta':
      if (timing.firstToken === null) {
        timing.firstToken = Date.now() - timing.startedAt;
        chat.setLatency(timing.firstToken);
      }
      queueDelta(messageId, event.text, 'content');
      speech.pushStream(event.text);
      break;
    case 'reasoning':
      queueDelta(messageId, event.text, 'reasoning');
      break;
    case 'tool.start':
      chat.pushActivity({ id: event.id, kind: 'tool', name: event.name, status: 'running', detail: event.args ? previewText(event.args, 160) : undefined });
      chat.setHud('thinking');
      pingCore();
      break;
    case 'tool.progress':
      if (!chat.activity.some((a) => (event.id && a.id === event.id) || (a.name === event.name && a.status === 'running'))) {
        chat.pushActivity({ id: event.id, kind: 'tool', name: event.name, status: 'running', detail: event.label ?? event.detail });
      }
      break;
    case 'tool.end':
      chat.finishActivity({ id: event.id || undefined, name: event.name }, {
        status: event.ok ? 'done' : 'error',
        output: event.output ? previewText(event.output, 400) : undefined
      });
      break;
    case 'subagent.start':
      chat.pushActivity({ id: event.id, kind: 'subagent', name: event.label ?? 'sous-agent', status: 'running', detail: event.childSessionId });
      break;
    case 'subagent.end':
      chat.finishActivity({ id: event.id }, { status: event.status.includes('fail') ? 'error' : 'done', output: event.summary });
      break;
    case 'approval.request':
      addPending({
        requestId: event.requestId,
        runId: runIdRef.id ?? '',
        kind: 'approval',
        title: 'Autorisation requise',
        description: event.description,
        options: event.options,
        tool: event.tool,
        args: event.args
      });
      break;
    case 'clarify.request':
      addPending({ requestId: event.requestId, runId: runIdRef.id ?? '', kind: 'clarify', title: 'Précision demandée', description: event.question, options: event.options });
      break;
    case 'input.request':
      addPending({ requestId: event.requestId, runId: runIdRef.id ?? '', kind: 'input', title: event.variant === 'sudo' ? 'Mot de passe sudo' : 'Secret requis', description: event.prompt, secret: true });
      break;
    case 'request.expire':
      chat.removePending(event.requestId);
      break;
    case 'session':
      if (event.sessionId && event.sessionId !== useSettings.getState().settings.hermesSessionId) {
        useSettings.getState().setHermesSessionId(event.sessionId);
        Log.info('hermes', `session id updated: ${event.sessionId}`);
      }
      break;
    case 'completed':
      if (event.usage) chat.updateMessage(messageId, { usage: event.usage });
      if (event.status === 'length') chat.updateMessage(messageId, { status: 'cancelled' });
      break;
    case 'error':
      chat.setError(event.message);
      break;
    case 'raw':
      Log.debug('hermes', `event ${event.event}`, event.data);
      break;
  }
}

function addPending(request: Omit<PendingRequest, 'id' | 'createdAt'>): void {
  const chat = useChat.getState();
  chat.addPending(request);
  chat.setHud('alert');
  // Spoken without interrupting the streamed answer.
  speech.say(request.kind === 'approval' ? 'Autorisation requise.' : request.kind === 'clarify' ? request.description : 'Saisie requise.', { interrupt: false });
}

/** Screenshot of the primary display as a data URL (Electron only). */
export async function captureScreen(): Promise<string | null> {
  const api = bridge();
  if (!api) return null;
  try {
    return await api.system.captureScreen(1600);
  } catch (err) {
    useChat.getState().setError(`Capture d’écran : ${(err as Error).message}`);
    return null;
  }
}

/** Short system intents handled on the machine without a Hermes round trip. Returns true when consumed. */
async function tryLocalIntent(text: string, source: string): Promise<{ handled: boolean; images?: string[]; text?: string }> {
  const settings = useSettings.getState().settings;
  if (!settings.voice.localCommands || !bridge()) return { handled: false };
  const intent = parseLocalIntent(text);
  if (!intent) return { handled: false };
  if (intent.kind === 'screenshot') {
    const shot = await captureScreen();
    if (!shot) return { handled: false };
    return { handled: false, images: [shot], text: intent.question || text };
  }
  const chat = useChat.getState();
  chat.addMessage({ role: 'user', content: text, source, status: 'done' });
  const result = await runLocalIntent(intent);
  chat.addMessage({ role: 'assistant', content: result.message, source: 'local', status: result.ok ? 'done' : 'error' });
  chat.setHud(result.ok ? 'idle' : 'error');
  if (settings.speech.autoSpeak) speech.say(result.message, { interrupt: true });
  return { handled: true };
}

export async function sendMessage(text: string, images: string[] = [], source = 'eveflow'): Promise<void> {
  let trimmed = text.trim();
  if ((!trimmed && images.length === 0) || active) return;
  if (trimmed && images.length === 0) {
    const local = await tryLocalIntent(trimmed, source);
    if (local.handled) return;
    if (local.images) {
      images = local.images;
      trimmed = (local.text ?? trimmed).trim();
    }
  }
  const chat = useChat.getState();
  const hermes = useHermes.getState();
  const settings = useSettings.getState().settings;

  speech.stop();
  chat.setError(null);
  chat.setLatency(null);
  chat.addMessage({ role: 'user', content: trimmed || '(image)', images: images.length ? images : undefined, source, status: 'done' });
  const history = chat.messages
    .filter((m) => m.role !== 'system' && m.status !== 'error')
    .slice(-12)
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));
  const messageId = chat.addMessage({ role: 'assistant', content: '', status: 'streaming', transport: hermes.transport });
  activeMessageId = messageId;
  chat.setSending(true);
  chat.setHud('thinking');
  pingCore();
  const startedAt = Date.now();
  const timing = { firstToken: null as number | null, startedAt };
  const runIdRef = { id: null as string | null };

  const client = hermes.client();
  const handle = client.send(
    {
      text: trimmed || 'Analyse cette image.',
      images,
      history,
      sessionId: settings.hermesSessionId,
      onEvent: (event) => handleEvent(event, messageId, runIdRef, timing),
      localToolDefinitions: LOCAL_TOOL_DEFINITIONS,
      localToolExecutor: (name, args) => executeLocalTool(name, args, localToolContext())
    },
    hermes.transport
  );
  active = handle;
  chat.updateMessage(messageId, { transport: handle.transport });

  try {
    const reply = await handle.result;
    flushDelta();
    const state = useChat.getState();
    const current = state.messages.find((m) => m.id === messageId);
    const streamedText = current?.content ?? '';
    const finalText = handle.aborted ? streamedText : reply || streamedText;
    const truncated = current?.status === 'cancelled';
    state.updateMessage(messageId, { content: finalText || (handle.aborted ? '(interrompu)' : ''), status: handle.aborted || truncated ? 'cancelled' : 'done' });
    if (handle.aborted) {
      speech.discardStream();
    } else if (settings.speech.autoSpeak) {
      if (!streamedText && finalText) speech.say(finalText);
      else speech.endStream();
    } else {
      speech.discardStream();
    }
    state.setHud(speech.isSpeaking() ? 'speaking' : 'idle');
    if (!handle.aborted && useHermes.getState().link === 'offline') useHermes.getState().connect().catch(() => undefined);
    Log.info('hermes', `${handle.aborted ? 'aborted' : 'reply'} in ${Date.now() - startedAt} ms via ${handle.transport}`, { chars: finalText.length, firstToken: timing.firstToken });
  } catch (err) {
    flushDelta();
    const message = (err as Error).message || String(err);
    const partial = useChat.getState().messages.find((m) => m.id === messageId)?.content ?? '';
    useChat.getState().updateMessage(messageId, {
      content: partial || `Liaison Hermes interrompue : ${message}`,
      status: partial ? 'cancelled' : 'error'
    });
    useChat.getState().setError(message);
    useChat.getState().setHud('error');
    speech.discardStream();
    Log.error('hermes', `send failed: ${message}`);
    if (/HTTP|ECONNREFUSED|fetch|réseau|network/i.test(message)) useHermes.getState().connect().catch(() => undefined);
    setTimeout(() => {
      if (useChat.getState().hud === 'error') useChat.getState().setHud('idle');
    }, 4000);
  } finally {
    active = null;
    activeMessageId = null;
    const state = useChat.getState();
    state.setSending(false);
    state.setLatency(null);
    for (const a of state.activity) {
      if (a.status === 'running') state.finishActivity({ id: a.id }, { status: 'done' });
    }
    // Requests bound to this run cannot be answered once it is over.
    for (const p of state.pending) if (!runIdRef.id || p.runId === runIdRef.id) state.removePending(p.id);
  }
}

export function stopGeneration(): void {
  if (active) {
    active.abort();
    Log.info('hermes', 'generation aborted by user');
  }
  speech.stop();
  if (activeMessageId) useChat.getState().updateMessage(activeMessageId, { status: 'cancelled' });
  useChat.getState().setHud('idle');
}

export async function steer(text: string): Promise<boolean> {
  const runId = useChat.getState().currentRunId;
  if (!runId || !text.trim()) return false;
  try {
    await useHermes.getState().client().steerRun(runId, text.trim());
    useChat.getState().addMessage({ role: 'system', content: `Consigne transmise à Hermes : ${text.trim()}`, status: 'done' });
    return true;
  } catch (err) {
    useChat.getState().setError(`Steer impossible : ${(err as Error).message}`);
    return false;
  }
}

export async function resolvePending(request: PendingRequest, decision: string): Promise<void> {
  const chat = useChat.getState();
  chat.removePending(request.id);
  const client = useHermes.getState().client();
  try {
    if (!request.runId) throw new Error('run inconnu');
    if (request.kind === 'approval') {
      const choice = (['once', 'session', 'always', 'deny'].includes(decision) ? decision : decision === 'approve' ? 'once' : 'deny') as 'once' | 'session' | 'always' | 'deny';
      await client.approveRun(request.runId, choice, request.requestId || undefined);
      chat.addMessage({ role: 'system', content: `Autorisation ${choice === 'deny' ? 'refusée' : 'accordée'}${request.tool ? ` (${toolLabel(request.tool)})` : ''}.`, status: 'done' });
    } else {
      // Clarifications and secrets are answered by steering the run with the reply.
      await client.steerRun(request.runId, decision);
      chat.addMessage({ role: 'system', content: request.secret ? 'Saisie transmise à Hermes.' : `Réponse transmise : ${decision}`, status: 'done' });
    }
    chat.setHud(useChat.getState().isSending ? 'thinking' : 'idle');
  } catch (err) {
    chat.setError(`Réponse impossible : ${(err as Error).message}`);
  }
}

/** Incoming webhook pushes (Telegram mirror, cron deliveries…). */
export function handlePush(event: HermesPushEvent): void {
  const chat = useChat.getState();
  const settings = useSettings.getState().settings;
  if (event.type === 'raw') {
    Log.debug('webhook', 'raw push', event.raw);
    chat.pushActivity({ kind: 'system', name: `webhook ${event.source}`, status: 'done', detail: previewText(event.text, 200) });
    return;
  }
  if (!event.text.trim() && !event.images?.length) return;
  chat.addMessage({
    role: event.role === 'user' ? 'user' : 'assistant',
    content: event.text,
    images: event.images,
    source: event.source,
    jobName: event.jobName,
    status: 'done'
  });
  if (event.type === 'job') {
    chat.pushActivity({ kind: 'job', name: event.jobName || 'cron', status: event.status?.includes('fail') ? 'error' : 'done', detail: previewText(event.text, 160) });
    void useHermes.getState().refreshJobs();
  }
  if (event.role !== 'user' && settings.speech.speakIncoming) {
    speech.say(event.jobName ? `Résultat de ${event.jobName}. ${event.text}` : event.text);
  }
  chat.setHud(event.status?.includes('fail') ? 'alert' : 'success');
  pingCore();
  setTimeout(() => {
    const s = useChat.getState();
    if (s.hud === 'success' || s.hud === 'alert') s.setHud(speech.isSpeaking() ? 'speaking' : 'idle');
  }, 3000);
}
