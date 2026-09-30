import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { adminRescanToolCall, ensureBasemindForWorkspace } from './basemindManager';

describe('adminRescanToolCall (pinned admin rescan contract)', () => {
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
describe('ensureBasemindForWorkspace', () => {
  function fakes() {
    const calls: string[] = [];
    return {
      calls,
      deps: {
        register: async () => { calls.push('register'); return 'basemind'; },
        ensureConfig: async (serverId: string) => { calls.push(`ensure:${serverId}`); },
      },
    };
  }

  test('registers basemind when the workspace is already Safe', async () => {
    // A Safe folder opened on a fresh install (or after the server was
    // removed) had no detector: in cabinet mode every send was refused.
    const ws = mkdtempSync(join(tmpdir(), 'bm-armed-'));
    mkdirSync(join(ws, 'safe'));
    try {
      const { calls, deps } = fakes();
      await ensureBasemindForWorkspace(ws, deps);
      expect(calls).toEqual(['register']);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test('never starts basemind for a workspace that is not Safe', async () => {
    // Spec §8: nothing runs before the opt-in. An existing registration is
    // only re-pointed at the new root, as before.
    const ws = mkdtempSync(join(tmpdir(), 'bm-plain-'));
    try {
      const { calls, deps } = fakes();
      await ensureBasemindForWorkspace(ws, deps);
      expect(calls).toEqual(['ensure:basemind']);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test('does nothing without a workspace', async () => {
    const { calls, deps } = fakes();
    await ensureBasemindForWorkspace(null, deps);
    expect(calls).toEqual([]);
  });
});
