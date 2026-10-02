import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { setConfigOverride } from '../configStore';
import { setToolManager } from '../tools/toolManagerAccessor';
import { adminRescanToolCall, ensureBasemindForWorkspace, registerBasemindServer } from './basemindManager';

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
        ensureMirrors: async () => { calls.push('mirrors'); },
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
      // Mirrors written before the workspace token registry are renumbered.
      expect(calls).toEqual(['register', 'mirrors']);
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

describe('registerBasemindServer when the runtime is slow', () => {
  // At startup the MCP runtime can take longer than addServer's 12 s status
  // read. Registration then gave up silently: the existing server never got
  // its auto-approval and start-up timeout, or nothing was registered at all.
  const timeout = new Error('MCP server status list timed out after 12000ms (requestId=1)');
  const updates: Array<{ id: string; updates: Record<string, unknown> }> = [];

  function fakeToolManager() {
    updates.length = 0;
    setToolManager({
      addServer: async () => { throw timeout; },
      updateServer: async (id: string, patch: Record<string, unknown>) => { updates.push({ id, updates: patch }); },
    } as any);
  }

  afterEach(() => setConfigOverride(null));

  test('still applies the config when the server is already on file', async () => {
    setConfigOverride({ mcpServers: { basemind: { name: 'Basemind', transport: 'stdio', command: '/bin/basemind', args: [], tools: {} } } } as any);
    fakeToolManager();
    expect(await registerBasemindServer({ resolveBinary: () => '/bin/basemind' })).toBe('basemind');
    const tools = updates.find((u) => u.id === 'basemind')?.updates.tools as Record<string, { approvalMode: string }>;
    expect(tools.redact_text.approvalMode).toBe('auto');
  });

  test('says so when nothing could be registered', async () => {
    setConfigOverride({ mcpServers: {} } as any);
    fakeToolManager();
    const warned = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await registerBasemindServer({ resolveBinary: () => '/bin/basemind' })).toBe('');
      expect(warned.mock.calls.some((args) => String(args[0]).includes('basemind'))).toBe(true);
    } finally {
      warned.mockRestore();
    }
  });
});
