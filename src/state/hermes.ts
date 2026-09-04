import { create } from 'zustand';
import type { WebhookStatus } from '../../shared/ipc';
import { Log } from '../lib/log';
import { persistGet, persistSet } from '../lib/persist';
import { HermesClient, jobOutput, jobStatus, resolveTransport, type ResolvedTransport, discoverHermesUrl } from '../services/hermes/client';
import type {
  HermesCapabilities,
  HermesHealth,
  HermesJob,
  HermesJobDraft,
  HermesModel,
  HermesSession,
  HermesSkill,
  HermesToolset
} from '../services/hermes/types';
import { useSettings } from './settings';

export type LinkState = 'unknown' | 'checking' | 'online' | 'degraded' | 'offline';

export interface JobRun {
  id: string;
  jobId: string;
  jobName: string;
  status: 'ok' | 'failed';
  output: string;
  at: string;
  read: boolean;
}

interface HermesStore {
  link: LinkState;
  linkDetail: string;
  capabilities: HermesCapabilities | null;
  health: HermesHealth | null;
  models: HermesModel[];
  skills: HermesSkill[];
  toolsets: HermesToolset[];
  sessions: HermesSession[];
  jobs: HermesJob[];
  jobRuns: JobRun[];
  /** Last cron sync failure (the chat link stays independent of it). */
  jobsError: string | null;
  /** True while probing alternative API URLs after a failed connection. */
  discovering: boolean;
  transport: ResolvedTransport;
  lastSyncAt: number | null;
  webhook: WebhookStatus | null;
  busy: boolean;

  client: (modelOverride?: string) => HermesClient;
  connect: () => Promise<void>;
  refreshJobs: () => Promise<void>;
  refreshSessions: () => Promise<void>;
  refreshCatalog: () => Promise<void>;
  refreshWebhook: () => Promise<void>;
  createJob: (draft: HermesJobDraft) => Promise<void>;
  updateJob: (id: string, patch: Partial<HermesJobDraft>) => Promise<void>;
  jobAction: (id: string, action: 'pause' | 'resume' | 'run' | 'delete') => Promise<void>;
  markRunRead: (id: string) => void;
  loadCache: () => Promise<void>;
}

const CACHE_KEY = 'eveflow.hermes.cache.v2';
let connectInflight: Promise<void> | null = null;
let lastCacheSnapshot = '';
const isTerminal = (status: string) => ['ok', 'failed', 'delivery_failed', 'completed', 'error'].includes(status.toLowerCase());

function runFromJob(job: HermesJob): JobRun | null {
  const output = jobOutput(job);
  const status = String(job.last_status ?? '').toLowerCase();
  if (!output || !job.last_run_at || !isTerminal(status || 'ok')) return null;
  const at = String(job.last_run_at);
  return {
    id: `${job.id}:${at}`,
    jobId: job.id,
    jobName: job.name || job.id,
    status: status.includes('fail') || status === 'error' ? 'failed' : 'ok',
    output,
    at,
    read: false
  };
}

export const useHermes = create<HermesStore>((set, get) => ({
  link: 'unknown',
  linkDetail: '',
  capabilities: null,
  health: null,
  models: [],
  skills: [],
  toolsets: [],
  sessions: [],
  jobs: [],
  jobRuns: [],
  jobsError: null,
  discovering: false,
  transport: 'completions',
  lastSyncAt: null,
  webhook: null,
  busy: false,

  client: (modelOverride) => {
    const config = useSettings.getState().settings.hermes;
    // Without an explicit model, use the alias advertised by /v1/models (Hermes rejects unknown names).
    const model = (modelOverride ?? '').trim() || config.model.trim() || get().models[0]?.id || '';
    return new HermesClient({ ...config, model });
  },

  connect: () => {
    if (connectInflight) return connectInflight;
    connectInflight = (async () => {
    const config = useSettings.getState().settings.hermes;
    if (!config.url.trim()) {
      set({ link: 'offline', linkDetail: 'URL Hermes non configurée' });
      return;
    }
    set({ link: 'checking', linkDetail: '' });
    const client = get().client();
    try {
      const health = await client.health();
      let capabilities: HermesCapabilities | null = null;
      try {
        capabilities = await client.capabilities();
      } catch (err) {
        Log.warn('hermes', `capabilities unavailable: ${(err as Error).message}`);
      }
      const transport = resolveTransport(config, capabilities);
      const degraded = !isHealthyStatus(health.status);
      set({ health, capabilities, transport, link: degraded ? 'degraded' : 'online', linkDetail: degraded ? describeHealth(health) : '' });
      Log.info('hermes', `connected (${transport})`, { status: health.status, model: capabilities?.model });
      void get().refreshCatalog();
      void get().refreshJobs();
      void get().refreshSessions();
    } catch (err) {
      const message = (err as Error).message;
      // The URL answers with a web page (portal, dashboard) or nothing: look for the API on the same host.
      if (!get().discovering && /page web|illisible|fetch failed|ECONNREFUSED|404/i.test(message)) {
        set({ discovering: true, linkDetail: 'recherche de l’API Hermes…' });
        try {
          const found = await discoverHermesUrl(config);
          if (found) {
            Log.info('hermes', `API found at ${found} (was ${config.url})`);
            useSettings.getState().update({ hermes: { url: found } });
            set({ discovering: false, linkDetail: `URL corrigée automatiquement : ${found}` });
            await get().connect();
            return;
          }
        } finally {
          set({ discovering: false });
        }
      }
      set({ link: 'offline', linkDetail: message, transport: resolveTransport(config, null) });
      Log.warn('hermes', `connection failed: ${message}`);
    }
    })().finally(() => {
      connectInflight = null;
    });
    return connectInflight;
  },

  refreshCatalog: async () => {
    const client = get().client();
    const [models, skills, toolsets] = await Promise.all([
      client.models().catch(() => [] as HermesModel[]),
      client.skills().catch(() => [] as HermesSkill[]),
      client.toolsets().catch(() => [] as HermesToolset[])
    ]);
    set({ models, skills, toolsets });
  },

  refreshSessions: async () => {
    try {
      const sessions = await get().client().listSessions();
      set({ sessions });
    } catch (err) {
      Log.debug('hermes', `sessions unavailable: ${(err as Error).message}`);
    }
  },

  refreshJobs: async () => {
    if (!useSettings.getState().settings.hermes.url.trim()) return;
    try {
      const jobs = await get().client().listJobs();
      const previous = get().jobRuns;
      const known = new Map(previous.map((r) => [r.id, r]));
      const incoming = jobs.map(runFromJob).filter((r): r is JobRun => !!r).map((r) => ({ ...r, read: known.get(r.id)?.read ?? false }));
      const merged = [...incoming, ...previous.filter((r) => !incoming.some((i) => i.id === r.id))]
        .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
        .slice(0, 100);
      set({ jobs, jobRuns: merged, jobsError: null, lastSyncAt: Date.now(), link: get().link === 'offline' ? 'online' : get().link });
      const snapshot = JSON.stringify({ jobs, jobRuns: merged });
      if (snapshot !== lastCacheSnapshot) {
        lastCacheSnapshot = snapshot;
        persistSet(CACHE_KEY, { jobs, jobRuns: merged, syncedAt: Date.now() });
      }
    } catch (err) {
      const message = (err as Error).message;
      Log.warn('hermes', `jobs sync failed: ${message}`);
      // The cron API can be absent or restricted on a given Hermes: the chat link is unaffected.
      set({ jobsError: /HTTP 404/.test(message) ? 'API des crons absente sur ce serveur Hermes' : message });
    }
  },

  refreshWebhook: async () => {
    const api = window.eveflow;
    if (!api) return;
    try {
      set({ webhook: await api.hermes.webhookStatus() });
    } catch {
      /* ignore */
    }
  },

  createJob: async (draft) => {
    set({ busy: true });
    try {
      await get().client().createJob(draft);
      await get().refreshJobs();
    } finally {
      set({ busy: false });
    }
  },
  updateJob: async (id, patch) => {
    set({ busy: true });
    try {
      await get().client().updateJob(id, patch);
      await get().refreshJobs();
    } finally {
      set({ busy: false });
    }
  },
  jobAction: async (id, action) => {
    set({ busy: true });
    const client = get().client();
    try {
      if (action === 'pause') await client.pauseJob(id);
      else if (action === 'resume') await client.resumeJob(id);
      else if (action === 'run') await client.runJob(id);
      else await client.deleteJob(id);
      await get().refreshJobs();
    } finally {
      set({ busy: false });
    }
  },
  markRunRead: (id) => {
    const jobRuns = get().jobRuns.map((r) => (r.id === id ? { ...r, read: true } : r));
    set({ jobRuns });
    persistSet(CACHE_KEY, { jobs: get().jobs, jobRuns, syncedAt: get().lastSyncAt });
  },
  loadCache: async () => {
    const cache = await persistGet<{ jobs?: HermesJob[]; jobRuns?: JobRun[]; syncedAt?: number }>(CACHE_KEY);
    if (cache) set({ jobs: cache.jobs ?? [], jobRuns: cache.jobRuns ?? [], lastSyncAt: cache.syncedAt ?? null });
  }
}));

export { jobStatus };

const HEALTHY = new Set(['ok', 'healthy', 'up', 'alive', 'pass', 'ready', 'running', 'online', 'true']);

/** Hermes /health reports "ok"; /health/detailed may report "healthy", "degraded" or "unhealthy". */
export function isHealthyStatus(status: unknown): boolean {
  if (status === undefined || status === null || status === '') return true;
  return HEALTHY.has(String(status).toLowerCase());
}

/** Human summary of a degraded health payload: failing checks by name. */
export function describeHealth(health: Record<string, unknown>): string {
  const failing: string[] = [];
  const visit = (node: unknown, prefix: string, depth: number) => {
    if (!node || typeof node !== 'object' || depth > 3) return;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === 'status') continue;
      if (value && typeof value === 'object') {
        const rec = value as Record<string, unknown>;
        const st = rec.status ?? rec.ok ?? rec.healthy;
        if (st !== undefined && !isHealthyStatus(st)) failing.push(prefix + key);
        else visit(value, `${prefix}${key}.`, depth + 1);
      } else if (typeof value === 'boolean' && !value && /ok|healthy|ready|connected|available/i.test(key)) failing.push(prefix + key);
    }
  };
  visit(health, '', 0);
  const base = `état ${String(health.status)}`;
  return failing.length ? `${base} · ${failing.slice(0, 4).join(', ')}` : base;
}
