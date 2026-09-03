import { ipcMain } from 'electron';
import os from 'node:os';
import { IPC, type SystemMetrics } from '../../shared/ipc';

interface CpuSnapshot {
  idle: number;
  total: number;
}

function snapshot(): CpuSnapshot {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    const t = cpu.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

let last = snapshot();

function cpuLoadPct(): number {
  const now = snapshot();
  const idleDiff = now.idle - last.idle;
  const totalDiff = now.total - last.total;
  last = now;
  if (totalDiff <= 0) return 0;
  return Math.max(0, Math.min(100, 100 * (1 - idleDiff / totalDiff)));
}

export function collectMetrics(): SystemMetrics {
  const cpus = os.cpus();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  return {
    hostname: os.hostname().toUpperCase(),
    platform: `${os.platform()} ${os.release()}`,
    cpuModel: cpus[0]?.model?.trim() ?? 'CPU',
    cpuCores: cpus.length,
    cpuLoad: Math.round(cpuLoadPct() * 10) / 10,
    cpuFreqMhz: cpus[0]?.speed ?? 0,
    memUsedPct: totalMem > 0 ? Math.round(((totalMem - freeMem) / totalMem) * 1000) / 10 : 0,
    memTotalGb: Math.round((totalMem / 1024 ** 3) * 10) / 10,
    uptimeSec: Math.round(os.uptime())
  };
}

export function registerTelemetryIpc(): void {
  ipcMain.handle(IPC.metrics, () => collectMetrics());
}
