import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { LogEntry } from '../shared/ipc';

const MAX_LOG_BYTES = 5 * 1024 * 1024;

let stream: fs.WriteStream | null = null;
let written = 0;

export function getLogPath(): string {
  return path.join(app.getPath('userData'), 'eveflow.log');
}

function output(): fs.WriteStream {
  if (!stream) {
    const target = getLogPath();
    try {
      written = fs.statSync(target).size;
    } catch {
      written = 0;
    }
    stream = fs.createWriteStream(target, { flags: 'a' });
    stream.on('error', (err) => console.error('[logger] write failed:', err.message));
  }
  return stream;
}

function rotate(): void {
  const target = getLogPath();
  stream?.end();
  stream = null;
  try {
    fs.renameSync(target, `${target}.old`);
  } catch {
    /* ignore */
  }
  written = 0;
}

export function writeLog(entry: LogEntry): void {
  try {
    const data = entry.data !== undefined ? ' | ' + safeJson(entry.data) : '';
    const line = `[${entry.ts}] [${entry.level}] [${entry.tag}] ${entry.message}${data}\n`;
    written += Buffer.byteLength(line);
    if (written > MAX_LOG_BYTES) rotate();
    output().write(line);
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
