/**
 * LogService — Centralized structured logger for EveFlow.
 *
 * In Electron (production/dev): sends log entries via window.electronAPI.log()
 * which the main process writes to %APPDATA%/EveFlow/eveflow.log
 *
 * Fallback (browser only): console only.
 */

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

export interface LogEntry {
  ts: string;        // ISO timestamp
  level: LogLevel;
  tag: string;       // Component / service tag (e.g. "HermesAgent", "Minimax")
  message: string;
  data?: unknown;    // Any extra serializable payload
}

export class LogService {
  private static readonly MAX_CONSOLE_DATA_LEN = 2000;

  // Core write method
  public static log(level: LogLevel, tag: string, message: string, data?: unknown): void {
    const entry: LogEntry = {
      ts: new Date().toISOString(),
      level,
      tag,
      message,
      data
    };

    // Always write to console for DevTools visibility
    const consoleMsg = `[${entry.ts}] [${level}] [${tag}] ${message}`;
    const dataStr = data !== undefined ? JSON.stringify(data, null, 2) : '';

    switch (level) {
      case 'ERROR': console.error(consoleMsg, dataStr ? dataStr.slice(0, this.MAX_CONSOLE_DATA_LEN) : ''); break;
      case 'WARN':  console.warn(consoleMsg, dataStr ? dataStr.slice(0, this.MAX_CONSOLE_DATA_LEN) : ''); break;
      case 'DEBUG': console.debug(consoleMsg, dataStr ? dataStr.slice(0, this.MAX_CONSOLE_DATA_LEN) : ''); break;
      default:      console.info(consoleMsg, dataStr ? dataStr.slice(0, this.MAX_CONSOLE_DATA_LEN) : ''); break;
    }

    // Send to Electron main process for file persistence
    try {
      const electronAPI = (window as any).electronAPI;
      if (electronAPI?.writeLog) {
        electronAPI.writeLog(entry);
      }
    } catch {
      // Silently ignore: browser context has no electronAPI
    }
  }

  public static debug(tag: string, message: string, data?: unknown): void {
    this.log('DEBUG', tag, message, data);
  }

  public static info(tag: string, message: string, data?: unknown): void {
    this.log('INFO', tag, message, data);
  }

  public static warn(tag: string, message: string, data?: unknown): void {
    this.log('WARN', tag, message, data);
  }

  public static error(tag: string, message: string, data?: unknown): void {
    this.log('ERROR', tag, message, data);
  }
}
