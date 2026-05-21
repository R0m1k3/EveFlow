/**
 * PollingService — synchronizes Hermes /api/jobs for scheduled work.
 *
 * Hermes remains the source of truth. EveFlow polls as a client, keeps a local
 * display cache, and uses the same service for CRUD actions on remote jobs.
 */

import { LogService } from './logService';

export type HermesJobStatus =
  | 'pending'
  | 'scheduled'
  | 'paused'
  | 'running'
  | 'completed'
  | 'failed'
  | 'ok'
  | string;

export interface HermesJob {
  id: string;
  name?: string;
  prompt?: string;
  schedule?: string | { kind?: string; expr?: string; display?: string };
  status?: HermesJobStatus;
  state?: HermesJobStatus;
  enabled?: boolean;
  result?: string;
  output?: string;
  last_result?: string;
  last_output?: string;
  error?: string;
  last_error?: string;
  created_at?: string;
  updated_at?: string;
  next_run_at?: string;
  last_run_at?: string;
  completed_at?: string;
  last_status?: string;
  repeat?: { times?: number | null; completed?: number };
  skills?: string[];
  deliver?: string;
  provider?: string | null;
  model?: string | null;
  [key: string]: unknown;
}

export interface HermesJobDraft {
  name: string;
  schedule: string;
  prompt: string;
  deliver?: string;
}

export interface HermesSyncSnapshot {
  jobs: HermesJob[];
  syncedAt: string;
}

export type JobsSyncHandler = (snapshot: HermesSyncSnapshot) => void;
export type SyncStatusHandler = (status: 'syncing' | 'online' | 'offline', detail?: string) => void;

const normalizeBaseUrl = (hermesUrl: string): string => (
  hermesUrl.replace(/\/$/, '').replace(/\/v1(\/.*)?$/, '')
);

const parseJobsPayload = (payload: unknown): HermesJob[] => {
  if (Array.isArray(payload)) return payload as HermesJob[];
  if (payload && typeof payload === 'object') {
    const maybeJobs = (payload as { jobs?: unknown }).jobs;
    if (Array.isArray(maybeJobs)) return maybeJobs as HermesJob[];
  }
  return [];
};

export class PollingService {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private hermesUrl: string = '';
  private hermesApiKey: string = '';
  private onSync: JobsSyncHandler | null = null;
  private onStatus: SyncStatusHandler | null = null;
  private intervalMs: number;

  constructor(intervalMs: number = 30_000) {
    this.intervalMs = intervalMs;
  }

  public start(
    hermesUrl: string,
    apiKey: string,
    onSync: JobsSyncHandler,
    onStatus?: SyncStatusHandler
  ): void {
    this.stop();
    this.hermesUrl = hermesUrl;
    this.hermesApiKey = apiKey;
    this.onSync = onSync;
    this.onStatus = onStatus || null;

    LogService.info('PollingService', `Synchronisation Hermes jobs toutes les ${this.intervalMs / 1000}s`, { hermesUrl });

    this.sync();
    this.intervalId = setInterval(() => this.sync(), this.intervalMs);
  }

  public stop(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      LogService.info('PollingService', 'Synchronisation Hermes jobs arrêtée.');
    }
  }

  public get isActive(): boolean {
    return this.intervalId !== null;
  }

  public async refresh(): Promise<HermesSyncSnapshot> {
    return this.fetchJobs();
  }

  public async createJob(draft: HermesJobDraft): Promise<HermesJob> {
    return this.requestJob('', {
      method: 'POST',
      body: JSON.stringify({
        name: draft.name,
        schedule: draft.schedule,
        prompt: draft.prompt,
        ...(draft.deliver ? { deliver: draft.deliver } : {})
      })
    });
  }

  public async updateJob(jobId: string, patch: Partial<HermesJobDraft>): Promise<HermesJob> {
    return this.requestJob(`/${encodeURIComponent(jobId)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch)
    });
  }

  public async deleteJob(jobId: string): Promise<void> {
    await this.requestRaw(`/${encodeURIComponent(jobId)}`, { method: 'DELETE' });
  }

  public async pauseJob(jobId: string): Promise<HermesJob> {
    return this.requestJob(`/${encodeURIComponent(jobId)}/pause`, { method: 'POST' });
  }

  public async resumeJob(jobId: string): Promise<HermesJob> {
    return this.requestJob(`/${encodeURIComponent(jobId)}/resume`, { method: 'POST' });
  }

  public async runJob(jobId: string): Promise<HermesJob> {
    return this.requestJob(`/${encodeURIComponent(jobId)}/run`, { method: 'POST' });
  }

  private async sync(): Promise<void> {
    if (!this.hermesUrl || !this.onSync) return;

    try {
      this.onStatus?.('syncing');
      const snapshot = await this.fetchJobs();
      this.onSync(snapshot);
      this.onStatus?.('online');
    } catch (e: any) {
      const message = e?.message || String(e);
      LogService.warn('PollingService', `Synchronisation Hermes jobs impossible: ${message}`);
      this.onStatus?.('offline', message);
    }
  }

  private async fetchJobs(): Promise<HermesSyncSnapshot> {
    const payload = await this.requestRaw('');
    return {
      jobs: parseJobsPayload(payload),
      syncedAt: new Date().toISOString()
    };
  }

  private async requestJob(path: string, init: RequestInit): Promise<HermesJob> {
    const payload = await this.requestRaw(path, init);
    if (payload && typeof payload === 'object' && 'job' in payload) {
      return (payload as { job: HermesJob }).job;
    }
    return payload as HermesJob;
  }

  private async requestRaw(path: string, init: RequestInit = {}): Promise<unknown> {
    if (!this.hermesUrl) throw new Error('URL Hermes manquante');

    const base = normalizeBaseUrl(this.hermesUrl);
    const endpoint = `${base}/api/jobs${path}`;
    const abortCtrl = new AbortController();
    const timeoutId = setTimeout(() => abortCtrl.abort(), 12_000);

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (this.hermesApiKey) headers.Authorization = `Bearer ${this.hermesApiKey.trim()}`;

      const response = await fetch(endpoint, {
        ...init,
        headers: { ...headers, ...(init.headers || {}) },
        signal: abortCtrl.signal
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        const raw = await response.text().catch(() => '');
        throw new Error(`HTTP ${response.status}${raw ? `: ${raw.slice(0, 180)}` : ''}`);
      }

      if (response.status === 204) return null;
      const text = await response.text();
      return text ? JSON.parse(text) : null;
    } catch (e: any) {
      clearTimeout(timeoutId);
      if (e?.name === 'AbortError') throw new Error('Timeout Hermes /api/jobs');
      throw e;
    }
  }
}
