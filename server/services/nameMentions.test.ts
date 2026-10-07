import { describe, expect, test } from 'bun:test';

import { collectNameValues, propagateNames } from './nameMentions';
import type { PiiDetection } from '../../src/lib/pii/regex-detector';

const det = (text: string, category: string, source: string, confidence = 0.9): PiiDetection => {
  const start = source.indexOf(text);
  return { category, start, end: start + text.length, text, confidence };
};

describe('collectNameValues', () => {
  test('keeps person-name categories, longest first, one entry per value whatever its case', () => {
    const source = 'Étienne Dubreuil et Dubreuil et dubreuil chez Acme, hdubreuil78';
    const names = collectNameValues([[
      det('Dubreuil', 'last_name', source),
      det('Étienne Dubreuil', 'full_name', source),
      { category: 'last_name', start: 0, end: 8, text: 'dubreuil', confidence: 0.7 },
      det('Acme', 'organization', source),
      det('hdubreuil78', 'username', source),
    ]]);
    expect(names).toEqual([
      { value: 'Étienne Dubreuil', category: 'full_name' },
      { value: 'Dubreuil', category: 'last_name' },
    ]);
  });

  test('drops values too short to be safe or with no letter in them', () => {
    const source = 'Li et 12345 et Jo et Bob';
    const names = collectNameValues([[
      det('Li', 'last_name', source),
      det('12345', 'person', source),
      det('Jo', 'first_name', source),
      det('Bob', 'first_name', source),
    ]]);
    expect(names.map((n) => n.value)).toEqual(['Bob']);
  });

  test('gathers values from every text of the batch', () => {
    const names = collectNameValues([
      [det('Dubreuil', 'last_name', 'Dubreuil')],
      [det('Garnier', 'last_name', 'Garnier')],
    ]);
    expect(names.map((n) => n.value).sort()).toEqual(['Dubreuil', 'Garnier']);
  });
});

describe('propagateNames', () => {
  const dubreuil = [{ value: 'Dubreuil', category: 'last_name' }];

  test('masks the other mentions: bare name, file name, URL path', () => {
    const text = "Mme Dubreuil est d'accord. Dubreuil_Hélène_contrat_2022.pdf — https://x.example/clients/dubreuil/helene";
    const out = propagateNames(text, [], dubreuil);
    expect(out.map((d) => text.slice(d.start, d.end))).toEqual(['Dubreuil', 'Dubreuil', 'dubreuil']);
    expect(out.every((d) => d.category === 'last_name')).toBe(true);
  });

  test('never matches inside a longer word', () => {
    const text = 'Dubreuilles, xDubreuil, Dubreuil2, mais aussi Dubreuil.';
    const out = propagateNames(text, [], dubreuil);
    expect(out).toHaveLength(1);
    expect(text.slice(out[0].start, out[0].end)).toBe('Dubreuil');
    expect(out[0].start).toBe(text.lastIndexOf('Dubreuil'));
  });

  test('leaves alone a span another detection already covers', () => {
    const text = 'Écrire à helene.dubreuil@exemple.example ou à Mme Dubreuil';
    const existing = [det('helene.dubreuil@exemple.example', 'email', text)];
    const out = propagateNames(text, existing, dubreuil);
    expect(out).toHaveLength(2);
    expect(out[0]).toBe(existing[0]);
    expect(text.slice(out[1].start, out[1].end)).toBe('Dubreuil');
    expect(out[1].start).toBeGreaterThan(existing[0].end);
  });

  test('the longest value wins where two values cover the same place', () => {
    const text = 'Mme Dubreuil signe';
    const out = propagateNames(text, [], [
      { value: 'Mme Dubreuil', category: 'full_name' },
      { value: 'Dubreuil', category: 'last_name' },
    ]);
    expect(out).toHaveLength(1);
    expect(text.slice(out[0].start, out[0].end)).toBe('Mme Dubreuil');
  });

  test('returns the detections sorted, with the text of each span', () => {
    const text = 'Dubreuil puis Garnier puis Dubreuil';
    const out = propagateNames(text, [det('Garnier', 'last_name', text)], dubreuil);
    expect(out.map((d) => d.start)).toEqual([...out.map((d) => d.start)].sort((a, b) => a - b));
    expect(out.map((d) => d.text)).toEqual(['Dubreuil', 'Garnier', 'Dubreuil']);
  });

  test('does nothing when no name was detected', () => {
    const existing = [det('x@y.example', 'email', 'x@y.example')];
    expect(propagateNames('Dubreuil', existing, [])).toBe(existing);
  });
});
