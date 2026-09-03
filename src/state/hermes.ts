import { create } from 'zustand';
import type { WebhookStatus } from '../../shared/ipc';
import { Log } from '../lib/log';
import { persistGet, persistSet } from '../lib/persist';
import { HermesClient, jobOutput, jobStatus, resolveTransport, type ResolvedTransport } from '../services/hermes/client';
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
  transport: ResolvedTransport;
  lastSyncAt: number | null;
  webhook: WebhookStatus | null;
  busy: boolean;

  client: () => HermesClient;
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
  transport: 'completions',
  lastSyncAt: null,
  webhook: null,
  busy: false,

  client: () => {
    const config = useSettings.getState().settings.hermes;
    // Without an explicit model, use the alias advertised by /v1/models (Hermes rejects unknown names).
    const model = config.model.trim() || get().models[0]?.id || '';
    return new HermesClient({ ...config, model });
  },

  connect: async () => {
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
      const degraded = String(health.status ?? 'ok').toLowerCase() !== 'ok';
      set({ health, capabilities, transport, link: degraded ? 'degraded' : 'online', linkDetail: degraded ? `état ${health.status}` : '' });
      Log.info('hermes', `connected (${transport})`, { status: health.status, model: capabilities?.model });
      void get().refreshCatalog();
      void get().refreshJobs();
      void get().refreshSessions();
    } catch (err) {
      const message = (err as Error).message;
      set({ link: 'offline', linkDetail: message, transport: resolveTransport(config, null) });
      Log.warn('hermes', `connection failed: ${message}`);
    }
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
      set({ jobs, jobRuns: merged, lastSyncAt: Date.now(), link: get().link === 'offline' ? 'online' : get().link });
      persistSet(CACHE_KEY, { jobs, jobRuns: merged, syncedAt: Date.now() });
    } catch (err) {
      const message = (err as Error).message;
      Log.warn('hermes', `jobs sync failed: ${message}`);
      if (/HTTP 404/.test(message)) return; // jobs API disabled on this server
      set({ link: 'offline', linkDetail: message });
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
