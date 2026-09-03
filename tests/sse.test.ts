import { describe, expect, it } from 'vitest';
import { SseParser } from '../src/lib/sse';

describe('SseParser', () => {
  it('parses events split across chunks and multi-line data', () => {
    const got: Array<{ event: string; data: string }> = [];
    const p = new SseParser((m) => got.push({ event: m.event, data: m.data }));
    p.feed('event: hermes.tool.progress\ndata: {"a":');
    p.feed('1}\n\ndata: line1\r\ndata: line2\r\n\r\n: comment\n');
    p.feed('data: [DONE]');
    p.end();
    expect(got).toEqual([
      { event: 'hermes.tool.progress', data: '{"a":1}' },
      { event: 'message', data: 'line1\nline2' },
      { event: 'message', data: '[DONE]' }
    ]);
  });
});
