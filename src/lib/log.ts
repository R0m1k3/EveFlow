import type { LogEntry } from '../../shared/ipc';
import { bridge } from './bridge';

type Level = LogEntry['level'];

const MAX_CONSOLE = 1500;

function emit(level: Level, tag: string, message: string, data?: unknown): void {
  const entry: LogEntry = { ts: new Date().toISOString(), level, tag, message, data };
  const line = `[${tag}] ${message}`;
  const extra = data !== undefined ? safe(data) : '';
  if (level === 'ERROR') console.error(line, extra);
  else if (level === 'WARN') console.warn(line, extra);
  else if (level === 'DEBUG') console.debug(line, extra);
  else console.info(line, extra);
  try {
    bridge()?.log(entry);
  } catch {
    /* browser context */
  }
}

function safe(data: unknown): string {
  try {
    const text = JSON.stringify(data);
    return text.length > MAX_CONSOLE ? text.slice(0, MAX_CONSOLE) + '...' : text;
  } catch {
    return String(data);
  }
}

export const Log = {
  debug: (tag: string, message: string, data?: unknown) => emit('DEBUG', tag, message, data),
  info: (tag: string, message: string, data?: unknown) => emit('INFO', tag, message, data),
  warn: (tag: string, message: string, data?: unknown) => emit('WARN', tag, message, data),
  error: (tag: string, message: string, data?: unknown) => emit('ERROR', tag, message, data)
};
