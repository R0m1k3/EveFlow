import { useEffect, useState } from 'react';
import type { SystemMetrics } from '../../shared/ipc';
import { bridge } from '../lib/bridge';

export interface LiveMetrics extends SystemMetrics {
  fps: number;
  /** false until the main process delivered real measurements */
  live: boolean;
}

const EMPTY: LiveMetrics = {
  hostname: 'LOCALHOST',
  platform: navigator.platform,
  cpuModel: '',
  cpuCores: navigator.hardwareConcurrency || 0,
  cpuLoad: 0,
  cpuFreqMhz: 0,
  memUsedPct: 0,
  memTotalGb: 0,
  uptimeSec: 0,
  fps: 60,
  live: false
};

export function useMetrics(enabled = true, intervalMs = 2000): LiveMetrics {
  const [metrics, setMetrics] = useState<LiveMetrics>(EMPTY);

  useEffect(() => {
    if (!enabled) return;
    let frames = 0;
    let lastFpsTick = performance.now();
    let raf = 0;
    const loop = () => {
      frames++;
      const now = performance.now();
      if (now - lastFpsTick >= 1000) {
        const fps = Math.round((frames * 1000) / (now - lastFpsTick));
        frames = 0;
        lastFpsTick = now;
        setMetrics((m) => (m.fps === fps ? m : { ...m, fps }));
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    const api = bridge();
    const poll = () => {
      if (!api) return;
      api.system.metrics().then((m) => setMetrics((prev) => ({ ...prev, ...m, live: true }))).catch(() => undefined);
    };
    poll();
    const timer = setInterval(poll, intervalMs);
    return () => {
      cancelAnimationFrame(raf);
      clearInterval(timer);
    };
  }, [enabled, intervalMs]);

  return metrics;
}

export function useClock(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 15_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}
