import { describe, expect, test } from 'bun:test';

import { resolveScanPaths } from './workspaceScan';

describe('resolveScanPaths (#13/#18 code-indexing opt-in)', () => {
  test('forces the safe/ mirror corpus when indexing is off (default)', () => {
    expect(resolveScanPaths(['src'], false)).toEqual(['safe']);
    expect(resolveScanPaths(['src', 'docs'], false)).toEqual(['safe']);
    expect(resolveScanPaths(undefined, false)).toEqual(['safe']);
  });

  test('honors requested paths only when the code-indexing opt-in is on', () => {
    expect(resolveScanPaths(['src'], true)).toEqual(['src']);
    expect(resolveScanPaths(['src', 'docs'], true)).toEqual(['src', 'docs']);
    expect(resolveScanPaths(undefined, true)).toEqual(['safe']);
  });
});
