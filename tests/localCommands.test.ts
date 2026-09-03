import { describe, expect, it } from 'vitest';
import { parseLocalIntent } from '../src/services/localCommands';

describe('parseLocalIntent', () => {
  it('recognises system actions in French and English', () => {
    expect(parseLocalIntent('Jarvis, verrouille la session')?.action).toEqual({ type: 'lock' });
    expect(parseLocalIntent('monte le son')?.action).toEqual({ type: 'media', key: 'volume-up' });
    expect(parseLocalIntent('Baisse le volume')?.action).toEqual({ type: 'media', key: 'volume-down' });
    expect(parseLocalIntent('coupe le son')?.action).toEqual({ type: 'media', key: 'mute' });
    expect(parseLocalIntent('piste suivante')?.action).toEqual({ type: 'media', key: 'next' });
    expect(parseLocalIntent('ouvre le bloc-notes')?.action).toEqual({ type: 'open-app', name: 'bloc-notes' });
    expect(parseLocalIntent('open spotify')?.action).toEqual({ type: 'open-app', name: 'spotify' });
    expect(parseLocalIntent('ouvre github.com')?.action).toEqual({ type: 'open-url', url: 'https://github.com' });
  });
  it('detects screen questions', () => {
    expect(parseLocalIntent('Jarvis, regarde mon écran et dis-moi ce que tu vois')?.kind).toBe('screenshot');
    expect(parseLocalIntent('fais une capture d’écran')?.kind).toBe('screenshot');
  });
  it('leaves everything else to Hermes', () => {
    expect(parseLocalIntent('Quelle est la météo à Paris demain ?')).toBeNull();
    expect(parseLocalIntent('ouvre le fichier puis envoie-le à Marc')).toBeNull();
    expect(parseLocalIntent('')).toBeNull();
  });
});
