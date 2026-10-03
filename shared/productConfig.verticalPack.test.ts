import { describe, expect, test } from 'bun:test';

import { distributionProductConfig, getDistributionVerticalPack } from './productConfig';

describe('distribution vertical pack', () => {
  test('the community profile ships no pack', () => {
    expect(distributionProductConfig.verticalPack).toBeUndefined();
    expect(getDistributionVerticalPack()).toBeNull();
  });

  test('a profile pack is read, but never from outside resources/', () => {
    const original = distributionProductConfig.verticalPack;
    try {
      distributionProductConfig.verticalPack = { id: 'droit', resourcePath: 'vertical-pack' };
      expect(getDistributionVerticalPack()).toEqual({ id: 'droit', resourcePath: 'vertical-pack' });
      for (const resourcePath of ['../outside', '/etc', 'a/../../b', '..\\outside']) {
        distributionProductConfig.verticalPack = { id: 'droit', resourcePath };
        expect(getDistributionVerticalPack()).toBeNull();
      }
      distributionProductConfig.verticalPack = { id: '', resourcePath: 'x' };
      expect(getDistributionVerticalPack()).toBeNull();
    } finally {
      distributionProductConfig.verticalPack = original;
    }
  });
});
