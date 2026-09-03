import { describe, expect, it } from 'vitest';
import { normalizeHermesPush } from '../shared/hermesPush';

describe('normalizeHermesPush', () => {
  it('handles run.completed with input/output', () => {
    const events = normalizeHermesPush({ event: 'run.completed', input: 'hi', output: 'hello', platform: 'telegram' });
    expect(events.map((e) => [e.role, e.text, e.source])).toEqual([['user', 'hi', 'telegram'], ['assistant', 'hello', 'telegram']]);
  });
  it('handles cron job payloads and images', () => {
    const [e] = normalizeHermesPush({ event: 'job.completed', job: { name: 'Daily', last_status: 'ok' }, output: 'report', images: ['https://a/b.png'] });
    expect(e.type).toBe('job');
    expect(e.jobName).toBe('Daily');
    expect(e.images).toEqual(['https://a/b.png']);
  });
  it('handles direct and legacy shapes', () => {
    expect(normalizeHermesPush({ role: 'user', text: 'x' })[0].role).toBe('user');
    expect(normalizeHermesPush({ type: 'assistant_message', text: 'y' })[0].role).toBe('assistant');
    expect(normalizeHermesPush({ foo: 1 })[0].type).toBe('raw');
  });
});
