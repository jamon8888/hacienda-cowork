import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';

import { resources, supportedLanguages } from '../index';

// The Safe banner renders raw keys when one is missing from a locale, and it
// states a download size the preseed must actually match: the NER model
// (fastino GLiNER2, ~1.24 GB) plus the reranker (~358 MB) is ~1.6 GB, not 543.
const banner = readFileSync(new URL('../../../src/components/layout/SafeBanner.tsx', import.meta.url), 'utf8');
const usedKeys = Array.from(new Set(Array.from(banner.matchAll(/\bt\(\s*'(basemind\.banner\.[A-Za-z]+)'/g), (m) => m[1]!)));

describe('Safe banner copy', () => {
  test('the banner uses translation keys', () => {
    expect(usedKeys.length).toBeGreaterThan(5);
  });

  for (const lang of supportedLanguages) {
    const strings = resources[lang as keyof typeof resources].translation as Record<string, string>;

    test(`${lang}: every key the banner uses exists`, () => {
      const missing = usedKeys.filter(
        (key) => !(key in strings) && !(`${key}_one` in strings) && !(`${key}_other` in strings),
      );
      expect(missing).toEqual([]);
    });

    test(`${lang}: the announced download size matches the preseed (~1.6 GB)`, () => {
      const cost = strings['basemind.banner.cost'];
      expect(cost).not.toContain('543');
      expect(cost).toMatch(/1[.,]6/);
    });
  }
});
