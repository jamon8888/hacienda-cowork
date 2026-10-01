import { describe, expect, test } from 'bun:test';

import { detectRegex } from './regex-detector';

describe('detectRegex', () => {
  test('detects IBANs, compact and space-grouped', () => {
    // `iban` has a colour, a token label and normalization tests, but no
    // pattern produced one, so the category could never fire. With NER
    // detection unavailable the regex pass is the only thing running.
    expect(detectRegex('Virement vers FR7630006000011234567890189 demain'))
      .toEqual([
        { category: 'iban', start: 14, end: 41, text: 'FR7630006000011234567890189', confidence: 1.0 },
      ]);

    const grouped = detectRegex('IBAN: DE89 3704 0044 0532 0130 00');
    expect(grouped).toHaveLength(1);
    expect(grouped[0].category).toBe('iban');
    expect(grouped[0].text).toBe('DE89 3704 0044 0532 0130 00');
  });

  test('does not report the digits inside an IBAN as a phone number', () => {
    // The IBAN pattern runs before the digit-based ones so their
    // alreadyCovered guards skip digits that belong to it.
    const found = detectRegex('FR7630006000011234567890189');
    expect(found.map((d) => d.category)).toEqual(['iban']);
  });

  test('keeps adjacent detections of different categories apart', () => {
    // The merge condition used to join anything within one character, so an
    // email followed by a space and a phone number collapsed into a single
    // email detection covering both — and rehydrated under one [EMAIL_n].
    const found = detectRegex('a@b.com 555-010-0200');
    expect(found.map((d) => [d.category, d.text])).toEqual([
      ['email', 'a@b.com'],
      ['phone', '555-010-0200'],
    ]);
  });

  test('still detects cards and IPv4 addresses', () => {
    expect(detectRegex('4111 1111 1111 1111')[0].category).toBe('credit_card');
    expect(detectRegex('host 192.168.1.10')[0].category).toBe('ipv4');
  });

  test('detects E.164 international numbers (FR +33, US +1)', () => {
    expect(detectRegex('call +33 6 12 34 56 78').map((d) => [d.category, d.text])).toEqual([
      ['phone', '+33 6 12 34 56 78'],
    ]);
    expect(detectRegex('call +1-800-555-1234').map((d) => [d.category, d.text])).toEqual([
      ['phone', '+1-800-555-1234'],
    ]);
    // National form still matches via the fallback branch.
    expect(detectRegex('call 0612345678')[0].category).toBe('phone');
  });

  test('detects French national numbers written in pairs', () => {
    // The everyday French form. With NER down (or cabinet mode off) this
    // pass is all that runs, and it let "06 12 34 56 78" reach the provider.
    const phones = (text: string) => detectRegex(text)
      .filter((d) => d.category === 'phone')
      .map((d) => d.text);
    expect(phones('Jean Dupont (Acme SAS) doit 125 000 € — 06 12 34 56 78. Résume en une phrase.'))
      .toEqual(['06 12 34 56 78']);
    expect(phones('tél. 06.12.34.56.78')).toEqual(['06.12.34.56.78']);
    expect(phones('tél. 01-23-45-67-89')).toEqual(['01-23-45-67-89']);
    expect(phones('standard : 09 70 80 90 00')).toEqual(['09 70 80 90 00']);
  });

  test('leaves amounts and dates alone', () => {
    const phones = (text: string) => detectRegex(text).filter((d) => d.category === 'phone');
    expect(phones('doit 125 000 € au 01.02.2024')).toEqual([]);
    expect(phones('échéance le 05 12 2024, soit 1 250 000 €')).toEqual([]);
    expect(phones('pièce 01/02/2024 n° 03 04 05')).toEqual([]);
  });

  test('detects money amounts in French and English notation', () => {
    // No NER label covers amounts, and "125 000 €" used to reach the provider.
    const amounts = (text: string) => detectRegex(text)
      .filter((d) => d.category === 'amount')
      .map((d) => d.text);
    expect(amounts('Dupont SARL doit 125 000 € à Maître Martin.')).toEqual(['125 000 €']);
    expect(amounts('soit 125000 EUR ou 125.000,00 €')).toEqual(['125000 EUR', '125.000,00 €']);
    expect(amounts('salaire de 48 500 euros brut')).toEqual(['48 500 euros']);
    expect(amounts('prix $1,250.50 ou £300')).toEqual(['$1,250.50', '£300']);
    expect(amounts('capital de 1,2 M€ et 800 k€')).toEqual(['1,2 M€', '800 k€']);
    // The narrow no-break spaces that French locale formatting emits.
    expect(amounts('total 1 250 000 €')).toEqual(['1 250 000 €']);
  });

  test('does not report bare numbers, dates or phone numbers as amounts', () => {
    const found = detectRegex('art. 1240 du code civil, le 01.02.2024, tél. 06 12 34 56 78, lot 125 000');
    expect(found.filter((d) => d.category === 'amount')).toEqual([]);
    expect(found.filter((d) => d.category === 'phone').map((d) => d.text)).toEqual(['06 12 34 56 78']);
  });

  test('keeps an amount and a phone number apart', () => {
    const found = detectRegex('Acme doit 125 000 € — 06 12 34 56 78');
    expect(found.map((d) => [d.category, d.text])).toEqual([
      ['amount', '125 000 €'],
      ['phone', '06 12 34 56 78'],
    ]);
  });

  test('handles large input without quadratic slowdown', () => {
    // ~100k chars with 500 emails and many phone-number-like strings. The old
    // per-pattern + alreadyCovered.some() implementation is O(n * matches)
    // for each pattern that has the alreadyCovered guard; this should finish
    // in under 1 second.
    const emails = Array.from({ length: 500 }, (_, i) => `user${i}@example.com`);
    // Phone-like strings that will hit the alreadyCovered scan
    const phones = Array.from({ length: 500 }, (_, i) => `555-010-${String(i).padStart(4, '0')}`);
    const filler = 'hello world '.repeat(2000);
    const parts = filler.split(' ');
    for (let i = 0; i < Math.max(emails.length, phones.length); i++) {
      if (i < emails.length) parts.splice(i * 8, 0, emails[i]);
      if (i < phones.length) parts.splice(i * 8 + 4, 0, phones[i]);
    }
    const text = parts.join(' ');

    const start = performance.now();
    const detections = detectRegex(text);
    const elapsed = performance.now() - start;

    expect(detections.length).toBeGreaterThan(500);
    // A loose regression guard, not a benchmark: a genuine O(n^2) revert at
    // this input size costs whole seconds, not milliseconds, so this ceiling
    // stays well clear of normal CI variance while still catching that class
    // of regression.
    expect(elapsed).toBeLessThan(5000);
  });
});
