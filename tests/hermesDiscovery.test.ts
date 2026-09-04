import { describe, expect, it } from 'vitest';
import { describeHtml, hermesUrlCandidates, recoverCompletion } from '../src/services/hermes/client';

describe('describeHtml', () => {
  it('explains a login page instead of the API', () => {
    const msg = describeHtml('<!doctype html><html lang="fr-FR"><head><title>Jarvis – Se connecter</title></head><body>Mot de passe</body></html>');
    expect(msg).toContain('Jarvis – Se connecter');
    expect(msg).toContain('page de connexion');
    expect(msg).toContain('8642');
  });
  it('ignores JSON and SSE', () => {
    expect(describeHtml('{"status":"ok"}')).toBeNull();
    expect(describeHtml('data: {"choices":[]}')).toBeNull();
  });
  it('is used by recoverCompletion', () => {
    expect(recoverCompletion('<html><head><title>Portal</title></head></html>').error).toContain('Portal');
  });
});

describe('hermesUrlCandidates', () => {
  it('tries the API port, common paths and sibling hosts', () => {
    const c = hermesUrlCandidates('http://jarvis.vonrodbox.eu');
    expect(c).toContain('http://jarvis.vonrodbox.eu:8642');
    expect(c).toContain('http://jarvis.vonrodbox.eu/api');
    expect(c).toContain('http://api.jarvis.vonrodbox.eu');
    expect(c).toContain('http://hermes.vonrodbox.eu');
    expect(c).not.toContain('http://jarvis.vonrodbox.eu');
  });
  it('keeps an explicit port and handles garbage', () => {
    expect(hermesUrlCandidates('http://10.0.0.5:8642').some((u) => u.includes(':8642:'))).toBe(false);
    expect(hermesUrlCandidates('')).toEqual([]);
  });
});
