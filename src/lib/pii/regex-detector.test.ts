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

  test('detects a whole card, compact or American Express (4-6-5)', () => {
    // `phone`'s 3-3-4 fallback used to run first and take the leading digits,
    // leaving the rest of the number in clear.
    const cards = [
      '4111111111111111',
      '5555-5555-5555-4444',
      '3782 822463 10005',
      '3782-822463-10005',
      '378282246310005',
    ];
    for (const card of cards) {
      expect(detectRegex(`carte ${card} expire`).map((d) => [d.category, d.text])).toEqual([
        ['credit_card', card],
      ]);
    }
  });

  test('keeps a card and a French phone number apart', () => {
    expect(detectRegex('Tel 06 12 34 56 78 puis 4111 1111 1111 1111').map((d) => d.category))
      .toEqual(['phone', 'credit_card']);
  });

  test('detects an IBAN split by no-break spaces or a line break', () => {
    // French typography and PDF extraction produce these; each used to leave
    // part of the IBAN in clear (or label its middle as a card).
    const narrow = 'FR76\u202f1234\u202f5678\u202f9012\u202f3456\u202f7890\u202f104';
    const nbsp = 'FR76\u00a01234\u00a05678\u00a09012\u00a03456\u00a07890\u00a0104';
    const wrapped = 'FR76 1234 5678 9012\n  3456 7890 104';
    for (const iban of [narrow, nbsp, wrapped]) {
      expect(detectRegex(`IBAN : ${iban}.`).map((d) => [d.category, d.text])).toEqual([
        ['iban', iban],
      ]);
    }
  });

  test('detects a lowercase IBAN only when its checksum is valid', () => {
    expect(detectRegex('gb82 west 1234 5698 7654 32').map((d) => [d.category, d.text])).toEqual([
      ['iban', 'gb82 west 1234 5698 7654 32'],
    ]);
    // Ordinary words fit the shape but fail mod-97.
    expect(detectRegex('en10 mots dans cette phrase')).toEqual([]);
    // Uppercase keeps matching on shape alone: a mistyped IBAN is still hidden.
    expect(detectRegex('FR76 1234 5678 9012 3456 7890 105').map((d) => d.category)).toEqual(['iban']);
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

  test('detects a phone number with the trunk zero in parentheses', () => {
    // The plain E.164 form stops at the `(`, so these used to stay in clear.
    for (const phone of ['+33 (0)4 65 71 20 45', '+33(0)6 39 98 12 34', '+44 (0)20 7946 0958']) {
      expect(detectRegex(`tel ${phone} merci`).map((d) => [d.category, d.text])).toEqual([
        ['phone', phone],
      ]);
    }
  });

  test('detects phone numbers separated by no-break or narrow no-break spaces', () => {
    // French typography writes numbers this way; only ASCII separators matched.
    for (const space of ['\u00a0', '\u202f']) {
      const national = ['06', '39', '98', '12', '34'].join(space);
      const international = ['+33', '6', '39', '98', '12', '34'].join(space);
      for (const phone of [national, international]) {
        expect(detectRegex(`tel ${phone} merci`).map((d) => [d.category, d.text])).toEqual([
          ['phone', phone],
        ]);
      }
    }
  });

  test('detects full and compressed IPv6 addresses', () => {
    for (const address of [
      '2001:db8:85a3::8a2e:370:7334',
      '2001:0db8:85a3:0000:0000:8a2e:0370:7334',
      'fe80::1',
      '2001:db8::ff00:42:8329',
    ]) {
      expect(detectRegex(`host ${address}.`).map((d) => [d.category, d.text])).toEqual([
        ['ipv6', address],
      ]);
    }
    // Brackets and a port are not part of the address.
    expect(detectRegex('[2001:db8::1]:443').map((d) => d.text)).toEqual(['2001:db8::1']);
  });

  test('does not take code paths, times or MAC addresses for IPv6', () => {
    for (const text of [
      'std::vector', 'Foo::Bar', 'Dead::beef', 'a::b', '::1',
      'Heure 09:41:00', 'ratio 12:30', 'MAC 00:1a:2b:3c:4d:5e',
    ]) {
      expect(detectRegex(text)).toEqual([]);
    }
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

  test('scans a long run of numbers in linear time', () => {
    // A run of space-separated 3-digit groups with no currency used to be
    // rescanned from every group start (quadratic): 5 000 groups took seconds,
    // and detectRegex runs on every message, tool result and file.
    for (const text of ['123 '.repeat(8000) + 'fin', '1 234 '.repeat(5000), '12,345.'.repeat(5000)]) {
      const start = performance.now();
      const found = detectRegex(text);
      const elapsed = performance.now() - start;
      expect(found.filter((d) => d.category === 'amount')).toEqual([]);
      expect(elapsed).toBeLessThan(500);
    }
  });

  test('still detects an amount that closes a long run of numbers', () => {
    const found = detectRegex(`${'123 '.repeat(2000)}1 250 000 €`);
    expect(found.filter((d) => d.category === 'amount').map((d) => d.text)).toEqual(['1 250 000 €']);
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
