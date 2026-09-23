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
