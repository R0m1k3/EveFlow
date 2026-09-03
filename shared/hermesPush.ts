import type { HermesPushEvent } from './ipc';

type AnyRecord = Record<string, unknown>;

const isRecord = (v: unknown): v is AnyRecord => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));

function collectImages(obj: AnyRecord | undefined): string[] {
  if (!obj) return [];
  const images: string[] = [];
  const push = (value: unknown) => {
    if (!value) return;
    if (typeof value === 'string') {
      if (/^(https?:\/\/|data:image\/|file:\/\/|[a-zA-Z]:\\|\/)/.test(value)) images.push(value);
    } else if (isRecord(value)) {
      push(value.url ?? value.href ?? value.path ?? value.file ?? value.file_url ?? value.media_url);
    }
  };
  for (const key of ['image', 'image_url', 'photo', 'media', 'file', 'file_url', 'media_url']) push(obj[key]);
  for (const key of ['images', 'photos', 'media_urls', 'attachments', 'files']) {
    const value = obj[key];
    if (Array.isArray(value)) value.forEach(push);
    else push(value);
  }
  return [...new Set(images)];
}

function role(value: unknown): HermesPushEvent['role'] {
  const r = str(value).toLowerCase();
  if (r === 'user' || r === 'human') return 'user';
  if (r === 'system') return 'system';
  return 'assistant';
}

/**
 * Normalise any payload pushed to the local EveFlow webhook into a list of events.
 * Accepts the historical EveFlow formats plus Hermes cron/gateway delivery shapes.
 */
export function normalizeHermesPush(raw: unknown, receivedAt = new Date().toISOString()): HermesPushEvent[] {
  if (!isRecord(raw)) {
    return [{ type: 'raw', role: 'system', text: str(raw), source: 'webhook', receivedAt, raw }];
  }
  const source = str(raw.platform ?? raw.source ?? raw.channel ?? 'webhook') || 'webhook';
  const withImages = (event: HermesPushEvent, obj: AnyRecord | undefined): HermesPushEvent => {
    const images = collectImages(obj);
    return images.length ? { ...event, images } : event;
  };

  // Batched: { events: [...] }
  if (Array.isArray(raw.events)) {
    return raw.events.flatMap((e) => normalizeHermesPush(e, receivedAt));
  }

  // Format A: { type:'message', payload:{ text, role?, platform? } }
  if (raw.type === 'message' && isRecord(raw.payload) && raw.payload.text) {
    const payload = raw.payload;
    return [withImages({
      type: 'message',
      role: role(payload.role),
      text: str(payload.text),
      source: str(payload.platform ?? source),
      receivedAt
    }, payload)];
  }

  // Cron job delivery: { event:'job.completed'|'cron', job|name, output|result, status }
  const eventName = str(raw.event ?? raw.type).toLowerCase();
  if (eventName.startsWith('job') || eventName.startsWith('cron') || raw.job_id || raw.job) {
    const job = isRecord(raw.job) ? raw.job : raw;
    const output = str(raw.output ?? raw.result ?? raw.text ?? job.output ?? job.last_output ?? '');
    return [withImages({
      type: 'job',
      role: 'assistant',
      text: output,
      source: source === 'webhook' ? 'cron' : source,
      jobName: str(job.name ?? raw.name ?? raw.job_name ?? raw.job_id ?? ''),
      status: str(raw.status ?? job.last_status ?? job.status ?? ''),
      receivedAt
    }, raw)];
  }

  // Run completed: { event:'run.completed', input?, output }
  if ((eventName === 'run.completed' || eventName === 'run.complete') && raw.output) {
    const events: HermesPushEvent[] = [];
    if (raw.input) events.push({ type: 'message', role: 'user', text: str(raw.input), source, receivedAt });
    events.push(withImages({ type: 'message', role: 'assistant', text: str(raw.output), source, receivedAt }, raw));
    return events;
  }

  // Direct: { role, text|content|message }
  const text = raw.text ?? raw.content ?? raw.message ?? raw.output;
  if (raw.role && text) {
    return [withImages({ type: 'message', role: role(raw.role), text: str(text), source, receivedAt }, raw)];
  }

  // Legacy: { type:'user_message'|'assistant_message', text }
  if (text && typeof raw.type === 'string') {
    return [withImages({
      type: 'message',
      role: raw.type.includes('user') ? 'user' : 'assistant',
      text: str(text),
      source,
      receivedAt
    }, raw)];
  }

  if (text) {
    return [withImages({ type: 'message', role: 'assistant', text: str(text), source, receivedAt }, raw)];
  }

  return [{ type: 'raw', role: 'system', text: JSON.stringify(raw), source, receivedAt, raw }];
}
