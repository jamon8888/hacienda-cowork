import { describe, expect, test } from 'bun:test';
import { adminRescanToolCall } from './basemindManager';

describe('adminRescanToolCall (pin 10cc546 contract)', () => {
  test('incremental rescan sends admin mode=rescan with paths', () => {
    expect(adminRescanToolCall({ paths: ['safe/foo.md'] })).toEqual({
      name: 'admin',
      arguments: { mode: 'rescan', paths: ['safe/foo.md'] },
    });
  });

  test('full rescan sends full:true and omits empty paths', () => {
    expect(adminRescanToolCall({ full: true })).toEqual({
      name: 'admin',
      arguments: { mode: 'rescan', full: true },
    });
  });

  test('never uses the fork-incompatible code/subcommand/files shape', () => {
    const call = adminRescanToolCall({ paths: ['safe'], full: false });
    expect(call.name).toBe('admin');
    expect(call.arguments).not.toHaveProperty('subcommand');
    expect(call.arguments.mode).toBe('rescan');
  });
});