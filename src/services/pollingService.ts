/**
 * PollingService — Periodically polls Hermes Agent /api/jobs endpoint
 * to receive proactive notifications from the AI (scheduled tasks, alerts).
 *
 * Runs as a background timer. Calls the provided callback whenever a
 * newly completed job is detected.
 */

import { LogService } from './logService';

export interface HermesJob {
  id: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  result?: string;
  created_at?: string;
  completed_at?: string;
}

export type JobHandler = (job: HermesJob) => void;

export class PollingService {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private seenJobIds: Set<string> = new Set();
  private hermesUrl: string = '';
  private hermesApiKey: string = '';
  private onJobCompleted: JobHandler | null = null;
  private intervalMs: number;

  constructor(intervalMs: number = 30_000) {
    this.intervalMs = intervalMs;
  }

  /**
   * Start polling Hermes Agent for completed jobs.
   *
   * @param hermesUrl   - Base URL of the Hermes server
   * @param apiKey      - Bearer token for authentication
   * @param onCompleted - Callback fired when a new completed job is detected
   */
  public start(hermesUrl: string, apiKey: string, onCompleted: JobHandler): void {
    this.stop(); // clear any existing interval
    this.hermesUrl = hermesUrl;
    this.hermesApiKey = apiKey;
    this.onJobCompleted = onCompleted;

    LogService.info('PollingService', `Démarrage polling Hermes toutes les ${this.intervalMs / 1000}s`, { hermesUrl });

    // Fire once immediately, then on interval
    this.poll();
    this.intervalId = setInterval(() => this.poll(), this.intervalMs);
  }

  /** Stop the polling loop. */
  public stop(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      LogService.info('PollingService', 'Polling Hermes arrêté.');
    }
  }

  /** Returns true if currently polling. */
  public get isActive(): boolean {
    return this.intervalId !== null;
  }

  private async poll(): Promise<void> {
    if (!this.hermesUrl || !this.onJobCompleted) return;

    const base = this.hermesUrl.replace(/\/$/, '').replace(/\/v1(\/.*)?$/, '');
    const endpoint = `${base}/api/jobs`;

    const abortCtrl = new AbortController();
    const timeoutId = setTimeout(() => abortCtrl.abort(), 10_000); // 10s max

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (this.hermesApiKey) headers['Authorization'] = `Bearer ${this.hermesApiKey.trim()}`;

      const response = await fetch(endpoint, { method: 'GET', headers, signal: abortCtrl.signal });
      clearTimeout(timeoutId);

      if (!response.ok) {
        LogService.warn('PollingService', `Erreur HTTP /api/jobs: ${response.status}`);
        return;
      }

      const payload = await response.json();
      const jobs: HermesJob[] = Array.isArray(payload)
        ? payload
        : Array.isArray(payload?.jobs)
          ? payload.jobs
          : [];

      if (!Array.isArray(jobs)) {
        LogService.warn('PollingService', 'Format /api/jobs inattendu', { preview: JSON.stringify(payload).slice(0, 200) });
        return;
      }

      for (const job of jobs) {
        if (job.status === 'completed' && job.id && !this.seenJobIds.has(job.id)) {
          this.seenJobIds.add(job.id);
          LogService.info('PollingService', `Nouveau job complété: ${job.id}`, { result: job.result?.slice(0, 200) });
          this.onJobCompleted(job);
        }
      }

      // Évite une fuite mémoire sur les sessions longues
      if (this.seenJobIds.size > 500) {
        const arr = [...this.seenJobIds];
        this.seenJobIds = new Set(arr.slice(-250));
      }
    } catch (e: any) {
      clearTimeout(timeoutId);
      if ((e as any).name === 'AbortError') {
        LogService.warn('PollingService', 'Poll timeout (10s) — serveur Hermes trop lent ou injoignable');
        return;
      }
      LogService.warn('PollingService', `Exception lors du poll: ${e.message}`);
    }
  }
}
