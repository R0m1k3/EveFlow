export interface SseMessage {
  event: string;
  data: string;
  id?: string;
}

/**
 * Incremental Server-Sent Events parser (spec-compliant subset: event/data/id/comments,
 * multi-line data joined with "\n", CRLF tolerant). Feed arbitrary text chunks.
 */
export class SseParser {
  private buffer = '';
  private event = '';
  private data: string[] = [];
  private id: string | undefined;

  constructor(private readonly onMessage: (message: SseMessage) => void) {}

  feed(chunk: string): void {
    this.buffer += chunk;
    let index: number;
    while ((index = this.buffer.search(/\r\n|\n|\r/)) !== -1) {
      const line = this.buffer.slice(0, index);
      const sepLength = this.buffer.startsWith('\r\n', index) ? 2 : 1;
      this.buffer = this.buffer.slice(index + sepLength);
      this.processLine(line);
    }
  }

  /** Flush any pending message (call when the stream ends). */
  end(): void {
    if (this.buffer.length) {
      const rest = this.buffer;
      this.buffer = '';
      this.processLine(rest);
    }
    this.dispatch();
  }

  private processLine(line: string): void {
    if (line === '') {
      this.dispatch();
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    switch (field) {
      case 'event': this.event = value; break;
      case 'data': this.data.push(value); break;
      case 'id': this.id = value; break;
      default: break;
    }
  }

  private dispatch(): void {
    if (this.data.length === 0 && !this.event) return;
    const message: SseMessage = { event: this.event || 'message', data: this.data.join('\n'), id: this.id };
    this.event = '';
    this.data = [];
    this.onMessage(message);
  }
}

export function tryParseJson<T = unknown>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}
