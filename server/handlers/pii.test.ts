import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { addCustomTerm, getRehydrationMap, rememberRehydration } from './pii';
import {
  clearRuntimeRehydrationMaps,
  getRuntimeRehydrationMap,
  mergeRuntimeRehydrationMap,
} from '../services/runtimeRedaction';
import { persistThreadRehydrationMap } from '../services/rehydrationPersistence';
import { resolveVaultBlobPath } from '../services/vault';
import { setCurrentWorkspace } from '../utils/workspace';
import {
  CUSTOM_TERMS_DOC_ID,
  listCustomTerms,
  resetCustomTermsCacheForTests,
} from '../services/customTerms';

// Vault MCP is a round trip; the double stands in so these tests exercise the
// handler contract, not basemind.
const encryptingVault = {
  async callTool(_serverId: string, _toolName: string, args: Record<string, any>): Promise<unknown> {
    if (args.mode === 'decrypt') {
      const map = JSON.parse(Buffer.from(args.encrypted_blob, 'base64').toString('utf8'));
      return { structuredContent: { result: { map } } };
    }
    return {
      structuredContent: {
        result: {
          encrypted_blob: Buffer.from(JSON.stringify(args.map), 'utf8').toString('base64'),
        },
      },
    };
  },
};

const dirs: string[] = [];
const workspaces: string[] = [];

function useTempUserData(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pii-handler-user-'));
  dirs.push(dir);
  process.env.INTERPRETER_USER_DATA_DIR = dir;
  return dir;
}

function useTempWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pii-handler-ws-'));
  workspaces.push(dir);
  setCurrentWorkspace(dir);
  return dir;
}

afterEach(() => {
  clearRuntimeRehydrationMaps();
  resetCustomTermsCacheForTests();
  delete process.env.INTERPRETER_USER_DATA_DIR;
  setCurrentWorkspace(null);
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  for (const dir of workspaces.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('pii.getRehydrationMap', () => {
  test('merges the in-memory session map with the persisted vault blob', async () => {
    useTempUserData();
    await persistThreadRehydrationMap(
      'thread-reveal',
      { '[EMAIL_0]': 'persisted@example.com' },
      { passphrase: 'p', toolManager: encryptingVault },
    );
    mergeRuntimeRehydrationMap('thread-reveal', { '[PHONE_0]': '+33123456789' });

    const map = await getRehydrationMap(
      { threadKey: 'thread-reveal' },
      { toolManager: encryptingVault, passphrase: 'p' },
    );

    expect(map).toEqual({
      '[EMAIL_0]': 'persisted@example.com',
      '[PHONE_0]': '+33123456789',
    });
  });

  test('returns the session map when no vault blob exists', async () => {
    useTempUserData();
    mergeRuntimeRehydrationMap('thread-session-only', { '[NAME_0]': 'Ada Lovelace' });

    const map = await getRehydrationMap(
      { threadKey: 'thread-session-only' },
      { toolManager: encryptingVault, passphrase: 'p' },
    );

    expect(map).toEqual({ '[NAME_0]': 'Ada Lovelace' });
  });

  test('returns an empty map for an unknown thread', async () => {
    useTempUserData();
    const map = await getRehydrationMap(
      { threadKey: 'thread-unknown' },
      { toolManager: encryptingVault, passphrase: 'p' },
    );
    expect(map).toEqual({});
  });
});

describe('pii.rememberRehydration', () => {
  test('persists to the vault and merges into the session store', async () => {
    useTempUserData();

    const result = await rememberRehydration(
      { threadKey: 'noteabc123', map: { '[NAME_0]': 'Ada Lovelace' } },
      { toolManager: encryptingVault, passphrase: 'p' },
    );

    expect(result.success).toBe(true);
    expect(getRuntimeRehydrationMap('noteabc123')).toEqual({ '[NAME_0]': 'Ada Lovelace' });
  });

  test('reports failure when the vault cannot store the original', async () => {
    useTempUserData();

    // No passphrase and no OS credential store in tests: the vault write fails.
    const result = await rememberRehydration({
      threadKey: 'noteabc456',
      map: { '[NAME_0]': 'Ada Lovelace' },
    });

    expect(result.success).toBe(false);
    // The session copy still lets this run reveal the value.
    expect(getRuntimeRehydrationMap('noteabc456')).toEqual({ '[NAME_0]': 'Ada Lovelace' });
  });

  test('throws when threadKey is missing', async () => {
    await expect(rememberRehydration({ threadKey: '', map: {} })).rejects.toThrow(/threadKey/);
  });
});

describe('pii.addCustomTerm', () => {
  const vaultDeps = { toolManager: encryptingVault, passphrase: 'p' };

  test('stores the term encrypted in the vault, never in the workspace', async () => {
    const userData = useTempUserData();
    const workspace = useTempWorkspace();

    const result = await addCustomTerm({ label: 'Client', value: 'Project Hacienda' }, vaultDeps);

    expect(result).toEqual({ success: true });
    expect(fs.existsSync(path.join(workspace, 'basemind.toml'))).toBe(false);
    const blobPath = resolveVaultBlobPath(CUSTOM_TERMS_DOC_ID, userData);
    expect(fs.existsSync(blobPath)).toBe(true);
    resetCustomTermsCacheForTests();
    expect(await listCustomTerms(vaultDeps)).toEqual([{ label: 'Client', value: 'Project Hacienda' }]);
  });

  test('keeps earlier terms and does not duplicate a pinned value', async () => {
    useTempUserData();
    useTempWorkspace();

    await addCustomTerm({ label: 'Client', value: 'Already Here' }, vaultDeps);
    await addCustomTerm({ label: 'Client', value: 'Already Here' }, vaultDeps);
    await addCustomTerm({ label: 'Name', value: 'New Term' }, vaultDeps);

    resetCustomTermsCacheForTests();
    expect(await listCustomTerms(vaultDeps)).toEqual([
      { label: 'Client', value: 'Already Here' },
      { label: 'Name', value: 'New Term' },
    ]);
  });

  test('terms are scoped to the workspace they were pinned in', async () => {
    useTempUserData();
    useTempWorkspace();
    await addCustomTerm({ label: 'Client', value: 'Only Here' }, vaultDeps);

    useTempWorkspace();
    resetCustomTermsCacheForTests();
    expect(await listCustomTerms(vaultDeps)).toEqual([]);
  });

  test('listCustomTerms throws when the stored terms cannot be read', async () => {
    useTempUserData();
    useTempWorkspace();
    await addCustomTerm({ label: 'Client', value: 'Secret Corp' }, vaultDeps);
    resetCustomTermsCacheForTests();
    const unreadable = {
      async callTool(): Promise<unknown> {
        throw new Error('vault tool unavailable');
      },
    };

    await expect(listCustomTerms({ toolManager: unreadable, passphrase: 'p' })).rejects.toThrow(/vault tool/);
  });

  test('throws when no workspace is open', async () => {
    useTempUserData();
    setCurrentWorkspace(null);
    await expect(addCustomTerm({ label: 'Custom', value: 'x' }, vaultDeps)).rejects.toThrow(/workspace/i);
  });
});
