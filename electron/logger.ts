import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { LogEntry } from '../shared/ipc';

const MAX_LOG_BYTES = 5 * 1024 * 1024;

export function getLogPath(): string {
  return path.join(app.getPath('userData'), 'eveflow.log');
}

export function writeLog(entry: LogEntry): void {
  try {
    const logPath = getLogPath();
    const data = entry.data !== undefined ? ' | ' + safeJson(entry.data) : '';
    const line = `[${entry.ts}] [${entry.level}] [${entry.tag}] ${entry.message}${data}\n`;
    try {
      const stat = fs.statSync(logPath);
      if (stat.size > MAX_LOG_BYTES) fs.renameSync(logPath, logPath + '.old');
    } catch {
      /* first start: file does not exist yet */
    }
    fs.appendFileSync(logPath, line, 'utf8');
  } catch (err) {
    console.error('[logger] cannot write log file:', (err as Error).message);
  }
}

export function log(level: LogEntry['level'], tag: string, message: string, data?: unknown): void {
  const entry: LogEntry = { ts: new Date().toISOString(), level, tag, message, data };
  const consoleLine = `[${tag}] ${message}`;
  if (level === 'ERROR') console.error(consoleLine, data ?? '');
  else if (level === 'WARN') console.warn(consoleLine, data ?? '');
  else console.log(consoleLine, data ?? '');
  writeLog(entry);
}

function safeJson(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    return text.length > 4000 ? text.slice(0, 4000) + '...' : text;
  } catch {
    return String(value);
  }
}
