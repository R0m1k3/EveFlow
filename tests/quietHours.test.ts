import { describe, expect, it } from 'vitest';
import { isPriority, isQuietTime, summarize } from '../src/lib/quietHours';

const at = (h: number, m = 0) => new Date(2026, 0, 1, h, m);

describe('isQuietTime', () => {
  it('handles ranges crossing midnight', () => {
    expect(isQuietTime('22:30', '07:30', at(23))).toBe(true);
    expect(isQuietTime('22:30', '07:30', at(3, 15))).toBe(true);
    expect(isQuietTime('22:30', '07:30', at(7, 30))).toBe(false);
    expect(isQuietTime('22:30', '07:30', at(12))).toBe(false);
  });
  it('handles same-day ranges and invalid input', () => {
    expect(isQuietTime('13:00', '14:00', at(13, 30))).toBe(true);
    expect(isQuietTime('13:00', '14:00', at(14))).toBe(false);
    expect(isQuietTime('bad', '14:00', at(13))).toBe(false);
    expect(isQuietTime('10:00', '10:00', at(10))).toBe(false);
  });
});

describe('isPriority', () => {
  it('matches keywords in text or job name', () => {
    expect(isPriority('Serveur en panne depuis 5 min', 'urgent, panne')).toBe(true);
    expect(isPriority('Rapport quotidien', 'urgent', 'Alerte disque')).toBe(false);
    expect(isPriority('Rapport quotidien', 'alerte', 'Alerte disque')).toBe(true);
    expect(isPriority('x', '')).toBe(false);
  });
});

describe('summarize', () => {
  it('keeps the first sentences and strips markdown', () => {
    const text = '## Rapport\n\nTrois annonces **majeures** aujourd’hui. Le marché monte de 2 %. Détails ci-dessous :\n\n```\ncode\n```\n- point 1';
    expect(summarize(text, 2)).toBe('Rapport Trois annonces majeures aujourd’hui. Le marché monte de 2 %.');
    expect(summarize('Une seule phrase', 2)).toBe('Une seule phrase');
    expect(summarize('', 2)).toBe('');
  });
});
