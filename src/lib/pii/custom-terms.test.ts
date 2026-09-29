import { describe, expect, test } from 'bun:test';

import { customTermCategory, detectCustomTerms } from './custom-terms';

describe('detectCustomTerms', () => {
  test('matches every occurrence case-insensitively', () => {
    const detections = detectCustomTerms('ACME paie Acme', [{ label: 'Client', value: 'acme' }]);
    expect(detections.map((d) => [d.start, d.end, d.text])).toEqual([[0, 4, 'ACME'], [10, 14, 'Acme']]);
  });

  test('treats regex metacharacters in a term literally', () => {
    expect(detectCustomTerms('prix: 3.5 (net)', [{ label: 'X', value: '3.5 (net)' }])).toHaveLength(1);
    expect(detectCustomTerms('prix: 3x5', [{ label: 'X', value: '3.5' }])).toHaveLength(0);
  });

  test('ignores blank terms', () => {
    expect(detectCustomTerms('anything', [{ label: 'X', value: '  ' }])).toEqual([]);
  });
});

describe('customTermCategory', () => {
  test('maps a palette label or key back to its category', () => {
    expect(customTermCategory('Name')).toBe('person_full_name');
    expect(customTermCategory('email')).toBe('email');
  });

  test('makes free-text labels token-safe', () => {
    expect(customTermCategory('Client VIP')).toBe('client_vip');
    expect(customTermCategory('42 Corp')).toBe('custom_42_corp');
    expect(customTermCategory('  ')).toBe('custom');
  });
});
